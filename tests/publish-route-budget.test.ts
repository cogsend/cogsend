import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { SubrequestBudget } from '#lib/server/budget.js';
import { encryptJson } from '#lib/server/crypto.js';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { connections, drafts, publishTargets, users } from '#lib/server/db/schema.js';
import { createTestDb, createTestMedia, TEST_ENV } from '#lib/server/db/test.js';
import { POST as publishPOST } from '../src/routes/api/drafts/[id]/publish/+server';

describe('POST /api/drafts/[id]/publish within a call budget', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;
	let draftId: string;
	const conns: string[] = [];

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'budget-route@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
		draftId = newId();
		await db.insert(drafts).values({
			id: draftId,
			userId,
			baseBody: 'two accounts, one budget',
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
		for (const name of ['one', 'two']) {
			const id = newId();
			conns.push(id);
			await db.insert(connections).values({
				id,
				userId,
				platform: 'mastodon',
				handle: `${name}@mastodon.invalid`,
				instanceUrl: 'https://mastodon.invalid',
				credentialsEncrypted: await encryptJson(
					{ accessToken: 'token', instanceUrl: 'https://mastodon.invalid' },
					TEST_ENV.APP_ENCRYPTION_KEY
				),
				metaJson: JSON.stringify({ maxCharacters: 500 }),
				status: 'active',
				createdAt: now,
				updatedAt: now
			});
		}
	});
	afterAll(() => close());

	it('starts the first account and leaves the rest due for the scheduler', async () => {
		// A request that has already spent nearly all of the Free plan's 50.
		const budget = new SubrequestBudget(50);
		budget.count(45);
		const res = await publishPOST({
			params: { id: draftId },
			request: new Request('http://localhost/api/drafts/x/publish', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ connectionIds: conns })
			}),
			locals: {
				db,
				env: TEST_ENV,
				media: createTestMedia(),
				budget,
				user: {
					id: userId,
					email: 'budget-route@localhost',
					timezone: 'UTC',
					totpEnabled: true,
					mfaVerified: true
				}
			}
		} as never);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			results: Array<{ connectionId: string; status: string; deferred?: boolean }>;
		};
		expect(body.results).toHaveLength(2);
		// The first ran (its unreachable instance makes it a retryable failure);
		// the second was left for the scheduler.
		const [ran, left] = body.results;
		expect(ran.deferred).toBeUndefined();
		expect(left).toMatchObject({ status: 'pending', deferred: true });
		const [row] = await db
			.select()
			.from(publishTargets)
			.where(eq(publishTargets.connectionId, left.connectionId));
		// A due "publish now" row, untouched: the next tick publishes it.
		expect(row.status).toBe('pending');
		expect(row.scheduledFor).toBeNull();
		expect(row.attemptCount).toBe(0);
	});
});

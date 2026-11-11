import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connections, drafts, publishTargets, users } from '#lib/server/db/schema.js';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { createTestDb, TEST_ENV } from '#lib/server/db/test.js';
import { load as homeLoad } from '../src/routes/+page.server';

const USER = {
	id: 'home-user',
	email: 'home@localhost',
	timezone: 'UTC',
	totpEnabled: true,
	mfaVerified: true
};

type HomeResult = {
	scheduledCount: number;
	draftCount: number;
	failedCount: number;
	connectionCount: number;
	nextScheduledAt: number | null;
};

describe('home load', () => {
	let db: AppDb;
	let close: () => void;
	const stamp = { createdAt: new Date(), updatedAt: new Date() };

	beforeEach(async () => {
		({ db, close } = await createTestDb());
		await db
			.insert(users)
			.values({ id: USER.id, email: USER.email, passwordHash: 'x', timezone: 'UTC', ...stamp });
	});
	afterEach(() => close());

	const run = async () =>
		(await homeLoad({
			locals: { db, env: TEST_ENV, authMethod: 'session', user: USER }
		} as never)) as unknown as HomeResult;

	async function addAccount(id: string, status: string) {
		await db.insert(connections).values({
			id,
			userId: USER.id,
			platform: 'bluesky',
			handle: `${id}.bsky.social`,
			credentialsEncrypted: 'x',
			status,
			...stamp
		});
	}

	async function addPost(id: string, status: string, targets: { to: string; at?: number }[]) {
		await db.insert(drafts).values({ id, userId: USER.id, baseBody: id, status, ...stamp });
		for (const t of targets) {
			await db.insert(publishTargets).values({
				id: newId(),
				draftId: id,
				connectionId: t.to,
				status: status === 'draft' ? 'scheduled' : status,
				scheduledFor: t.at ? new Date(t.at) : null,
				attemptCount: 0,
				...stamp
			});
		}
	}

	it('says there are no accounts on a fresh instance', async () => {
		const data = await run();
		expect(data).toMatchObject({
			scheduledCount: 0,
			draftCount: 0,
			failedCount: 0,
			connectionCount: 0,
			nextScheduledAt: null
		});
	});

	it('counts accounts that can post or be reconnected, not disconnected ones', async () => {
		await addAccount('live', 'active');
		await addAccount('stale', 'expired');
		await addAccount('gone', 'disconnected');
		expect((await run()).connectionCount).toBe(2);
	});

	it('counts a post going to three accounts as one scheduled post, as Posts does', async () => {
		await addAccount('a', 'active');
		await addAccount('b', 'active');
		await addAccount('c', 'active');
		const soon = Date.now() + 3_600_000;
		const later = Date.now() + 86_400_000;
		await addPost('three', 'scheduled', [
			{ to: 'a', at: later },
			{ to: 'b', at: soon },
			{ to: 'c', at: later }
		]);
		await addPost('one', 'scheduled', [{ to: 'a', at: later }]);
		const data = await run();
		expect(data.scheduledCount).toBe(2);
		expect(data.nextScheduledAt).toBe(soon);
	});
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { drafts, draftVariants, users } from '#lib/server/db/schema.js';
import { createTestDb } from '#lib/server/db/test.js';
import { PUT as variantsPUT } from '../src/routes/api/drafts/[id]/variants/+server';

/**
 * The editor sends `body: null` on purpose when a platform keeps its options
 * but loses its custom text. A validator that only accepted strings rejected
 * that write with 400, which broke every save after customising a Mastodon
 * option — caught by the e2e suite, pinned here.
 */
describe('PUT /api/drafts/[id]/variants', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;
	let draftId: string;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'variants@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
		draftId = newId();
		await db.insert(drafts).values({
			id: draftId,
			userId,
			baseBody: 'main body',
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
	});
	afterAll(() => close());

	// Evaluated per call: `db` and `userId` are only bound in beforeAll.
	const localsFor = () => ({
		db,
		user: {
			id: userId,
			email: 'variants@localhost',
			timezone: 'UTC',
			totpEnabled: true,
			mfaVerified: true
		}
	});

	function put(payload: unknown) {
		return variantsPUT({
			params: { id: draftId },
			request: new Request(`http://localhost/api/drafts/${draftId}/variants`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			}),
			locals: localsFor()
		} as never) as Promise<Response>;
	}

	const stored = async (platform: string) =>
		(
			await db
				.select()
				.from(draftVariants)
				.where(and(eq(draftVariants.draftId, draftId), eq(draftVariants.platform, platform)))
		)[0];

	it('accepts a custom body', async () => {
		const res = await put({ platform: 'bluesky', body: 'custom text', options: {} });
		expect(res.status).toBe(200);
		expect((await stored('bluesky'))?.body).toBe('custom text');
	});

	it('accepts null as "clear the override", keeping the options', async () => {
		const res = await put({
			platform: 'mastodon',
			body: null,
			options: { visibility: 'unlisted' }
		});
		expect(res.status).toBe(200);
		const row = await stored('mastodon');
		expect(row?.body).toBeNull();
		expect(row?.optionsJson).toContain('unlisted');
	});

	it('rejects a non-string body instead of storing it', async () => {
		const res = await put({ platform: 'x', body: { text: 'nope' }, options: {} });
		expect(res.status).toBe(400);
		expect(await stored('x')).toBeUndefined();
	});

	it('rejects an unbounded body', async () => {
		const res = await put({ platform: 'threads', body: 'x'.repeat(100_001), options: {} });
		expect(res.status).toBe(400);
	});

	it('rejects options too large to store, however they are shaped', async () => {
		// One JSON column, one statement: 100 segments of 100,000 characters is
		// 10MB, which D1 refuses with a driver error rather than a 400.
		const segments = Array.from({ length: 3 }, () => 'x'.repeat(40_000));
		const res = await put({ platform: 'x', body: 'x', options: { threadSegments: segments } });
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/too large to save/);

		// The same shape, small enough: accepted.
		const small = await put({
			platform: 'x',
			body: 'x',
			options: { threadSegments: ['one', 'two'] }
		});
		expect(small.status).toBe(200);
	});

	it('rejects malformed options and unknown platforms', async () => {
		expect(
			(await put({ platform: 'bluesky', body: 'x', options: { threadSegments: [1] } })).status
		).toBe(400);
		expect((await put({ platform: 'myspace', body: 'x', options: {} })).status).toBe(400);
	});

	it('leaves the stored body alone when the payload omits it', async () => {
		const res = await put({ platform: 'bluesky' });
		expect(res.status).toBe(200);
		expect((await stored('bluesky'))?.body).toBe('custom text');
	});
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { createTestDb, createTestMedia } from '#lib/server/db/test.js';
import {
	connections,
	draftMedia,
	drafts,
	draftVariants,
	publishTargets,
	users
} from '#lib/server/db/schema.js';
import { POST as duplicatePOST } from '../src/routes/api/drafts/[id]/duplicate/+server';
import { DELETE as draftDELETE } from '../src/routes/api/drafts/[id]/+server';

// Real magic bytes: the duplicate route re-sniffs attachment bytes instead of
// trusting the row, so the fixtures have to be shaped like the media they claim.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const MP4_BYTES = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

describe('POST /api/drafts/[id]/duplicate', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;
	let otherId: string;
	const media = createTestMedia();

	const userObj = (id: string) => ({
		id,
		email: 'duplicate@localhost',
		timezone: 'UTC',
		totpEnabled: true,
		mfaVerified: true
	});
	const call = (id: string, extra: Record<string, unknown> = {}) =>
		duplicatePOST({
			params: { id },
			locals: { db, user: userObj(userId), media, ...extra }
		} as never) as Promise<Response>;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		otherId = newId();
		for (const [id, email] of [
			[userId, 'duplicate@localhost'],
			[otherId, 'duplicate-other@localhost']
		]) {
			await db
				.insert(users)
				.values({ id, email, passwordHash: 'x', timezone: 'UTC', createdAt: now, updatedAt: now });
		}
	});
	afterAll(() => close());

	async function seedSource(opts: { withMedia?: boolean; withTarget?: boolean } = {}) {
		const now = new Date();
		const id = newId();
		await db.insert(drafts).values({
			id,
			userId,
			title: 'Hello',
			baseBody: 'body text',
			status: 'published',
			createdAt: now,
			updatedAt: now
		});
		await db.insert(draftVariants).values({
			id: newId(),
			draftId: id,
			platform: 'mastodon',
			body: 'variant body',
			optionsJson: '{"visibility":"public"}',
			createdAt: now,
			updatedAt: now
		});
		if (opts.withMedia) {
			const keys = ['1700000000000-aaaaaaaaaaaaaaaa.png', '1700000000001-bbbbbbbbbbbbbbbb.mp4'];
			const bytes = [PNG_BYTES, MP4_BYTES];
			for (let i = 0; i < keys.length; i++) {
				await media.put(keys[i], bytes[i], i === 0 ? 'image/png' : 'video/mp4');
				await db.insert(draftMedia).values({
					id: newId(),
					draftId: id,
					storageKey: keys[i],
					mime: i === 0 ? 'image/png' : 'video/mp4',
					size: bytes[i].length,
					altText: i === 0 ? 'alt text' : null,
					sortOrder: i,
					segmentIndex: 0,
					createdAt: now
				});
			}
		}
		if (opts.withTarget) {
			const connId = newId();
			await db.insert(connections).values({
				id: connId,
				userId,
				platform: 'mastodon',
				handle: 'me@example.social',
				credentialsEncrypted: 'enc',
				status: 'active',
				createdAt: now,
				updatedAt: now
			});
			await db.insert(publishTargets).values({
				id: newId(),
				draftId: id,
				connectionId: connId,
				status: 'published',
				remotePostId: 'remote-1',
				attemptCount: 1,
				createdAt: now,
				updatedAt: now
			});
		}
		return id;
	}

	it('copies content, variants, and media bytes without publishing state', async () => {
		const sourceId = await seedSource({ withMedia: true, withTarget: true });
		const res = await call(sourceId);
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			draft: {
				id: string;
				title: string | null;
				baseBody: string;
				status: string;
				variants: Array<{ platform: string; body: string | null }>;
				media: Array<{ id: string; storageKey: string; mime: string; altText: string | null }>;
				targets: unknown[];
			};
		};
		const clone = body.draft;
		expect(clone.id).not.toBe(sourceId);
		expect(clone.title).toBe('Hello');
		expect(clone.baseBody).toBe('body text');
		expect(clone.status).toBe('draft');
		expect(clone.variants).toHaveLength(1);
		expect(clone.variants[0]).toMatchObject({ platform: 'mastodon', body: 'variant body' });
		expect(clone.targets).toHaveLength(0);
		expect(clone.media).toHaveLength(2);

		// New keys, same bytes, same alt/order.
		const originalKeys = [
			'1700000000000-aaaaaaaaaaaaaaaa.png',
			'1700000000001-bbbbbbbbbbbbbbbb.mp4'
		];
		for (let i = 0; i < clone.media.length; i++) {
			expect(clone.media[i].storageKey).not.toBe(originalKeys[i]);
			expect(await media.get(clone.media[i].storageKey)).toEqual(await media.get(originalKeys[i]));
		}
		expect(clone.media[0].altText).toBe('alt text');

		// The source and its objects are untouched.
		const sourceRows = await db.select().from(draftMedia).where(eq(draftMedia.draftId, sourceId));
		expect(sourceRows).toHaveLength(2);
		expect(await media.get(originalKeys[0])).toEqual(PNG_BYTES);
		expect(
			await db.select().from(publishTargets).where(eq(publishTargets.draftId, sourceId))
		).toHaveLength(1);

		// Cloned media rows point at the new keys.
		const cloneRows = await db.select().from(draftMedia).where(eq(draftMedia.draftId, clone.id));
		expect(cloneRows.map((r) => r.storageKey).sort()).toEqual(
			clone.media.map((m) => m.storageKey).sort()
		);

		// Deleting the clone must not remove the source's bytes.
		const del = (await draftDELETE({
			params: { id: clone.id },
			locals: { db, user: userObj(userId), media }
		} as never)) as Response;
		expect(del.status).toBe(200);
		expect(await media.get(originalKeys[0])).toEqual(PNG_BYTES);
	});

	it('skips attachments whose object is missing instead of failing', async () => {
		const sourceId = await seedSource({ withMedia: true });
		const rows = await db.select().from(draftMedia).where(eq(draftMedia.draftId, sourceId));
		await media.delete(rows[0].storageKey);

		const res = await call(sourceId);
		expect(res.status).toBe(201);
		const body = (await res.json()) as { draft: { media: unknown[] } };
		expect(body.draft.media).toHaveLength(1);
	});

	it('404s another user’s draft', async () => {
		const now = new Date();
		const foreign = newId();
		await db.insert(drafts).values({
			id: foreign,
			userId: otherId,
			baseBody: 'not mine',
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
		const res = await call(foreign);
		expect(res.status).toBe(404);
	});

	it('requires the write scope', async () => {
		const sourceId = await seedSource();
		const res = await call(sourceId, { apiKeyScopes: ['read'] });
		expect(res.status).toBe(403);
	});

	it('copies more media than fits in one insert chunk', async () => {
		const sourceId = await seedSource();
		const now = new Date();
		const keys: string[] = [];
		for (let i = 0; i < 9; i++) {
			const key = `1700000001000-ccccccccccccccc${i}.png`;
			await media.put(key, PNG_BYTES, 'image/png');
			await db.insert(draftMedia).values({
				id: newId(),
				draftId: sourceId,
				storageKey: key,
				mime: 'image/png',
				size: PNG_BYTES.length,
				sortOrder: i,
				segmentIndex: 0,
				createdAt: now
			});
			keys.push(key);
		}
		const res = await call(sourceId);
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			draft: { id: string; media: Array<{ storageKey: string }> };
		};
		expect(body.draft.media).toHaveLength(9);
		for (const item of body.draft.media) {
			expect(keys).not.toContain(item.storageKey);
			expect(await media.get(item.storageKey)).not.toBeNull();
		}
		const rows = await db.select().from(draftMedia).where(eq(draftMedia.draftId, body.draft.id));
		expect(rows).toHaveLength(9);
	});
});

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
import { coverKey } from '#lib/server/media.js';
import { POST as duplicatePOST } from '../src/routes/api/drafts/[id]/duplicate/+server';
import { DELETE as draftDELETE } from '../src/routes/api/drafts/[id]/+server';
import { DELETE as mediaDELETE } from '../src/routes/api/drafts/[id]/media/+server';
import {
	DELETE as coverDELETE,
	PUT as coverPUT
} from '../src/routes/api/drafts/[id]/media/cover/+server';
import { buildMp4 } from './mp4-fixture';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const MP4_BYTES = buildMp4();

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

	it('keeps a Threads topic tag on the copy', async () => {
		const sourceId = await seedSource();
		const now = new Date();
		await db.insert(draftVariants).values({
			id: newId(),
			draftId: sourceId,
			platform: 'threads',
			body: null,
			optionsJson: '{"topicTag":"AI Tools"}',
			createdAt: now,
			updatedAt: now
		});
		const res = await call(sourceId);
		expect(res.status).toBe(201);
		const { draft } = (await res.json()) as {
			draft: { variants: Array<{ platform: string; body: string | null; optionsJson: unknown }> };
		};
		expect(draft.variants.find((v) => v.platform === 'threads')).toMatchObject({
			body: null,
			optionsJson: { topicTag: 'AI Tools' }
		});
	});

	const ownLocals = () => ({ db, user: userObj(userId), media });
	const deleteDraft = (id: string) =>
		draftDELETE({ params: { id }, locals: ownLocals() } as never) as Promise<Response>;
	const mediaRows = (draftId: string) =>
		db.select().from(draftMedia).where(eq(draftMedia.draftId, draftId));

	it('copies content and variants without publishing state, sharing the media files', async () => {
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

		const source = await mediaRows(sourceId);
		const sourceById = new Map(source.map((row) => [row.storageKey, row]));
		expect(clone.media).toHaveLength(2);
		for (const item of clone.media) {
			expect(sourceById.has(item.storageKey)).toBe(true);
			expect(sourceById.get(item.storageKey)!.id).not.toBe(item.id);
		}
		expect(clone.media[0].altText).toBe('alt text');
		expect(
			await db.select().from(publishTargets).where(eq(publishTargets.draftId, sourceId))
		).toHaveLength(1);

		// A file goes with the last post that uses it, not the first.
		expect((await deleteDraft(clone.id)).status).toBe(200);
		expect(await media.get('1700000000000-aaaaaaaaaaaaaaaa.png')).toEqual(PNG_BYTES);
		expect(await media.get('1700000000001-bbbbbbbbbbbbbbbb.mp4')).toEqual(MP4_BYTES);
		expect((await deleteDraft(sourceId)).status).toBe(200);
		expect(await media.get('1700000000000-aaaaaaaaaaaaaaaa.png')).toBeNull();
		expect(await media.get('1700000000001-bbbbbbbbbbbbbbbb.mp4')).toBeNull();
	});

	it('keeps a shared file when one post removes it', async () => {
		const sourceId = await seedSource({ withMedia: true });
		const clone = ((await (await call(sourceId)).json()) as { draft: { id: string } }).draft;
		const image = (await mediaRows(clone.id)).find((row) => row.mime === 'image/png')!;
		const remove = (draftId: string, mediaId: string) =>
			mediaDELETE({
				params: { id: draftId },
				url: new URL(`http://localhost/x?mediaId=${mediaId}`),
				locals: ownLocals()
			} as never) as Promise<Response>;

		expect((await remove(clone.id, image.id)).status).toBe(200);
		expect(await media.get(image.storageKey)).toEqual(PNG_BYTES);
		const original = (await mediaRows(sourceId)).find((row) => row.mime === 'image/png')!;
		expect((await remove(sourceId, original.id)).status).toBe(200);
		expect(await media.get(image.storageKey)).toBeNull();
	});

	it('gives a copied video its own file before changing its cover', async () => {
		const sourceId = await seedSource({ withMedia: true });
		const video = (await mediaRows(sourceId)).find((row) => row.mime === 'video/mp4')!;
		const oldCover = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1]);
		await media.put(coverKey(video.storageKey), oldCover, 'image/jpeg');
		await db
			.update(draftMedia)
			.set({ metaJson: JSON.stringify({ cover: { v: 1 } }) })
			.where(eq(draftMedia.id, video.id));

		const clone = ((await (await call(sourceId)).json()) as { draft: { id: string } }).draft;
		const copied = (await mediaRows(clone.id)).find((row) => row.mime === 'video/mp4')!;
		expect(copied.storageKey).toBe(video.storageKey);

		const newCover = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 2]);
		const url = new URL(`http://localhost/x?mediaId=${copied.id}`);
		const put = (await coverPUT({
			params: { id: clone.id },
			url,
			request: new Request(url, { method: 'PUT', body: newCover }),
			locals: ownLocals()
		} as never)) as Response;
		expect(put.status).toBe(200);
		const moved = ((await put.json()) as { media: { storageKey: string } }).media.storageKey;
		expect(moved).not.toBe(video.storageKey);
		expect(await media.get(moved)).toEqual(MP4_BYTES);
		expect(await media.get(coverKey(moved))).toEqual(newCover);
		expect(await media.get(coverKey(video.storageKey))).toEqual(oldCover);

		// Removing a cover on a video another post uses leaves that post's cover.
		const second = ((await (await call(sourceId)).json()) as { draft: { id: string } }).draft;
		const secondVideo = (await mediaRows(second.id)).find((row) => row.mime === 'video/mp4')!;
		const del = (await coverDELETE({
			params: { id: second.id },
			url: new URL(`http://localhost/x?mediaId=${secondVideo.id}`),
			locals: ownLocals()
		} as never)) as Response;
		expect(del.status).toBe(200);
		expect(await media.get(coverKey(video.storageKey))).toEqual(oldCover);
	});

	it('leaves a copied video without a cover when storing its new one fails', async () => {
		const sourceId = await seedSource({ withMedia: true });
		const video = (await mediaRows(sourceId)).find((row) => row.mime === 'video/mp4')!;
		await media.put(
			coverKey(video.storageKey),
			new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
			'image/jpeg'
		);
		await db
			.update(draftMedia)
			.set({ metaJson: JSON.stringify({ cover: { v: 1 } }) })
			.where(eq(draftMedia.id, video.id));
		const clone = ((await (await call(sourceId)).json()) as { draft: { id: string } }).draft;
		const copied = (await mediaRows(clone.id)).find((row) => row.mime === 'video/mp4')!;

		const refusing = {
			...media,
			put: async (key: string, bytes: Uint8Array, mime: string) => {
				if (key.startsWith('cover/')) throw new Error('storage unavailable');
				return media.put(key, bytes, mime);
			}
		};
		const url = new URL(`http://localhost/x?mediaId=${copied.id}`);
		const put = (await coverPUT({
			params: { id: clone.id },
			url,
			request: new Request(url, {
				method: 'PUT',
				body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 3])
			}),
			locals: { ...ownLocals(), media: refusing }
		} as never)) as Response;
		expect(put.ok).toBe(false);
		const [after] = await db.select().from(draftMedia).where(eq(draftMedia.id, copied.id));
		expect(JSON.parse(after.metaJson ?? '{}').cover).toBeUndefined();
		expect(await media.get(after.storageKey)).toEqual(MP4_BYTES);
		const [original] = await db.select().from(draftMedia).where(eq(draftMedia.id, video.id));
		expect(JSON.parse(original.metaJson ?? '{}').cover).toEqual({ v: 1 });
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

	it('copies more media rows than fit in one insert chunk', async () => {
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
		expect(body.draft.media.map((item) => item.storageKey).sort()).toEqual(keys.sort());
		const rows = await db.select().from(draftMedia).where(eq(draftMedia.draftId, body.draft.id));
		expect(rows).toHaveLength(9);
	});
});

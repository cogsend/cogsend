import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { connections, draftMedia, drafts, publishTargets, users } from '#lib/server/db/schema.js';
import { createTestDb, createTestMedia } from '#lib/server/db/test.js';
import type { MediaStore } from '#lib/server/media.js';
import { DELETE as draftDELETE } from '../src/routes/api/drafts/[id]/+server';
import {
	PATCH as mediaPATCH,
	POST as mediaPOST
} from '../src/routes/api/drafts/[id]/media/+server';
import { POST as reusePOST } from '../src/routes/api/drafts/[id]/media/reuse/+server';
import { GET as libraryGET } from '../src/routes/api/media/+server';

const keyOf = (n: number, ext = 'png') =>
	`${1_700_000_000_000 + n}-${n.toString(16).padStart(16, '0')}.${ext}`;

describe('your media', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;
	let otherUserId: string;
	const store = createTestMedia();

	const localsFor = (id = userId, media: MediaStore = store) => ({
		db,
		media,
		user: { id, email: 'lib@localhost', timezone: 'UTC', totpEnabled: true, mfaVerified: true }
	});

	async function addUser(email: string) {
		const id = newId();
		const now = new Date();
		await db
			.insert(users)
			.values({ id, email, passwordHash: 'x', timezone: 'UTC', createdAt: now, updatedAt: now });
		return id;
	}

	async function addDraft(owner = userId, body = 'one\n\n---\n\ntwo') {
		const id = newId();
		const now = new Date();
		await db.insert(drafts).values({
			id,
			userId: owner,
			baseBody: body,
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
		return id;
	}

	async function attach(
		draftId: string,
		storageKey: string,
		opts: { at: number; alt?: string | null; mime?: string; segmentIndex?: number; meta?: object }
	) {
		await db.insert(draftMedia).values({
			id: newId(),
			draftId,
			storageKey,
			mime: opts.mime ?? 'image/png',
			size: 8,
			width: 10,
			height: 10,
			altText: opts.alt ?? null,
			metaJson: opts.meta ? JSON.stringify(opts.meta) : null,
			sortOrder: 0,
			segmentIndex: opts.segmentIndex ?? 0,
			createdAt: new Date(opts.at)
		});
	}

	async function list(query = '', id = userId) {
		const url = new URL(`http://localhost/api/media${query}`);
		const res = (await libraryGET({
			url,
			request: new Request(url),
			locals: localsFor(id)
		} as never)) as Response;
		return { status: res.status, body: await res.json() };
	}

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		userId = await addUser('lib@localhost');
		otherUserId = await addUser('other@localhost');
	});

	afterAll(() => close());

	describe('listing', () => {
		it('shows a file shared by several posts once, with its newest alt text', async () => {
			const first = await addDraft();
			const copy = await addDraft();
			await attach(first, keyOf(1), { at: 1_000, alt: 'old words' });
			await attach(copy, keyOf(1), { at: 2_000, alt: 'new words' });
			await attach(first, keyOf(2), { at: 1_500, alt: 'second file', meta: { preview: { v: 7 } } });

			const { status, body } = await list();
			expect(status).toBe(200);
			expect(body.items.map((i: { storageKey: string }) => i.storageKey)).toEqual([
				keyOf(1),
				keyOf(2)
			]);
			expect(body.items[0]).toMatchObject({ altText: 'new words', mime: 'image/png' });
			expect(body.items[1]).toMatchObject({ altText: 'second file', meta: { preview: { v: 7 } } });
			expect(body.next).toBeNull();
		});

		it("never shows another account's files", async () => {
			const theirs = await addDraft(otherUserId);
			await attach(theirs, keyOf(3), { at: 9_000 });
			const mine = await list();
			expect(mine.body.items.map((i: { storageKey: string }) => i.storageKey)).not.toContain(
				keyOf(3)
			);
			const other = await list('', otherUserId);
			expect(other.body.items.map((i: { storageKey: string }) => i.storageKey)).toEqual([keyOf(3)]);
		});

		it('leaves out a key the app never minted', async () => {
			const draft = await addDraft();
			await attach(draft, 'seed-not-a-real-key', { at: 3_000 });
			const { body } = await list();
			expect(body.items.map((i: { storageKey: string }) => i.storageKey)).not.toContain(
				'seed-not-a-real-key'
			);
		});

		it('pages through files used at the same moment without skipping any', async () => {
			const draft = await addDraft();
			for (let n = 10; n < 15; n++) await attach(draft, keyOf(n), { at: 5_000 });
			const seen: string[] = [];
			let query = '?limit=2';
			for (let page = 0; page < 10; page++) {
				const { body } = await list(query);
				seen.push(...body.items.map((i: { storageKey: string }) => i.storageKey));
				if (!body.next) break;
				query = `?limit=2&before=${encodeURIComponent(body.next)}`;
			}
			const expected = [14, 13, 12, 11, 10].map((n) => keyOf(n));
			expect(seen.slice(0, 5)).toEqual(expected);
			expect(new Set(seen).size).toBe(seen.length);
			// Everything older than those five follows them.
			expect(seen).toContain(keyOf(1));
		});

		it('pages past a key the app never minted', async () => {
			const owner = await addUser('paging@localhost');
			const draft = await addDraft(owner);
			await attach(draft, keyOf(30), { at: 3 });
			await attach(draft, 'legacy-key', { at: 2 });
			await attach(draft, keyOf(31), { at: 1 });
			const seen: string[] = [];
			let query = '?limit=1';
			for (let page = 0; page < 5; page++) {
				const { status, body } = await list(query, owner);
				expect(status).toBe(200);
				seen.push(...body.items.map((i: { storageKey: string }) => i.storageKey));
				if (!body.next) break;
				query = `?limit=1&before=${encodeURIComponent(body.next)}`;
			}
			expect(seen).toEqual([keyOf(30), keyOf(31)]);
		});

		it('refuses a cursor it did not make', async () => {
			expect((await list('?before=nonsense')).status).toBe(400);
			expect((await list('?before=12%3A')).status).toBe(400);
			expect((await list('?before=x%3Aabc')).status).toBe(400);
		});

		it('drops a file once the last post using it is deleted', async () => {
			const only = await addDraft();
			await attach(only, keyOf(20), { at: 20_000 });
			expect((await list()).body.items[0].storageKey).toBe(keyOf(20));
			await db.delete(drafts).where(eq(drafts.id, only));
			expect(
				(await list()).body.items.map((i: { storageKey: string }) => i.storageKey)
			).not.toContain(keyOf(20));
		});
	});

	describe('attaching a file again', () => {
		const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const MP4 = new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]);
		let next = 100;

		/** A file in R2 that `draftId` already uses. */
		async function stored(
			draftId: string,
			opts: { mime?: string; alt?: string | null; meta?: object; segmentIndex?: number } = {}
		) {
			const video = (opts.mime ?? '').startsWith('video/');
			const key = keyOf(next++, video ? 'mp4' : 'png');
			await store.put(key, video ? MP4 : PNG, opts.mime ?? 'image/png');
			await attach(draftId, key, { at: Date.now(), ...opts });
			return key;
		}

		async function reuse(
			draftId: string,
			body: unknown,
			opts: { owner?: string; media?: MediaStore } = {}
		) {
			const res = (await reusePOST({
				params: { id: draftId },
				request: new Request('http://localhost/api/drafts/x/media/reuse', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: typeof body === 'string' ? body : JSON.stringify(body)
				}),
				locals: localsFor(opts.owner, opts.media)
			} as never)) as Response;
			return { status: res.status, body: await res.json() };
		}

		const rowsOf = (draftId: string) =>
			db.select().from(draftMedia).where(eq(draftMedia.draftId, draftId));

		it('attaches the file with what its newest use knows, and stores nothing new', async () => {
			const source = await addDraft();
			const key = await stored(source, { alt: 'a red door', meta: { preview: { v: 3 } } });
			const target = await addDraft();

			const { status, body } = await reuse(target, { storageKey: key, segmentIndex: 1 });
			expect(status).toBe(201);
			expect(body.media).toMatchObject({
				draftId: target,
				storageKey: key,
				mime: 'image/png',
				size: 8,
				width: 10,
				height: 10,
				altText: 'a red door',
				segmentIndex: 1,
				sortOrder: 0,
				meta: { preview: { v: 3 } }
			});
			expect(await store.size!(key)).toBe(PNG.length);
			const [sourceRow] = await rowsOf(source);
			expect(body.media.id).not.toBe(sourceRow.id);
		});

		it('keeps alt text to each post', async () => {
			const source = await addDraft();
			const key = await stored(source, { alt: 'original' });
			const target = await addDraft();
			const { body } = await reuse(target, { storageKey: key, altText: '  for this post  ' });
			expect(body.media.altText).toBe('for this post');

			const res = (await mediaPATCH({
				params: { id: target },
				request: new Request('http://localhost/api/drafts/x/media', {
					method: 'PATCH',
					body: JSON.stringify({ mediaId: body.media.id, altText: 'changed here only' })
				}),
				locals: localsFor()
			} as never)) as Response;
			expect(res.status).toBe(200);
			expect((await rowsOf(source))[0].altText).toBe('original');

			const cleared = await reuse(await addDraft(), { storageKey: key, altText: null });
			expect(cleared.body.media.altText).toBeNull();
		});

		it('puts the file after what the card already has', async () => {
			const source = await addDraft();
			const a = await stored(source);
			const b = await stored(source);
			const target = await addDraft();
			await reuse(target, { storageKey: a });
			const { body } = await reuse(target, { storageKey: b });
			expect(body.media.sortOrder).toBe(1);
		});

		it("refuses a file that is not in one of the user's own posts", async () => {
			const theirs = await addDraft(otherUserId);
			const theirKey = await stored(theirs);
			const target = await addDraft();
			expect(await reuse(target, { storageKey: theirKey })).toMatchObject({ status: 404 });
			expect(await reuse(target, { storageKey: keyOf(99_999) })).toMatchObject({ status: 404 });

			const legacy = await addDraft();
			await store.put('legacy-key-2', PNG, 'image/png');
			await attach(legacy, 'legacy-key-2', { at: Date.now() });
			expect(await reuse(target, { storageKey: 'legacy-key-2' })).toMatchObject({ status: 404 });
			expect(await rowsOf(target)).toHaveLength(0);
		});

		it("refuses another account's post as the target", async () => {
			const source = await addDraft();
			const key = await stored(source);
			const theirs = await addDraft(otherUserId);
			expect(await reuse(theirs, { storageKey: key })).toMatchObject({ status: 404 });
			expect(await rowsOf(theirs)).toHaveLength(0);
		});

		it('refuses a body without a key', async () => {
			const target = await addDraft();
			expect((await reuse(target, {})).status).toBe(400);
			expect((await reuse(target, 'not json')).status).toBe(400);
			expect((await reuse(target, [1])).status).toBe(400);
		});

		it('keeps a video alone on its card', async () => {
			const source = await addDraft();
			const image = await stored(source);
			const video = await stored(source, { mime: 'video/mp4', meta: { durationMs: 4000 } });

			const withImage = await addDraft();
			await reuse(withImage, { storageKey: image });
			const videoOnImage = await reuse(withImage, { storageKey: video });
			expect(videoOnImage).toMatchObject({
				status: 400,
				body: { error: 'Videos cannot mix with images on the same post' }
			});

			const withVideo = await addDraft();
			expect((await reuse(withVideo, { storageKey: video })).status).toBe(201);
			expect(await reuse(withVideo, { storageKey: image })).toMatchObject({
				status: 400,
				body: { error: 'Videos cannot mix with images on the same post' }
			});
			expect(await reuse(withVideo, { storageKey: video })).toMatchObject({
				status: 400,
				body: { error: 'Only one video per post' }
			});
			// The next card is free.
			expect((await reuse(withVideo, { storageKey: image, segmentIndex: 1 })).status).toBe(201);
		});

		it('holds a card to four images and a post to its cards', async () => {
			const source = await addDraft();
			const key = await stored(source);
			const target = await addDraft();
			for (let i = 0; i < 4; i++) {
				expect((await reuse(target, { storageKey: key })).status).toBe(201);
			}
			expect(await reuse(target, { storageKey: key })).toMatchObject({
				status: 400,
				body: { error: 'Max 4 images per post' }
			});
			expect((await reuse(target, { storageKey: key, segmentIndex: 2 })).status).toBe(400);
			expect(await rowsOf(target)).toHaveLength(4);
		});

		it('holds a post to its file limit', async () => {
			const source = await addDraft();
			const key = await stored(source);
			const target = await addDraft(
				userId,
				Array.from({ length: 40 }, (_, i) => `p${i}`).join('\n\n---\n\n')
			);
			for (let i = 0; i < 32; i++) {
				await attach(target, keyOf(50_000 + i), { at: 1, segmentIndex: Math.floor(i / 4) });
			}
			expect(await reuse(target, { storageKey: key, segmentIndex: 39 })).toMatchObject({
				status: 413,
				body: { error: 'Max 32 files per draft' }
			});
		});

		it('works with the account at its file limit, since nothing new is stored', async () => {
			const owner = await addUser('full@localhost');
			const full = await addDraft(owner);
			const rows = Array.from({ length: 1000 }, (_, i) => ({
				id: newId(),
				draftId: full,
				storageKey: keyOf(200_000 + i),
				mime: 'image/png',
				size: 8,
				sortOrder: i,
				segmentIndex: 0,
				createdAt: new Date(1)
			}));
			for (let i = 0; i < rows.length; i += 100) {
				await db.insert(draftMedia).values(rows.slice(i, i + 100));
			}
			const key = keyOf(200_000);
			await store.put(key, PNG, 'image/png');
			const target = await addDraft(owner);

			const form = new FormData();
			form.append('files', new File([PNG], 'new.png', { type: 'image/png' }));
			const upload = (await mediaPOST({
				params: { id: target },
				request: new Request('http://localhost/api/drafts/x/media', { method: 'POST', body: form }),
				locals: localsFor(owner)
			} as never)) as Response;
			expect(upload.status).toBe(413);
			expect((await reuse(target, { storageKey: key }, { owner })).status).toBe(201);
		});

		it('refuses a post that is already published', async () => {
			const source = await addDraft();
			const key = await stored(source);
			const target = await addDraft();
			const connId = newId();
			const now = new Date();
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
				draftId: target,
				connectionId: connId,
				status: 'published',
				remotePostId: 'remote-1',
				attemptCount: 1,
				createdAt: now,
				updatedAt: now
			});
			expect((await reuse(target, { storageKey: key })).status).toBe(409);
			expect(await rowsOf(target)).toHaveLength(0);
		});

		it('refuses a file that is no longer in storage', async () => {
			const source = await addDraft();
			const key = await stored(source);
			await store.delete(key);
			const target = await addDraft();
			expect(await reuse(target, { storageKey: key })).toMatchObject({ status: 404 });
			expect(await rowsOf(target)).toHaveLength(0);
		});

		it('takes back the attachment when the file goes while it is being attached', async () => {
			const source = await addDraft();
			const key = await stored(source);
			const target = await addDraft();
			let checks = 0;
			const racing: MediaStore = {
				...store,
				size: async (k) => (++checks > 1 ? null : store.size!(k))
			};
			const res = await reuse(target, { storageKey: key }, { media: racing });
			expect(res).toMatchObject({ status: 409 });
			expect(await rowsOf(target)).toHaveLength(0);
		});

		it('keeps the file while any post uses it, and deletes it with the last', async () => {
			const source = await addDraft();
			const key = await stored(source);
			const target = await addDraft();
			await reuse(target, { storageKey: key });

			const remove = async (id: string) =>
				((await draftDELETE({ params: { id }, locals: localsFor() } as never)) as Response).status;
			expect(await remove(source)).toBe(200);
			expect(await store.size!(key)).toBe(PNG.length);
			expect((await list()).body.items.map((i: { storageKey: string }) => i.storageKey)).toContain(
				key
			);
			expect(await remove(target)).toBe(200);
			expect(await store.size!(key)).toBeNull();
		});
	});
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { draftMedia, drafts, users } from '#lib/server/db/schema.js';
import { createTestDb, createTestMedia } from '#lib/server/db/test.js';
import { deleteMediaObjects, jpegKey, previewKey } from '#lib/server/media.js';
import { buildNormalizedPost } from '#lib/server/publish.js';
import { imageUrl } from '#lib/domain/media-layout.js';
import { POST as mediaPOST } from '../src/routes/api/drafts/[id]/media/+server';
import { POST as duplicatePOST } from '../src/routes/api/drafts/[id]/duplicate/+server';
import { GET as mediaGET } from '../src/routes/api/media/[key]/+server';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7, 8]);

describe('image previews', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;
	const media = createTestMedia();

	const locals = () => ({
		db,
		media,
		bindings: {},
		user: {
			id: userId,
			email: 'preview@localhost',
			timezone: 'UTC',
			totpEnabled: true,
			mfaVerified: true
		}
	});

	async function freshDraft() {
		const now = new Date();
		const id = newId();
		await db.insert(drafts).values({
			id,
			userId,
			baseBody: 'preview probe',
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
		return id;
	}

	async function upload(
		draftId: string,
		files: Array<{ image: Uint8Array<ArrayBuffer>; preview?: Blob; jpeg?: Blob }>
	) {
		const form = new FormData();
		form.set('segmentIndex', '0');
		files.forEach(({ image, preview, jpeg }, n) => {
			form.append('files', new File([image], `p${n}.png`, { type: 'image/png' }));
			if (preview) form.append(`preview-${n}`, preview, 'preview.jpg');
			if (jpeg) form.append(`jpeg-${n}`, jpeg, 'copy.jpg');
		});
		const res = (await mediaPOST({
			params: { id: draftId },
			request: new Request('http://localhost/api/drafts/x/media', { method: 'POST', body: form }),
			locals: locals()
		} as never)) as Response;
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			items: Array<{
				id: string;
				storageKey: string;
				meta: { preview?: { v: number }; jpeg?: { v: number } } | null;
			}>;
		};
		return body.items;
	}

	function serve(storageKey: string, query: string) {
		return mediaGET({
			params: { key: storageKey },
			url: new URL(`http://localhost/api/media/${storageKey}${query}`),
			request: new Request('http://localhost/x'),
			locals: locals()
		} as never) as Promise<Response>;
	}

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'preview@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
	});
	afterAll(() => close());

	it('keeps the preview sent with each image and serves it in place of the original', async () => {
		const draftId = await freshDraft();
		const [withPreview, without] = await upload(draftId, [
			{ image: PNG, preview: new Blob([JPEG], { type: 'image/jpeg' }) },
			{ image: PNG }
		]);
		expect(withPreview.meta?.preview?.v).toBeTypeOf('number');
		expect(without.meta).toBeNull();
		expect(await media.get(previewKey(withPreview.storageKey))).toEqual(JPEG);
		expect(await media.get(previewKey(without.storageKey))).toBeNull();

		const preview = await serve(withPreview.storageKey, `?preview=${withPreview.meta!.preview!.v}`);
		expect(preview.headers.get('Content-Type')).toBe('image/jpeg');
		expect(new Uint8Array(await preview.arrayBuffer())).toEqual(JPEG);
		// No preview kept: the original is what shows.
		const fallback = await serve(without.storageKey, '?preview=1');
		expect(new Uint8Array(await fallback.arrayBuffer())).toEqual(PNG);
		const original = await serve(withPreview.storageKey, '');
		expect(new Uint8Array(await original.arrayBuffer())).toEqual(PNG);

		expect(imageUrl(withPreview)).toBe(
			`/api/media/${withPreview.storageKey}?preview=${withPreview.meta!.preview!.v}`
		);
		expect(imageUrl(without)).toBe(`/api/media/${without.storageKey}`);
	});

	it('drops a preview that is not a small JPEG and still takes the image', async () => {
		const draftId = await freshDraft();
		const [png, huge] = await upload(draftId, [
			{ image: PNG, preview: new Blob([PNG], { type: 'image/jpeg' }) },
			{
				image: PNG,
				preview: new Blob([JPEG, new Uint8Array(1_000_001)], { type: 'image/jpeg' })
			}
		]);
		for (const item of [png, huge]) {
			expect(item.meta).toBeNull();
			expect(await media.get(previewKey(item.storageKey))).toBeNull();
		}
	});

	it('comes along when the post is duplicated, and goes with the image', async () => {
		const draftId = await freshDraft();
		const [item] = await upload(draftId, [
			{ image: PNG, preview: new Blob([JPEG], { type: 'image/jpeg' }) }
		]);
		const res = (await duplicatePOST({
			params: { id: draftId },
			locals: locals()
		} as never)) as Response;
		expect(res.ok).toBe(true);
		const { draft } = (await res.json()) as { draft: { id: string } };
		const [copy] = await db.select().from(draftMedia).where(eq(draftMedia.draftId, draft.id));
		expect(copy.storageKey).not.toBe(item.storageKey);
		expect(JSON.parse(copy.metaJson ?? '{}').preview).toEqual(item.meta!.preview);
		expect(await media.get(previewKey(copy.storageKey))).toEqual(JPEG);

		await deleteMediaObjects(media, [item.storageKey]);
		expect(await media.get(item.storageKey)).toBeNull();
		expect(await media.get(previewKey(item.storageKey))).toBeNull();
		expect(await media.get(previewKey(copy.storageKey))).toEqual(JPEG);
	});

	it("keeps a PNG's JPEG copy for Instagram, and hands publishing the news", async () => {
		const draftId = await freshDraft();
		const copy = new Blob([JPEG], { type: 'image/jpeg' });
		const [kept, notJpeg] = await upload(draftId, [
			{ image: PNG, jpeg: copy },
			{ image: PNG, jpeg: new Blob([PNG], { type: 'image/jpeg' }) }
		]);
		expect(kept.meta?.jpeg?.v).toBeTypeOf('number');
		expect(await media.get(jpegKey(kept.storageKey))).toEqual(JPEG);
		expect(notJpeg.meta).toBeNull();
		expect(await media.get(jpegKey(notJpeg.storageKey))).toBeNull();

		const post = await buildNormalizedPost(db, draftId, 'instagram');
		expect(post.media?.map((m) => m.hasJpegCopy ?? false)).toEqual([true, false]);

		await deleteMediaObjects(media, [kept.storageKey]);
		expect(await media.get(jpegKey(kept.storageKey))).toBeNull();
	});

	it('keeps no copy of an image that is already a JPEG', async () => {
		const draftId = await freshDraft();
		const form = new FormData();
		form.set('segmentIndex', '0');
		form.append('files', new File([JPEG], 'p.jpg', { type: 'image/jpeg' }));
		form.append('jpeg-0', new Blob([JPEG], { type: 'image/jpeg' }), 'copy.jpg');
		const res = (await mediaPOST({
			params: { id: draftId },
			request: new Request('http://localhost/api/drafts/x/media', { method: 'POST', body: form }),
			locals: locals()
		} as never)) as Response;
		const [item] = ((await res.json()) as { items: Array<{ storageKey: string; meta: unknown }> })
			.items;
		expect(item.meta).toBeNull();
		expect(await media.get(jpegKey(item.storageKey))).toBeNull();
	});

	it('brings the JPEG copy along when the post is duplicated', async () => {
		const draftId = await freshDraft();
		const [item] = await upload(draftId, [
			{
				image: PNG,
				preview: new Blob([JPEG], { type: 'image/jpeg' }),
				jpeg: new Blob([JPEG], { type: 'image/jpeg' })
			}
		]);
		const res = (await duplicatePOST({
			params: { id: draftId },
			locals: locals()
		} as never)) as Response;
		const { draft } = (await res.json()) as { draft: { id: string } };
		const [copy] = await db.select().from(draftMedia).where(eq(draftMedia.draftId, draft.id));
		expect(JSON.parse(copy.metaJson ?? '{}')).toEqual(item.meta);
		expect(await media.get(jpegKey(copy.storageKey))).toEqual(JPEG);
	});
});

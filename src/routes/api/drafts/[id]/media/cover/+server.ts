import { and, eq, type InferSelectModel } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { randomHex } from '#lib/domain/bytes.js';
import { validateImageUpload } from '#lib/domain/media-limits.js';
import { first, parseJson } from '#lib/server/db/client.js';
import { draftMedia } from '#lib/server/db/schema.js';
import { keysUsedOnlyBy, ownDraft, rejectIfNotEditable } from '#lib/server/draft-media.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import { coverKey, deleteMediaObjects, type StoredVideoMeta } from '#lib/server/media.js';
import { requireScope, requireUser } from '#lib/server/require.js';
import { serializeMedia } from '#lib/server/serialize.js';

// Instagram takes covers up to 8 MB; a frame from the composer is a few hundred KB.
const MAX_COVER_BYTES = 8_000_000;

async function videoRow(locals: App.Locals, draftId: string, mediaId: string | null) {
	if (!mediaId) return null;
	const row = await first(
		locals.db
			.select()
			.from(draftMedia)
			.where(and(eq(draftMedia.id, mediaId), eq(draftMedia.draftId, draftId)))
	);
	return row && (row.mime || '').toLowerCase().startsWith('video/') ? row : null;
}

type MediaRow = InferSelectModel<typeof draftMedia>;

const sharedWithAnotherPost = async (locals: App.Locals, row: MediaRow) =>
	(await keysUsedOnlyBy(locals.db, [row.storageKey], { mediaId: row.id })).length === 0;

/**
 * The cover is stored beside the video, so a video a copied post shares
 * would take the new cover on every post. This post gets its own copy of the
 * video first, streamed rather than read into the isolate.
 */
async function ownVideo(locals: App.Locals, row: MediaRow): Promise<MediaRow | null> {
	const store = locals.media;
	if (!store.copy || !store.size) return null;
	const storageKey = `${Date.now()}-${randomHex(8)}.mp4`;
	if (!(await store.copy(row.storageKey, storageKey))) return null;
	let moved: MediaRow;
	try {
		const size = await store.size(storageKey);
		if (!size) throw new Error('empty copy');
		// The copy has no cover beside it yet; a failed cover write must not
		// leave the row pointing at one.
		const meta = parseJson<StoredVideoMeta>(row.metaJson, {} as StoredVideoMeta);
		delete meta.cover;
		[moved] = await locals.db
			.update(draftMedia)
			.set({ storageKey, size, metaJson: JSON.stringify(meta) })
			.where(eq(draftMedia.id, row.id))
			.returning();
		if (!moved) throw new Error('media row gone');
	} catch {
		await deleteMediaObjects(store, [storageKey]).catch(() => {});
		return null;
	}
	// Another post may have moved off the original at the same time.
	const unused = await keysUsedOnlyBy(locals.db, [row.storageKey], { mediaId: row.id });
	await deleteMediaObjects(store, unused).catch(() => {});
	return moved;
}

async function guard(locals: App.Locals, draftId: string) {
	const user = requireUser(locals.user);
	requireScope(locals, 'write');
	if (!(await ownDraft(locals, draftId, user.id))) return fail('Not found', 404);
	return rejectIfNotEditable(locals.db, draftId);
}

/** Set a video's cover: a JPEG body, a frame the composer captured or an image. */
export const PUT: RequestHandler = async ({ params, request, url, locals }) => {
	try {
		const declared = Number(request.headers.get('content-length') ?? '');
		if (Number.isFinite(declared) && declared > MAX_COVER_BYTES) {
			return fail('Cover must be 8MB or smaller', 413);
		}
		const blocked = await guard(locals, params.id);
		if (blocked) return blocked;
		const found = await videoRow(locals, params.id, url.searchParams.get('mediaId'));
		if (!found) return fail('Video not found', 404);
		const bytes = new Uint8Array(await request.arrayBuffer());
		const check = validateImageUpload({
			mime: 'image/jpeg',
			size: bytes.length,
			maxBytes: MAX_COVER_BYTES,
			bytes
		});
		if (!check.ok) return fail(check.message);
		// Every platform that takes a cover takes JPEG; Instagram takes nothing else.
		if (check.mime !== 'image/jpeg') return fail('Cover must be a JPEG');
		const row = (await sharedWithAnotherPost(locals, found))
			? await ownVideo(locals, found)
			: found;
		if (!row) return fail('Could not save the cover', 500);
		await locals.media.put(coverKey(row.storageKey), bytes, 'image/jpeg');
		const atParam = url.searchParams.get('atMs');
		const atMs = atParam === null || atParam === '' ? NaN : Number(atParam);
		const meta = parseJson<StoredVideoMeta>(row.metaJson, {} as StoredVideoMeta);
		meta.cover = {
			v: Date.now(),
			...(Number.isFinite(atMs) && atMs >= 0 ? { atMs: Math.round(atMs) } : {})
		};
		const [media] = await locals.db
			.update(draftMedia)
			.set({ metaJson: JSON.stringify(meta) })
			.where(eq(draftMedia.id, row.id))
			.returning();
		return ok({ media: serializeMedia(media) });
	} catch (err) {
		return handleError(err);
	}
};

/** Back to the platforms' own choice of cover. */
export const DELETE: RequestHandler = async ({ params, url, locals }) => {
	try {
		const blocked = await guard(locals, params.id);
		if (blocked) return blocked;
		const row = await videoRow(locals, params.id, url.searchParams.get('mediaId'));
		if (!row) return fail('Video not found', 404);
		// Another post using this video keeps the cover it has.
		if (!(await sharedWithAnotherPost(locals, row))) {
			await locals.media.delete(coverKey(row.storageKey));
		}
		const meta = parseJson<StoredVideoMeta>(row.metaJson, {} as StoredVideoMeta);
		delete meta.cover;
		const [media] = await locals.db
			.update(draftMedia)
			.set({ metaJson: JSON.stringify(meta) })
			.where(eq(draftMedia.id, row.id))
			.returning();
		return ok({ media: serializeMedia(media) });
	} catch (err) {
		return handleError(err);
	}
};

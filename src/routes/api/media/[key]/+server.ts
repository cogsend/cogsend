import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { first } from '#lib/server/db/client.js';
import { draftMedia, drafts } from '#lib/server/db/schema.js';
import { fail, handleError } from '#lib/server/http.js';
import {
	assertSafeStorageKey,
	coverKey,
	jpegResponse,
	previewKey,
	PRIVATE_MEDIA_CACHE,
	serveMediaBytes,
	storedThumbnail,
	thumbCandidate,
	type ImageResizer
} from '#lib/server/media.js';
import { requireScope, requireUser } from '#lib/server/require.js';

export const GET: RequestHandler = async ({ params, locals, request, url }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'read');
		const key = assertSafeStorageKey(params.key);
		const media = await first(
			locals.db.select().from(draftMedia).where(eq(draftMedia.storageKey, key))
		);
		if (!media) return fail('Not found', 404);
		const draft = await first(
			locals.db
				.select()
				.from(drafts)
				.where(and(eq(drafts.id, media.draftId), eq(drafts.userId, user.id)))
		);
		if (!draft) return fail('Not found', 404);
		// A video's cover; the query value is its version, so a new cover is a
		// new URL and the immutable cache never shows the old one.
		if (url.searchParams.has('cover')) {
			const cover = await locals.media.get(coverKey(key));
			if (!cover) return fail('Not found', 404);
			return jpegResponse(cover, PRIVATE_MEDIA_CACHE);
		}
		// The composer's smaller copy, for showing an image. One that was never
		// made (an older upload, an API client) falls through to the original.
		if (url.searchParams.has('preview') && !(media.mime || '').startsWith('video/')) {
			const preview = await locals.media.get(previewKey(key));
			if (preview) return jpegResponse(preview, PRIVATE_MEDIA_CACHE);
		}
		// Your media's small copy: the one the browser made at upload, else one
		// the Images binding makes now for a deployment that has it. Without
		// either, the original is served.
		if (url.searchParams.has('thumb') && !(media.mime || '').startsWith('video/')) {
			const images = (locals.bindings as { IMAGES?: ImageResizer }).IMAGES ?? null;
			const thumb = await storedThumbnail(
				locals.media,
				key,
				images && thumbCandidate(media.mime, media.width, media.height) ? images : null
			);
			if (thumb) return jpegResponse(thumb, PRIVATE_MEDIA_CACHE);
		}
		return await serveMediaBytes(locals.media, key, request, {
			mime: media.mime,
			cacheControl: PRIVATE_MEDIA_CACHE
		});
	} catch (err) {
		return handleError(err);
	}
};

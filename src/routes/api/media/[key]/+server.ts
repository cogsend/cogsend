import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { first } from '#lib/server/db/client.js';
import { draftMedia, drafts } from '#lib/server/db/schema.js';
import { fail, handleError } from '#lib/server/http.js';
import {
	assertSafeStorageKey,
	jpegResponse,
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
		// Posts grid. Only a deployment that bound Cloudflare Images gets a
		// smaller file; everyone else, and any encode that fails, gets the
		// original. Skipping the attempt when the binding is absent avoids an
		// extra storage read on every thumbnail.
		const images = (locals.bindings as { IMAGES?: ImageResizer }).IMAGES ?? null;
		if (
			images &&
			url.searchParams.get('thumb') === '1' &&
			thumbCandidate(media.mime, media.width, media.height)
		) {
			const thumb = await storedThumbnail(locals.media, key, images);
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

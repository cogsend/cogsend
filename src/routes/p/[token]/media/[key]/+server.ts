import type { RequestHandler } from './$types';
import { resolveSharedMedia } from '#lib/server/draft-shares.js';
import { fail, handleError } from '#lib/server/http.js';
import {
	assertSafeStorageKey,
	coverKey,
	jpegResponse,
	previewKey,
	serveMediaBytes
} from '#lib/server/media.js';

// Short and private: a revoked link stops serving at once to anyone who has not
// already loaded the file, while a reader scrolling back and forth does not
// spend the rate limit on every image again.
const SHARED_MEDIA_CACHE = 'private, max-age=300';

export const GET: RequestHandler = async ({ params, locals, request, url }) => {
	try {
		const key = assertSafeStorageKey(params.key);
		const media = await resolveSharedMedia(locals.db, params.token, key);
		if (!media) return fail('Not found', 404);
		if (url.searchParams.has('cover')) {
			const cover = await locals.media.get(coverKey(key));
			if (!cover) return fail('Not found', 404);
			return jpegResponse(cover, SHARED_MEDIA_CACHE);
		}
		if (url.searchParams.has('preview') && !(media.mime || '').startsWith('video/')) {
			const preview = await locals.media.get(previewKey(key));
			if (preview) return jpegResponse(preview, SHARED_MEDIA_CACHE);
		}
		return await serveMediaBytes(locals.media, key, request, {
			mime: media.mime,
			cacheControl: SHARED_MEDIA_CACHE
		});
	} catch (err) {
		return handleError(err);
	}
};

import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { first } from '#lib/server/db/client.js';
import { draftMedia } from '#lib/server/db/schema.js';
import { fail, handleError } from '#lib/server/http.js';
import { assertSafeStorageKey, serveMediaBytes } from '#lib/server/media.js';
import { verifyPublicMediaSig } from '#lib/server/public-media.js';

// Publish-time asset delivery (e.g. Threads fetches image_url server-side).
// Possession of a fresh HMAC-signed URL is the authorization: no session, no
// ownership lookup, short expiry. Never link these URLs publicly.
export const GET: RequestHandler = async ({ params, url, locals, request }) => {
	try {
		const key = assertSafeStorageKey(params.key);
		const exp = Number(url.searchParams.get('exp'));
		const sig = url.searchParams.get('sig') ?? '';
		const checked = await verifyPublicMediaSig(locals.env.APP_ENCRYPTION_KEY, key, exp, sig);
		if (!checked.ok) return fail(checked.error, 403);
		const media = await first(
			locals.db.select().from(draftMedia).where(eq(draftMedia.storageKey, key))
		);
		if (!media) return fail('Not found', 404);
		// Not cached: the URL is HMAC-signed but short-lived, and a deletion
		// must take effect immediately rather than after an edge cache expires.
		return await serveMediaBytes(locals.media, key, request, {
			mime: media.mime,
			cacheControl: 'no-store'
		});
	} catch (err) {
		return handleError(err);
	}
};

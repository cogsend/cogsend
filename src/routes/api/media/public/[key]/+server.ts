import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { first } from '#lib/server/db/client.js';
import { draftMedia } from '#lib/server/db/schema.js';
import { fail, handleError } from '#lib/server/http.js';
import { assertSafeStorageKey, coverKey, jpegKey, serveMediaBytes } from '#lib/server/media.js';
import { isPublicMediaVariant, verifyPublicMediaSig } from '#lib/server/public-media.js';

// Publish-time asset delivery (e.g. Threads fetches image_url server-side).
// Possession of a fresh HMAC-signed URL is the authorization: no session, no
// ownership lookup, short expiry. Never link these URLs publicly.
export const GET: RequestHandler = async ({ params, url, locals, request }) => {
	try {
		const key = assertSafeStorageKey(params.key);
		const exp = Number(url.searchParams.get('exp'));
		const sig = url.searchParams.get('sig') ?? '';
		const v = url.searchParams.get('v');
		if (v !== null && !isPublicMediaVariant(v)) return fail('Unknown variant', 400);
		const variant = v ?? undefined;
		const checked = await verifyPublicMediaSig(
			locals.env.APP_ENCRYPTION_KEY,
			key,
			exp,
			sig,
			undefined,
			variant
		);
		if (!checked.ok) return fail(checked.error, 403);
		const media = await first(
			locals.db.select().from(draftMedia).where(eq(draftMedia.storageKey, key))
		);
		if (!media) return fail('Not found', 404);
		// Not cached: the URL is HMAC-signed but short-lived, and a deletion
		// must take effect immediately rather than after an edge cache expires.
		if (variant) {
			const variantKey = variant === 'jpeg' ? jpegKey(key) : coverKey(key);
			return await serveMediaBytes(locals.media, variantKey, request, {
				mime: 'image/jpeg',
				cacheControl: 'no-store'
			});
		}
		return await serveMediaBytes(locals.media, key, request, {
			mime: media.mime,
			cacheControl: 'no-store'
		});
	} catch (err) {
		return handleError(err);
	}
};

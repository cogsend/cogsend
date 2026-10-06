import type { RequestHandler } from './$types';
import { extractFirstUrl } from '$lib/domain/links';
import { handleError, ok, fail } from '$lib/server/http';
import { parseXPostUrl } from '$lib/domain/x-quote';
import { fetchOpenGraph } from '$lib/server/opengraph';
import { providerFetch } from '$lib/server/providers/timed-fetch';
import { requireScope, requireUser } from '$lib/server/require';
import { fetchXPostPreview } from '$lib/server/x-post-preview';

/**
 * GET /api/link-preview?url=… → { url, title, description, image, siteName }
 *
 * Composer preview for the standard link-card flow: first URL per segment,
 * suppressed client-side when that segment has media. Publish re-fetches the
 * same OG server-side (Bluesky external, LinkedIn article); Mastodon/Threads
 * unfurl server-side and need no payload.
 *
 * An X post link also carries `xPost` (author, text, date) for the composer's
 * quote card, read from X's oEmbed endpoint because x.com gives a server no
 * post text.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	try {
		requireUser(locals.user);
		// `write`, not `read`: this is the one endpoint that makes the server
		// fetch a caller-supplied URL. Host validation, redirect re-checking and
		// size caps bound it, but a least-privileged key should not be able to
		// use the Worker as an egress proxy.
		requireScope(locals, 'write');
		const raw = (url.searchParams.get('url') || '').trim();
		if (!raw) return fail('url required');
		// Accept bare pastes (`example.com/x`) as well as full URLs.
		const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
		const first = extractFirstUrl(candidate) ?? candidate;
		if (first.length > 2048) return fail('url too long');
		if (parseXPostUrl(first)) {
			try {
				return ok(await fetchXPostPreview(first, providerFetch));
			} catch (err) {
				// A post X says is gone stays gone; anything else falls back to the
				// page's own tags, which is what this endpoint returned before.
				if ((err as { status?: number })?.status === 404) throw err;
			}
			try {
				return ok(await fetchOpenGraph(first, providerFetch));
			} catch (err) {
				// The quote card reads 404 as "this post is gone", and only X's own
				// answer can say that: a page without tags is just a failed preview.
				if ((err as { status?: number })?.status !== 404) throw err;
				throw Object.assign(new Error('No preview found for this link'), { status: 502 });
			}
		}
		const og = await fetchOpenGraph(first, providerFetch);
		return ok(og);
	} catch (err) {
		return handleError(err);
	}
};

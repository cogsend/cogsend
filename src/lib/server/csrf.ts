import { extractBearerToken } from '#lib/domain/bearer.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** What an HTML form, or a page's no-preflight fetch, can send. */
const FORM_TYPES = new Set([
	'application/x-www-form-urlencoded',
	'multipart/form-data',
	'text/plain',
	'application/x-sveltekit-formdata'
]);

/** True when the request names its own credential instead of relying on the
 *  session cookie, the same test the hook makes before authenticating it. */
export function carriesCredential(headers: Headers): boolean {
	return extractBearerToken(headers) !== null || (headers.get('x-api-key')?.trim() ?? '') !== '';
}

/**
 * SvelteKit 3's cross-site request check, which the hook runs in place of the
 * built-in one (`csrf` in vite.config.ts) so that it can tell a browser from a
 * script.
 *
 * A mutating request from another origin is refused when its body is one a
 * page can send cross-site without a preflight: a form content type, or none
 * at all. That is SvelteKit's rule, unchanged, for every request the browser
 * authenticates by itself with the session cookie. A request that carries its
 * own credential passes: no other site can make a browser add one of those
 * headers without a CORS preflight, which this app never grants, while API
 * clients, scripts and tick pingers routinely POST or DELETE with no body and
 * no Content-Type, and SvelteKit's rule would refuse them all.
 */
export function isCrossSiteForgery(request: Request, selfOrigin: string): boolean {
	if (!MUTATING.has(request.method)) return false;
	if (request.headers.get('origin') === selfOrigin) return false;
	const type = (request.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
	if (type && !FORM_TYPES.has(type)) return false;
	return !carriesCredential(request.headers);
}

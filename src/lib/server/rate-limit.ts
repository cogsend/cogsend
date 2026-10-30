/**
 * The flood guard for the endpoints anybody can call: sign-in, the
 * authenticator check, and draft preview links.
 *
 * Cloudflare enforces these limits at the edge — the binding is backed by the
 * same infrastructure as WAF rate-limiting rules — so nothing here counts
 * requests itself, and there is no Durable Object or KV to run. Two things
 * follow from that, and both are deliberate:
 *
 *   * The limits are per Cloudflare location and eventually consistent, so they
 *     are a burst guard rather than an accounting system.
 *   * The in-app lockout (eight failures per fifteen minutes, per account) stays
 *     what actually stops guessing. This keeps a flood from reaching D1 at all,
 *     which is what an unauthenticated PBKDF2 endpoint needs.
 */
export type RateLimiter = {
	limit(input: { key: string }): Promise<{ success: boolean }>;
};

/** `/api/auth/claim` takes the encryption key on a fresh instance,
 *  `/api/auth/totp/verify` covers the login challenge, and the two update routes
 *  take the account password to lock or open the saved Cloudflare token; the
 *  enroll/rotate routes need a session first, and the tick endpoint is
 *  bearer-guarded. */
export const RATE_LIMITED_PATHS = [
	'/api/auth/login',
	'/api/auth/claim',
	'/api/auth/totp/verify',
	'/api/update/unlock',
	'/api/update/remember'
];

/** True for the paths this guard applies to (a trailing slash included). */
export function isRateLimitedPath(path: string): boolean {
	const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
	return RATE_LIMITED_PATHS.includes(trimmed);
}

/**
 * Which bucket a path counts against, as a key prefix, or null when it is not
 * limited. Preview links (`/p/<token>` and their media) are public pages, so
 * they are limited too, but in buckets of their own: a teammate reading a draft
 * from the operator's office must never spend the operator's sign-in attempts.
 * Media gets a separate bucket from the page because one view of a thread can
 * load a dozen images.
 */
export function rateLimitBucket(path: string): string | null {
	if (isRateLimitedPath(path)) return '';
	if (path.startsWith('/p/')) return path.includes('/media/') ? 'share-media:' : 'share:';
	return null;
}

/**
 * The bucket key: the client address as the edge saw it, or null when there is
 * no edge in the way.
 *
 * `cf-connecting-ip` is set by Cloudflare for every request that reaches a
 * deployment, and a client cannot forge it. Its absence therefore means the
 * request did not come through the edge — a local `wrangler dev` server, a
 * test, a script on the same machine — which is a caller that already has the
 * instance's own secrets. Nothing to guard against, and one shared bucket would
 * only ever throttle the operator.
 */
export function rateLimitKey(headers: { get(name: string): string | null }): string | null {
	return headers.get('cf-connecting-ip')?.trim() || null;
}

/**
 * Null when the request may proceed. A missing binding (unit tests, an older
 * config) and a failing one both let the request through: this is a guard, not
 * the gate, and refusing every sign-in because the limiter misbehaved would be
 * worse than the flood it exists to blunt.
 */
export async function rateLimitProblem(
	limiter: RateLimiter | undefined,
	key: string | null
): Promise<string | null> {
	if (!limiter || !key) return null;
	try {
		const { success } = await limiter.limit({ key });
		return success ? null : 'Too many attempts — wait a minute and try again';
	} catch {
		return null;
	}
}

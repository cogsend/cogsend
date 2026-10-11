import { isLocalAppUrl, isLocalRequestHost } from './app-url';

export const SESSION_MAX_AGE_REMEMBER = 30 * 24 * 60 * 60;
export const SESSION_MAX_AGE_SESSION = 7 * 24 * 60 * 60;

export function shouldUseSecureCookie(opts: {
	/** Production build? Pass `import.meta.env.PROD` — never NODE_ENV, which
	 *  nothing sets in a Worker. */
	isProduction: boolean;
	appUrl?: string;
	requestHost?: string;
}): boolean {
	const appUrl = (opts.appUrl || '').trim();
	try {
		if (appUrl) {
			if (isLocalAppUrl(appUrl)) return false;
			if (new URL(appUrl).protocol !== 'https:') return false;
			return true;
		}
	} catch {
		/* fall through */
	}
	// One local-host rule for the whole app (see #lib/domain/app-url): this used
	// to carry its own list of three hostnames, which missed the LAN address a
	// dev server is reached by from a phone — where a Secure cookie over http is
	// silently dropped, and the sign-in with it.
	if (isLocalRequestHost(opts.requestHost)) return false;
	return opts.isProduction;
}

export function sessionMaxAgeSeconds(remember: boolean): number {
	return remember ? SESSION_MAX_AGE_REMEMBER : SESSION_MAX_AGE_SESSION;
}

export function shouldSlideSession(expiresAt: Date, now: Date, maxAgeSeconds: number): boolean {
	const remaining = expiresAt.getTime() - now.getTime();
	return remaining < (maxAgeSeconds * 1000) / 2;
}

export function nextSessionExpiry(now: Date, maxAgeSeconds: number): Date {
	return new Date(now.getTime() + maxAgeSeconds * 1000);
}

// Idle timeout: absolute sliding expiry is not enough — an active attacker
// with a stolen cookie stays signed in for 30 days. Sessions idle longer
// than this are destroyed on next use, regardless of expiresAt.
export const SESSION_IDLE_MS = 24 * 60 * 60_000;
// "Remember this browser" is a promise to survive a weekend away; a day would
// break it. A week still ends a session nobody is using.
export const SESSION_IDLE_REMEMBER_MS = 7 * 24 * 60 * 60_000;
// lastSeenAt writes are throttled: at most one extra D1 write per window
// of active use instead of one per request.
export const SESSION_SEEN_WRITE_MS = 15 * 60_000;

export function isSessionIdle(
	lastSeen: Date | null | undefined,
	now: Date,
	remember = false
): boolean {
	// A session with no `last_seen_at` predates the column. Treat it as idle:
	// there is no evidence it was used recently, and the alternative is letting
	// it outlive the password that minted it.
	if (!lastSeen) return true;
	const limit = remember ? SESSION_IDLE_REMEMBER_MS : SESSION_IDLE_MS;
	return now.getTime() - lastSeen.getTime() > limit;
}

export function shouldTouchSeen(lastSeen: Date | null | undefined, now: Date): boolean {
	if (!lastSeen) return true;
	return now.getTime() - lastSeen.getTime() > SESSION_SEEN_WRITE_MS;
}

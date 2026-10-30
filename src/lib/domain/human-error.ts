import { OAUTH_PENDING_TTL_MINUTES } from './oauth-pending';
import { isThreadsAuthFailure, isThreadsMediaFetchFailure } from './threads-error';

/**
 * The codes the OAuth callbacks redirect with. They are ours, not the
 * provider's, so echoing the raw value tells the reader nothing: an expired
 * connect attempt surfaced as the literal string "oauth_expired" above a
 * connection that had since succeeded.
 */
const OAUTH_CALLBACK_ERRORS: Record<string, string> = {
	oauth_expired: `That connect attempt expired — a connect link is good for ${OAUTH_PENDING_TTL_MINUTES} minutes. Press Connect new and try again.`,
	missing_code: 'The provider did not send an authorization code back. Start the connection again.',
	oauth_failed: 'Could not finish connecting — try again.'
};

/**
 * The fixed, user-facing copy for a failure we recognise, or null when the only
 * thing we would be doing is repeating the raw text back.
 *
 * `humanizeError` falls back to the raw text on purpose (a provider's message is
 * often the most useful thing the user can read), but `handleError` needs the
 * opposite for a 5xx: a driver or upstream message can carry SQL, table names or
 * response bodies. It uses this function and substitutes a plain failure.
 */
export function humanizedCause(raw: string | null | undefined): string | null {
	if (!raw) return null;
	const s = raw.toLowerCase();
	const oauthCode = OAUTH_CALLBACK_ERRORS[s.trim()];
	if (oauthCode) return oauthCode;
	if (
		s.includes('401') ||
		s.includes('unauthorized') ||
		s.includes('invalid credentials') ||
		s.includes('createsession failed') ||
		s.includes('need reconnect')
	) {
		return 'Account needs reconnect — password or token expired';
	}
	if (s.includes('403') || s.includes('forbidden')) {
		return 'The platform refused this post (permissions or policy)';
	}
	// Instagram's errors carry the same Meta marker, so they are told apart by
	// the provider's prefix before the Threads wording below can claim them.
	if (s.startsWith('instagram')) {
		if (isThreadsAuthFailure(s)) {
			return 'Instagram refused with a permissions error — reconnect the account and retry';
		}
		if (isThreadsMediaFetchFailure(s)) {
			return 'Instagram could not download the image — retry to publish it';
		}
	}
	// Meta permission failures are HTTP 400s, so the 401/403 branches never
	// match. Scoped to Threads wording (provider prefixes every message).
	if (isThreadsAuthFailure(s)) {
		return 'Threads refused with a permissions error — reconnect the account and retry';
	}
	// Meta could not download the image (its crawler is intermittent — the
	// same file has posted seconds later), so point at Retry, not at setup.
	if (isThreadsMediaFetchFailure(s)) {
		return 'Threads could not download the image — retry to publish it';
	}
	if (/threads (container|publish) failed \(4(?!29)\d/.test(s)) {
		return 'Threads could not create this post — check the post and the app setup, then retry';
	}
	if (s.includes('429') || s.includes('rate limit')) {
		return 'Rate limited — try again in a minute';
	}
	if (s.includes('already publishing')) {
		return 'Already publishing — wait for it to finish, then try again';
	}
	if (s.includes('already published')) {
		return 'Already published to this account';
	}
	if (s.includes('already scheduled')) {
		return 'Already scheduled — cancel or reschedule from Posts';
	}
	if (s.includes('scheduler') || s.includes('redis') || s.includes('queue')) {
		return 'Scheduler is delayed — scheduled posts will send on the next tick';
	}
	if (
		s.includes('timeout') ||
		s.includes('timed out') ||
		s.includes('econnrefused') ||
		s.includes('fetch failed') ||
		s.includes('enotfound')
	) {
		return 'Could not reach the network — check connection and try again';
	}
	if (s.includes('instance host') || s.includes('host not allowed')) {
		return 'That instance URL isn’t allowed';
	}
	return null;
}

export function humanizeError(raw: string | null | undefined): string {
	if (!raw) return 'Something went wrong';
	// Recognised failures get fixed copy; anything else is echoed, capped, so a
	// provider's own message still reaches the person who has to act on it.
	return humanizedCause(raw) ?? truncate(raw);
}

function truncate(raw: string): string {
	return raw.length > 180 ? raw.slice(0, 177) + '…' : raw;
}

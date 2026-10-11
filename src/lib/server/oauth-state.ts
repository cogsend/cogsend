import { timingSafeEqual, utf8Bytes } from '#lib/domain/bytes.js';
import { hmacHex } from './crypto';

/**
 * Bind an oauth_pending id to the session (or machine caller) that started
 * the flow, so the callback can prove the same party completes it.
 * Format: `<pendingId>.<hex hmac>`. No schema change needed.
 */
export async function bindOAuthState(opts: {
	secret: string;
	pendingId: string;
	sessionId: string;
}): Promise<string> {
	const sig = await hmacHex(opts.secret, `oauth-state:${opts.pendingId}:${opts.sessionId}`);
	return `${opts.pendingId}.${sig}`;
}

/** Split a bound state value into its pending id without verifying. */
export function splitOAuthState(state: string | null | undefined): string | null {
	if (!state) return null;
	const dot = state.indexOf('.');
	if (dot <= 0) return null;
	const pendingId = state.slice(0, dot);
	return pendingId || null;
}

/**
 * Verify a bound state value. Returns the pending id, or null when the state
 * is malformed, unsigned, or bound to a different session. A null sessionId
 * never verifies. Callers without a login cookie (machine/API-started flows)
 * should pass `machine:${pending.userId}` after loading the candidate row.
 */
export async function verifyOAuthState(opts: {
	secret: string;
	state: string | null | undefined;
	sessionId: string | null | undefined;
}): Promise<string | null> {
	if (!opts.state || !opts.sessionId) return null;
	const dot = opts.state.indexOf('.');
	if (dot <= 0) return null;
	const pendingId = opts.state.slice(0, dot);
	const sig = opts.state.slice(dot + 1);
	if (!pendingId || !sig) return null;
	const expected = await hmacHex(opts.secret, `oauth-state:${pendingId}:${opts.sessionId}`);
	const a = utf8Bytes(sig);
	const b = utf8Bytes(expected);
	if (a.length !== b.length) return null;
	return timingSafeEqual(a, b) ? pendingId : null;
}

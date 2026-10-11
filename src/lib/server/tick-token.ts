/**
 * The tick credential a self-hoster can hand to an external cron.
 *
 * The built-in cron needs no credential: it calls the tick in-process and
 * derives its own bearer from `APP_ENCRYPTION_KEY`. Anything calling over HTTP
 * does need one, and `SCHEDULER_SECRET` is a poor fit for that job: it cannot be
 * read from outside (so the operator has to invent and store one), and it
 * unlocks `/api/internal/publish` as well as the tick.
 *
 * So a second, deliberately narrow credential lives in `app_settings`:
 *
 *   - `tick_<64 hex>`, 256 bits from `crypto.getRandomValues`
 *   - stored as a domain-separated SHA-256 hash, never as the raw value
 *   - accepted by the hook for `POST /api/internal/tick` and nothing else
 *   - generated, rotated and revoked from Settings, so no redeploy is involved
 *
 * `SCHEDULER_SECRET` and `API_TOKEN` keep working exactly as before for anyone
 * already using them, and the built-in cron is unaffected either way.
 */
import { bytesToHex, randomHex, timingSafeEqual, utf8Bytes } from '#lib/domain/bytes.js';
import { readAppSetting, writeAppSetting } from './app-settings';
import type { AppDb } from './db/client';

export const TICK_TOKEN_PREFIX = 'tick_';
const RAW_HEX_LEN = 64;
/** Long enough to be unique per request path, short enough for a form field. */
const DISPLAY_PREFIX_LEN = TICK_TOKEN_PREFIX.length + 6;

const HASH_KEY = 'tick_token_hash';
const PREFIX_KEY = 'tick_token_prefix';
const CREATED_KEY = 'tick_token_created_at';

export function isTickTokenFormat(raw: string | null | undefined): raw is string {
	if (!raw?.startsWith(TICK_TOKEN_PREFIX)) return false;
	const hex = raw.slice(TICK_TOKEN_PREFIX.length);
	return hex.length === RAW_HEX_LEN && /^[0-9a-fA-F]+$/.test(hex);
}

/**
 * Domain-separated hash (`tick:`) so a tick token can never collide with an API
 * key hash (`apikey:`), a session or an MFA challenge even if raw values
 * repeat. Lookup is exact-match on the hash, so the 256-bit entropy is the
 * brute-force defense — the same pattern as API keys.
 */
export async function hashTickToken(raw: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', utf8Bytes(`tick:${raw}`) as BufferSource);
	return bytesToHex(new Uint8Array(digest));
}

interface TickTokenStatus {
	configured: boolean;
	prefix: string | null;
	createdAt: Date | null;
}

/** Metadata for Settings. The raw token is never stored, so it cannot be shown
 *  here: rotate to get a new one. */
export async function readTickToken(db: AppDb): Promise<TickTokenStatus> {
	const [hash, prefix, created] = await Promise.all([
		readAppSetting(db, HASH_KEY, { fresh: true }),
		readAppSetting(db, PREFIX_KEY, { fresh: true }),
		readAppSetting(db, CREATED_KEY, { fresh: true })
	]);
	if (!hash) return { configured: false, prefix: null, createdAt: null };
	const parsed = created ? new Date(created) : null;
	return {
		configured: true,
		prefix: prefix ?? `${TICK_TOKEN_PREFIX}…`,
		createdAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed : null
	};
}

/** Mint a token. Any previous one stops working — there is exactly one, so a
 *  lost or leaked token is replaced rather than accumulated. */
export async function rotateTickToken(
	db: AppDb
): Promise<{ token: string; prefix: string; createdAt: Date }> {
	const token = `${TICK_TOKEN_PREFIX}${randomHex(32)}`;
	const prefix = token.slice(0, DISPLAY_PREFIX_LEN);
	const createdAt = new Date();
	const hash = await hashTickToken(token);
	await writeAppSetting(db, HASH_KEY, hash);
	await writeAppSetting(db, PREFIX_KEY, prefix);
	await writeAppSetting(db, CREATED_KEY, createdAt.toISOString());
	return { token, prefix, createdAt };
}

/** Drop the token. Returns whether one existed. */
export async function revokeTickToken(db: AppDb): Promise<boolean> {
	const existing = await readTickToken(db);
	if (!existing.configured) return false;
	await writeAppSetting(db, HASH_KEY, '');
	await writeAppSetting(db, PREFIX_KEY, '');
	await writeAppSetting(db, CREATED_KEY, '');
	return true;
}

/**
 * Does this bearer belong to the stored tick token? Format-gated first so a
 * request carrying anything else costs no hashing and no D1 read.
 */
export async function verifyTickToken(db: AppDb, raw: string | null | undefined): Promise<boolean> {
	if (!isTickTokenFormat(raw)) return false;
	// Never from the isolate cache: a rotated or revoked token has to stop
	// working everywhere at once, not whenever other isolates happen to expire.
	const stored = await readAppSetting(db, HASH_KEY, { fresh: true });
	if (!stored) return false;
	const candidate = await hashTickToken(raw);
	// Both are 64-char hex digests; compare them without an early exit.
	return timingSafeEqual(utf8Bytes(stored), utf8Bytes(candidate));
}

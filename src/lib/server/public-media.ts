import { timingSafeEqual, utf8Bytes } from '#lib/domain/bytes.js';
import { hmacHex } from './crypto';

/** How long a publish-time media URL stays valid. Meta fetches within minutes. */
export const PUBLIC_MEDIA_TTL_MS = 2 * 60 * 60_000;
/** Upper bound accepted by the route, to keep leaked URLs short-lived. */
export const PUBLIC_MEDIA_MAX_TTL_MS = 24 * 60 * 60_000;

function messageFor(key: string, exp: number): string {
	return `media-public:${key}:${exp}`;
}

// Key separation: derive a dedicated HMAC sub-key instead of using
// APP_ENCRYPTION_KEY directly (that key also does AES-GCM + TOTP + OAuth).
// HMAC(secret, fixed-label) is a standard single-step KDF. Old URLs are
// invalidated on deploy — acceptable (2h TTL, re-minted at publish).
async function signingKey(secret: string): Promise<string> {
	return hmacHex(secret, 'subkey:media-url:v1');
}

export async function signPublicMediaUrl(
	secret: string,
	appUrl: string,
	storageKey: string,
	nowMs = Date.now()
): Promise<string> {
	const exp = nowMs + PUBLIC_MEDIA_TTL_MS;
	const sig = await hmacHex(await signingKey(secret), messageFor(storageKey, exp));
	return `${appUrl.replace(/\/$/, '')}/api/media/public/${encodeURIComponent(storageKey)}?exp=${exp}&sig=${sig}`;
}

export async function verifyPublicMediaSig(
	secret: string,
	storageKey: string,
	exp: number,
	sig: string,
	nowMs = Date.now()
): Promise<{ ok: true } | { ok: false; error: string }> {
	if (!Number.isInteger(exp) || exp <= nowMs) return { ok: false, error: 'URL expired' };
	if (exp - nowMs > PUBLIC_MEDIA_MAX_TTL_MS) return { ok: false, error: 'URL lifetime too long' };
	const expected = await hmacHex(await signingKey(secret), messageFor(storageKey, exp));
	const a = utf8Bytes(sig);
	const b = utf8Bytes(expected);
	if (a.length !== b.length || !timingSafeEqual(a, b)) {
		return { ok: false, error: 'Bad signature' };
	}
	return { ok: true };
}

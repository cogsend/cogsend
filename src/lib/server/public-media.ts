import { timingSafeEqual, utf8Bytes } from '#lib/domain/bytes.js';
import { hmacHex } from './crypto';

/** How long a publish-time media URL stays valid. Meta fetches within minutes. */
export const PUBLIC_MEDIA_TTL_MS = 2 * 60 * 60_000;
/** Upper bound accepted by the route, to keep leaked URLs short-lived. */
export const PUBLIC_MEDIA_MAX_TTL_MS = 24 * 60 * 60_000;

/**
 * A JPEG kept beside an original and served in its place: an image's JPEG
 * copy (Instagram takes nothing else) or a video's cover.
 */
export type PublicMediaVariant = 'jpeg' | 'cover';

export function isPublicMediaVariant(value: string): value is PublicMediaVariant {
	return value === 'jpeg' || value === 'cover';
}

// The variant is signed too, so a URL minted for one object cannot be pointed
// at another kept beside it.
function messageFor(key: string, exp: number, variant?: PublicMediaVariant): string {
	return variant ? `media-public:${key}:${variant}:${exp}` : `media-public:${key}:${exp}`;
}

// Key separation: derive a dedicated HMAC sub-key instead of using
// APP_ENCRYPTION_KEY directly (that key also does AES-GCM + TOTP + OAuth).
// HMAC(secret, fixed-label) is a standard single-step KDF.
async function signingKey(secret: string): Promise<string> {
	return hmacHex(secret, 'subkey:media-url:v1');
}

export async function signPublicMediaUrl(
	secret: string,
	appUrl: string,
	storageKey: string,
	nowMs = Date.now(),
	variant?: PublicMediaVariant
): Promise<string> {
	const exp = nowMs + PUBLIC_MEDIA_TTL_MS;
	const sig = await hmacHex(await signingKey(secret), messageFor(storageKey, exp, variant));
	const v = variant ? `&v=${variant}` : '';
	return `${appUrl.replace(/\/$/, '')}/api/media/public/${encodeURIComponent(storageKey)}?exp=${exp}${v}&sig=${sig}`;
}

export async function verifyPublicMediaSig(
	secret: string,
	storageKey: string,
	exp: number,
	sig: string,
	nowMs = Date.now(),
	variant?: PublicMediaVariant
): Promise<{ ok: true } | { ok: false; error: string }> {
	if (!Number.isInteger(exp) || exp <= nowMs) return { ok: false, error: 'URL expired' };
	if (exp - nowMs > PUBLIC_MEDIA_MAX_TTL_MS) return { ok: false, error: 'URL lifetime too long' };
	const expected = await hmacHex(await signingKey(secret), messageFor(storageKey, exp, variant));
	const a = utf8Bytes(sig);
	const b = utf8Bytes(expected);
	if (a.length !== b.length || !timingSafeEqual(a, b)) {
		return { ok: false, error: 'Bad signature' };
	}
	return { ok: true };
}

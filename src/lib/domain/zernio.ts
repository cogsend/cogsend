import type { PlatformId } from './platforms';

export const ZERNIO_API_BASE = 'https://zernio.com/api';
export const ZERNIO_API_KEYS_URL = 'https://zernio.com/dashboard/api-keys';
/** `oauth_pending.instance_url` value that marks a Zernio connect attempt. */
export const ZERNIO_PENDING_MARKER = 'zernio';

/** CogSend id → Zernio id. Mastodon is absent: Zernio does not support it. */
const TO_ZERNIO: Partial<Record<PlatformId, string>> = {
	x: 'twitter',
	threads: 'threads',
	instagram: 'instagram',
	linkedin: 'linkedin',
	bluesky: 'bluesky'
};

const FROM_ZERNIO: Record<string, PlatformId> = Object.fromEntries(
	Object.entries(TO_ZERNIO).map(([ours, theirs]) => [theirs, ours as PlatformId])
);

export function toZernioPlatform(platform: string): string | null {
	return TO_ZERNIO[platform as PlatformId] ?? null;
}

export function fromZernioPlatform(platform: string): PlatformId | null {
	return FROM_ZERNIO[platform] ?? null;
}

export function isZernioConnection(
	meta: string | Record<string, unknown> | null | undefined
): boolean {
	if (!meta) return false;
	let parsed: unknown = meta;
	if (typeof meta === 'string') {
		try {
			parsed = JSON.parse(meta);
		} catch {
			return false;
		}
	}
	return (
		typeof parsed === 'object' &&
		parsed !== null &&
		(parsed as { provider?: unknown }).provider === 'zernio'
	);
}

/** Zernio validates `x-request-id` as /^[\w.-]{1,128}$/; the pipeline key has a colon. */
export function zernioRequestId(key: string): string {
	return key.replace(/[^\w.-]/g, '-').slice(0, 128);
}

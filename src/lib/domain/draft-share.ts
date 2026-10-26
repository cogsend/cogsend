import { PLATFORM_ORDER, platformName, supportsThreads, type PlatformId } from './platforms';
import { joinThreadTexts, resolvePublishSegments, splitThreadSegments } from './thread-segments';

/** How long a preview link works unless the owner asks for another length. */
export const SHARE_DEFAULT_DAYS = 14;
export const SHARE_MAX_DAYS = 30;

const DAY_MS = 24 * 60 * 60_000;

/** A token is the hex of an HMAC-SHA-256, so anything else is refused before a lookup. */
export function isShareTokenFormat(value: string | null | undefined): value is string {
	return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export function sharePath(token: string): string {
	return `/p/${token}`;
}

/** Null when the requested length is not a whole number of days the link may last. */
export function shareLifetimeMs(days: unknown = SHARE_DEFAULT_DAYS): number | null {
	if (typeof days !== 'number' || !Number.isInteger(days)) return null;
	if (days < 1 || days > SHARE_MAX_DAYS) return null;
	return days * DAY_MS;
}

/**
 * Once anything has gone out, the preview has done its job and stops working.
 * A partial post counts: what a reviewer would be commenting on is already
 * public on at least one account.
 */
export function hasGoneOut(
	targets: ReadonlyArray<{ status?: string | null; remotePostId?: string | null }>
): boolean {
	return targets.some(
		(t) => t.status !== 'cancelled' && (t.status === 'published' || Boolean(t.remotePostId))
	);
}

export type ShareMedia = {
	id: string;
	storageKey: string;
	mime: string;
	width: number | null;
	height: number | null;
	altText: string | null;
	segmentIndex: number;
	meta: {
		cover?: { v?: number } | null;
		preview?: { v?: number } | null;
		durationMs?: number | null;
	} | null;
};

export type ShareCard = { text: string; media: ShareMedia[] };

export type ShareVersion = {
	/** `post` for the main text, otherwise the platform whose wording differs. */
	key: 'post' | PlatformId;
	label: string;
	cards: ShareCard[];
};

function threadCards(body: string, media: ShareMedia[]): ShareCard[] {
	return resolvePublishSegments(body, (i) => media.some((m) => m.segmentIndex === i)).map(
		({ text, segmentIndex }) => ({
			text,
			media: media.filter((m) => m.segmentIndex === segmentIndex)
		})
	);
}

/**
 * What the preview page shows: the main text as the post's cards, then one
 * version per platform whose text was customised. A platform without threads
 * gets the single post it would publish, with every attachment.
 */
export function shareVersions(input: {
	baseBody: string;
	variants: ReadonlyArray<{ platform: string; body: string | null }>;
	media: ShareMedia[];
}): ShareVersion[] {
	const versions: ShareVersion[] = [
		{ key: 'post', label: 'Post', cards: threadCards(input.baseBody, input.media) }
	];
	for (const platform of PLATFORM_ORDER) {
		const variant = input.variants.find((v) => v.platform === platform);
		// A variant with no body only carries options (Mastodon visibility, a
		// poll) and publishes the main text.
		if (!variant || variant.body === null) continue;
		const cards = supportsThreads(platform)
			? threadCards(variant.body, input.media)
			: [{ text: joinThreadTexts(splitThreadSegments(variant.body)), media: input.media }];
		versions.push({ key: platform, label: platformName(platform), cards });
	}
	return versions;
}

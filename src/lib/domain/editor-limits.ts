import { storedXLimit } from './x-limits';

/**
 * Character limits per platform, in one place. Mastodon's real limit is the
 * instance's own (`metaJson.maxCharacters`), and X's is the account's own
 * (280, or 25,000 on a paid plan), so these are their fallbacks.
 */
export const PLATFORM_LIMITS = {
	bluesky: 300,
	mastodon: 500,
	linkedin: 3000,
	threads: 500,
	instagram: 2200,
	x: 280
} as const;

export type LimitedPlatform = keyof typeof PLATFORM_LIMITS;

/** The accounts a limit is computed from: what the composer can actually reach. */
export interface LimitedAccount {
	platform: string;
	metaJson?: { maxCharacters?: number } | null;
}

/**
 * The strictest limit among the given accounts for one platform.
 *
 * Callers pass the *selected* accounts. Passing every connected one is the bug
 * this signature exists to prevent: an unselected 200-character Mastodon
 * instance used to cap a post bound for a 500-character one, blocking text the
 * target would have accepted.
 */
export function platformLimit(platform: string, accounts: LimitedAccount[]): number {
	const fallback = PLATFORM_LIMITS[platform as LimitedPlatform] ?? PLATFORM_LIMITS.mastodon;
	if (platform === 'x') {
		// An account with no stored limit (via Zernio, or connected before long
		// posts) is a 280 one, and one such account holds the whole post to it.
		const maxes = accounts
			.filter((account) => account.platform === 'x')
			.map((account) => storedXLimit(account.metaJson?.maxCharacters));
		return maxes.length ? Math.min(...maxes) : fallback;
	}
	if (platform !== 'mastodon') return fallback;
	const maxes = accounts
		.filter((account) => account.platform === 'mastodon')
		.map((account) => account.metaJson?.maxCharacters)
		.filter((n): n is number => typeof n === 'number' && n > 0);
	return maxes.length ? Math.min(...maxes) : fallback;
}

export function isOverSelectedPlatformLimit(params: {
	selectedPlatforms: Iterable<string>;
	blueskyLen: number;
	mastodonLen: number;
	blueskyMax?: number;
	mastodonMax?: number;
	linkedinLen?: number;
	linkedinMax?: number;
	threadsLen?: number;
	threadsMax?: number;
	instagramLen?: number;
	instagramMax?: number;
	xLen?: number;
	xMax?: number;
}): boolean {
	const selected = new Set(params.selectedPlatforms);
	const blueskyMax = params.blueskyMax ?? PLATFORM_LIMITS.bluesky;
	const mastodonMax = params.mastodonMax ?? PLATFORM_LIMITS.mastodon;
	const linkedinMax = params.linkedinMax ?? PLATFORM_LIMITS.linkedin;
	const threadsMax = params.threadsMax ?? PLATFORM_LIMITS.threads;
	const instagramMax = params.instagramMax ?? PLATFORM_LIMITS.instagram;
	const xMax = params.xMax ?? PLATFORM_LIMITS.x;
	if (selected.has('bluesky') && params.blueskyLen > blueskyMax) return true;
	if (selected.has('mastodon') && params.mastodonLen > mastodonMax) return true;
	if (selected.has('linkedin') && (params.linkedinLen ?? 0) > linkedinMax) return true;
	if (selected.has('threads') && (params.threadsLen ?? 0) > threadsMax) return true;
	if (selected.has('instagram') && (params.instagramLen ?? 0) > instagramMax) return true;
	if (selected.has('x') && (params.xLen ?? 0) > xMax) return true;
	return false;
}

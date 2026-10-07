export type PlatformId = 'mastodon' | 'bluesky' | 'linkedin' | 'threads' | 'x';

/** Canonical display order everywhere: X first, then Threads, LinkedIn, Mastodon, Bluesky. */
export const PLATFORM_ORDER: PlatformId[] = ['x', 'threads', 'linkedin', 'mastodon', 'bluesky'];

/** The same set, for validation and iteration. Derived so the platform list
 *  only has to be maintained in one place. */
export const PLATFORM_IDS: PlatformId[] = [...PLATFORM_ORDER];

export function isPlatformId(value: string): value is PlatformId {
	return (PLATFORM_IDS as string[]).includes(value);
}

/** Preview preference when several platforms apply (matches server capabilities). */
export const PREVIEW_PRIORITY: PlatformId[] = ['x', 'threads', 'linkedin', 'mastodon', 'bluesky'];

/** Sort rank for a platform id; unknown platforms sink to the end, stable. */
export function platformRank(platform: string): number {
	const i = (PLATFORM_ORDER as string[]).indexOf(platform);
	return i === -1 ? 99 : i;
}

/** Whether a platform supports multi-post threads (mirrors provider capabilities). */
export function supportsThreads(platform: string): boolean {
	if (!isPlatformId(platform)) return true;
	return (
		platform === 'mastodon' || platform === 'bluesky' || platform === 'x' || platform === 'threads'
	);
}

export function platformName(p: string): string {
	if (p === 'linkedin') return 'LinkedIn';
	if (p === 'x') return 'X';
	return p.charAt(0).toUpperCase() + p.slice(1);
}

/** "Threads, Mastodon and Bluesky". */
export function platformNames(platforms: string[]): string {
	const names = platforms.map((p) => platformName(p));
	if (names.length <= 1) return names[0] ?? '';
	return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Short display form of an account handle. Only the generic `.bsky.social`
 * suffix is stripped (custom domains stay full); everything else is
 * untouched. The stored handle is still the full value for API use.
 */
export function displayHandle(handle: string | null | undefined): string {
	if (!handle) return '';
	return handle.replace(/\.bsky\.social$/i, '');
}

/** Display form of an instance URL: protocol and trailing slash removed. */
export function displayHost(url: string | null | undefined): string {
	if (!url) return '';
	return url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

/**
 * One-line account label (`Name · handle`). Duplicates collapse to the
 * single full value, and a handle that repeats the name is omitted. Pass
 * `instanceUrl` (Mastodon) to qualify bare usernames to their globally
 * unique @user@host form. Compact surfaces without a name use
 * displayHandle instead.
 */
export function accountLabel(
	displayName: string | null | undefined,
	handle: string | null | undefined,
	instanceUrl?: string | null
): string {
	const host = displayHost(instanceUrl);
	const short = displayHandle(handle);
	const id = host && short && !short.includes('@') ? `@${short}@${host}` : short;
	if (displayName && handle && displayName === handle)
		return host ? id || displayName : displayName;
	if (displayName) {
		if (!id || id.toLowerCase() === displayName.toLowerCase()) return displayName;
		return `${displayName} · ${id}`;
	}
	return id || handle || '';
}

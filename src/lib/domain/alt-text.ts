import type { PlatformId } from './platforms';
import { platformName } from './platforms';

/** What CogSend stores; the server cuts anything longer. */
export const MAX_ALT_LENGTH = 1500;

/**
 * Platforms that keep less than CogSend stores. The providers cut to these, so
 * the composer can say so before it happens. Mastodon's default is the stored
 * cap itself, and LinkedIn's (4,086) is never reached.
 */
export const ALT_LIMITS = { x: 1000, instagram: 1000 } as const;

function limitOf(platform: PlatformId): number | undefined {
	return (ALT_LIMITS as Partial<Record<PlatformId, number>>)[platform];
}

export type AltKind = 'image' | 'video';

/** An account a post goes to, as far as alt text is concerned. */
export type AltDestination = { platform: PlatformId; viaZernio: boolean };

/**
 * Whether this account's post carries the description at all, as each
 * provider sends it: Threads takes it on video only, LinkedIn and Instagram on
 * images only (not LinkedIn video or Reels). Zernio takes it on everything.
 */
export function altReaches(destination: AltDestination, kind: AltKind): boolean {
	if (destination.viaZernio) return true;
	switch (destination.platform) {
		case 'threads':
			return kind === 'video';
		case 'linkedin':
		case 'instagram':
			return kind === 'image';
		default:
			return true;
	}
}

/**
 * "X and Instagram keep the first 1,000 characters" when the description is
 * longer than a platform it reaches keeps, else null.
 */
export function altCutNote(
	length: number,
	kind: AltKind,
	destinations: AltDestination[]
): string | null {
	const cuts = new Map<number, Set<PlatformId>>();
	for (const d of destinations) {
		const limit = limitOf(d.platform);
		if (limit === undefined || length <= limit || !altReaches(d, kind)) continue;
		cuts.set(limit, (cuts.get(limit) ?? new Set()).add(d.platform));
	}
	if (!cuts.size) return null;
	const limit = Math.min(...cuts.keys());
	const names = [...cuts.get(limit)!].map(platformName);
	const who =
		names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
	return `${who} ${names.length === 1 ? 'keeps' : 'keep'} the first ${limit.toLocaleString('en-US')} characters`;
}

/** The smallest limit among the accounts this description reaches, if any. */
export function altLimitFor(kind: AltKind, destinations: AltDestination[]): number | null {
	let least: number | null = null;
	for (const d of destinations) {
		const limit = limitOf(d.platform);
		if (limit === undefined || !altReaches(d, kind)) continue;
		least = least === null ? limit : Math.min(least, limit);
	}
	return least;
}

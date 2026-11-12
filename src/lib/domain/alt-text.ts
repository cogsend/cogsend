import type { PlatformId } from './platforms';
import { platformName } from './platforms';
import { plural } from './plural';

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

export type AltItem = { id: string; kind: AltKind; altText: string | null; segmentIndex: number };
export type MissingAlt = AltItem & { position: number };

/**
 * Media without a description that at least one account would have shown one
 * for, in the order of the posts and of the files in each. `position` counts
 * from 1 within its post.
 */
export function missingAlt(items: AltItem[], destinations: AltDestination[]): MissingAlt[] {
	const missing: MissingAlt[] = [];
	const seen = new Map<number, number>();
	const ordered = items
		.map((item, at) => ({ item, at }))
		.sort((a, b) => a.item.segmentIndex - b.item.segmentIndex || a.at - b.at);
	for (const { item } of ordered) {
		const position = (seen.get(item.segmentIndex) ?? 0) + 1;
		seen.set(item.segmentIndex, position);
		if ((item.altText ?? '').trim()) continue;
		if (!destinations.some((d) => altReaches(d, item.kind))) continue;
		missing.push({ ...item, position });
	}
	return missing;
}

/** "Image 2 in post 1 has no alt text", or a count when there are several. */
export function missingAltMessage(missing: MissingAlt[], posts: number): string | null {
	if (!missing.length) return null;
	if (missing.length === 1) {
		const [m] = missing;
		const name = `${m.kind === 'video' ? 'The video' : `Image ${m.position}`}`;
		const where = posts > 1 ? ` in post ${m.segmentIndex + 1}` : '';
		return `${name}${where} has no alt text`;
	}
	const images = missing.filter((m) => m.kind === 'image').length;
	const videos = missing.length - images;
	const parts = [
		images ? plural(images, 'image', 'images') : '',
		videos ? plural(videos, 'video', 'videos') : ''
	].filter(Boolean);
	return `${parts.join(' and ')} have no alt text`;
}

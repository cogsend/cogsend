import { PREVIEW_PRIORITY } from './platforms';
export const THREAD_DELIMITER = '\n---\n';

export function splitThreadSegments(body: string): string[] {
	if (body == null || body === '') return [''];
	// Pasted Windows text uses \r\n: normalize or the delimiter never matches
	// and a whole thread collapses into one card.
	const normalized = body.replace(/\r\n/g, '\n');
	if (!normalized.includes(THREAD_DELIMITER)) return [normalized];
	return normalized.split(THREAD_DELIMITER);
}

export function resolvePublishSegments(
	body: string,
	segmentHasMedia: (segmentIndex: number) => boolean
): Array<{ text: string; segmentIndex: number }> {
	const editorSegs = splitThreadSegments(body);
	const out: Array<{ text: string; segmentIndex: number }> = [];
	for (let i = 0; i < editorSegs.length; i++) {
		const text = (editorSegs[i] ?? '').trim();
		if (text || segmentHasMedia(i)) {
			out.push({ text, segmentIndex: i });
		}
	}
	if (out.length === 0) return [{ text: '', segmentIndex: 0 }];
	return out;
}

export function joinThreadSegments(segments: string[]): string {
	if (!segments.length) return '';
	if (segments.length === 1) return segments[0] ?? '';
	return segments.join(THREAD_DELIMITER);
}

/**
 * Flatten segment texts into one post (LinkedIn has no threads): trimmed,
 * non-empty texts joined by a blank line, matching the composer preview.
 */
export function joinThreadTexts(texts: Array<string | null | undefined>): string {
	return texts
		.map((t) => (t ?? '').trim())
		.filter(Boolean)
		.join('\n\n');
}

/** Body-level flatten for single-post previews and character counters. */
export function flattenThreadBody(body: string): string {
	return joinThreadTexts(splitThreadSegments(body));
}

// Max over the same segments the preview cards show (untrimmed, empties kept),
// so footer counters always agree with the cards. Publishing filters empty
// segments itself, in resolvePublishSegments below.
export function maxThreadSegmentLength(body: string, countFn: (segment: string) => number): number {
	const segs = splitThreadSegments(body);
	let max = 0;
	for (const s of segs) {
		const n = countFn(s);
		if (n > max) max = n;
	}
	return max;
}

export function updateSegment(segments: string[], index: number, text: string): string[] {
	if (index < 0 || index >= segments.length) return segments;
	const next = segments.slice();
	next[index] = text;
	return next;
}

export function addSegment(segments: string[]): string[] {
	return [...segments, ''];
}

export function removeSegment(segments: string[], index: number): string[] {
	if (segments.length <= 1) return [''];
	if (index < 0 || index >= segments.length) return segments;
	return segments.filter((_, i) => i !== index);
}

export type PreviewPlatform = 'mastodon' | 'bluesky' | 'linkedin' | 'threads' | 'x' | 'generic';

export type PreviewIdentity = {
	platform: PreviewPlatform;
	displayName: string;
	handle: string;
	avatarUrl?: string | null;
};

export type PreviewModel = {
	platform: PreviewIdentity['platform'];
	identity: PreviewIdentity;
	segments: string[];
	charLimits: { max: number; mode: 'grapheme' | 'mastodon-weighted' };
};

const FALLBACK_HANDLES: Record<string, string> = {
	mastodon: '@you@mastodon.social',
	bluesky: 'you.bsky.social',
	linkedin: 'you',
	threads: '@you',
	x: '@you'
};

const PREVIEW_LIMITS: Record<string, { max: number; mode: 'grapheme' | 'mastodon-weighted' }> = {
	bluesky: { max: 300, mode: 'grapheme' },
	linkedin: { max: 3000, mode: 'grapheme' },
	threads: { max: 500, mode: 'grapheme' },
	x: { max: 280, mode: 'grapheme' }
};

export function buildPreviewModel(opts: {
	platform: 'main' | 'mastodon' | 'bluesky' | 'linkedin' | 'threads' | 'x';
	body: string;
	connections: Array<{
		platform: string;
		displayName?: string | null;
		handle?: string | null;
		avatarUrl?: string | null;
	}>;
	mastodonMax?: number;
}): PreviewModel {
	const segments = splitThreadSegments(opts.body);
	let plat: PreviewPlatform;
	if (opts.platform === 'main') {
		plat =
			(PREVIEW_PRIORITY.find((p) =>
				opts.connections.some((c) => c.platform === p)
			) as PreviewPlatform) ?? 'generic';
	} else {
		plat = opts.platform;
	}

	const conn =
		plat === 'generic' ? null : (opts.connections.find((c) => c.platform === plat) ?? null);

	const identity: PreviewIdentity = {
		platform: plat,
		displayName: conn?.displayName || conn?.handle || 'You',
		handle: conn?.handle || FALLBACK_HANDLES[plat] || '@you',
		avatarUrl: conn?.avatarUrl
	};

	const preset = PREVIEW_LIMITS[plat];
	return {
		platform: plat,
		identity,
		segments,
		charLimits: preset ?? { max: opts.mastodonMax ?? 500, mode: 'mastodon-weighted' }
	};
}

/** Move one segment to a new index; other segments shift to fill the gap. */
export function reorderSegments(segments: string[], from: number, to: number): string[] {
	if (from === to) return segments;
	if (from < 0 || from >= segments.length || to < 0 || to >= segments.length) return segments;
	const next = segments.slice();
	const [moved] = next.splice(from, 1);
	next.splice(to, 0, moved ?? '');
	return next;
}

/** What a person types inside a card to split it there. */
export const SPLIT_MARKER = '---';

/**
 * The cards a card's text becomes when it contains the split marker, or null
 * when it contains none. Every marker splits and every piece is kept: a paste
 * can carry several markers, and none of the text around them may be lost.
 */
export function splitAtMarkers(value: string): string[] | null {
	if (!value.includes(SPLIT_MARKER)) return null;
	return value.split(SPLIT_MARKER).map((piece) => piece.trim());
}

/** Where a media item on segment `index` lands after `added` cards are inserted after card `at`. */
export function remapSegmentIndexAfterInsert(index: number, at: number, added: number): number {
	return index > at ? index + added : index;
}

/**
 * Where a media item on segment `index` lands after moving `from` → `to`.
 * Pure math (no bounds surprises): mirrors reorderSegments exactly.
 */
export function remapSegmentIndexAfterReorder(index: number, from: number, to: number): number {
	if (index === from) return to;
	if (from < to && index > from && index <= to) return index - 1;
	if (from > to && index >= to && index < from) return index + 1;
	return index;
}

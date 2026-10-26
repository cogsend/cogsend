/**
 * How attached media are framed in the composer and on Posts: one item at its
 * own shape, several photos in the grid X uses, all inside a height cap so a
 * phone video does not become a full-width tower.
 */

export type MediaShape = {
	storageKey: string;
	mime?: string | null;
	width?: number | null;
	height?: number | null;
	meta?: {
		cover?: { v?: number } | null;
		preview?: { v?: number } | null;
		durationMs?: number | null;
	} | null;
};

/** Until an item reports its size it is framed as 16:9, the common case for both. */
export const FALLBACK_ASPECT = 16 / 9;

// Past these, a panorama or a screenshot of a long page would be a sliver;
// the frame stops there and the item letterboxes inside it.
const MIN_ASPECT = 1 / 2;
const MAX_ASPECT = 3;

export function isVideoMedia(m: { mime?: string | null }): boolean {
	return (m.mime || '').toLowerCase().startsWith('video/');
}

export function aspectOf(m: { width?: number | null; height?: number | null }): number | null {
	return m.width && m.height && m.width > 0 && m.height > 0 ? m.width / m.height : null;
}

/**
 * The frame for one item: the card's full width at `aspect`, narrowed so its
 * height stays within `maxHeight`. The caller sets
 * `width: min(100%, maxWidth px)` and `aspect-ratio`.
 */
export function frameFor(
	aspect: number | null,
	maxHeight: number
): { aspect: number; maxWidth: number } {
	const a = Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, aspect ?? FALLBACK_ASPECT));
	return { aspect: a, maxWidth: Math.round(maxHeight * a) };
}

export type GridCell = { column: string; row: string };

/**
 * Where each of 2–4 photos sits in a two-column grid: two side by side, three
 * as one tall and two stacked, four as two by two.
 */
export function gridFor(count: number): { rows: number; cells: GridCell[] } {
	if (count <= 1) return { rows: 1, cells: [{ column: '1 / 3', row: '1 / 2' }] };
	if (count === 2) {
		return {
			rows: 1,
			cells: [
				{ column: '1 / 2', row: '1 / 2' },
				{ column: '2 / 3', row: '1 / 2' }
			]
		};
	}
	if (count === 3) {
		return {
			rows: 2,
			cells: [
				{ column: '1 / 2', row: '1 / 3' },
				{ column: '2 / 3', row: '1 / 2' },
				{ column: '2 / 3', row: '2 / 3' }
			]
		};
	}
	return {
		rows: 2,
		cells: [
			{ column: '1 / 2', row: '1 / 2' },
			{ column: '2 / 3', row: '1 / 2' },
			{ column: '1 / 2', row: '2 / 3' },
			{ column: '2 / 3', row: '2 / 3' }
		]
	};
}

/** The signed-in media route; a preview link serves the same files from its own. */
export const MEDIA_BASE = '/api/media';

export function mediaUrl(m: { storageKey: string }, base = MEDIA_BASE): string {
	return `${base}/${encodeURIComponent(m.storageKey)}`;
}

/** What to show for an image: its smaller copy when the composer made one, else the original. */
export function imageUrl(m: MediaShape, base = MEDIA_BASE): string {
	const v = m.meta?.preview?.v;
	return v ? `${mediaUrl(m, base)}?preview=${v}` : mediaUrl(m, base);
}

/** A video's chosen cover, versioned so a new one is not served from cache. */
export function coverUrl(m: MediaShape, base = MEDIA_BASE): string | null {
	const v = m.meta?.cover?.v;
	return v ? `${mediaUrl(m, base)}?cover=${v}` : null;
}

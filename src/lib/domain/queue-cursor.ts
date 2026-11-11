/**
 * Posts keeps two places in the queue: how far it has read the posts still
 * waiting (Scheduled), and how far back it has read history (Published,
 * Failed), so either tab can load more without walking through the other.
 */
export type QueueCursors = { waiting: string | null; history: string | null };

/** A history cursor later than every row: the next page is history from its newest. */
export const ALL_HISTORY = `${Number.MAX_SAFE_INTEGER}:~`;

const isWaiting = (next: string) => next.startsWith('u:');

/** From the first page's `next`. */
export function firstQueueCursors(next: string | null | undefined): QueueCursors {
	if (!next) return { waiting: null, history: null };
	return isWaiting(next)
		? { waiting: next, history: ALL_HISTORY }
		: { waiting: null, history: next };
}

/**
 * After reading on from `waiting`: a page that runs out of waiting rows goes
 * on into history from its newest, so where it stopped is the history cursor
 * too, unless history was already read further on its own.
 */
export function afterWaitingPage(
	cursors: QueueCursors,
	next: string | null | undefined
): QueueCursors {
	if (next && isWaiting(next)) return { ...cursors, waiting: next };
	return {
		waiting: null,
		history: cursors.history === ALL_HISTORY ? (next ?? null) : cursors.history
	};
}

/** After reading back from `history`. */
export function afterHistoryPage(
	cursors: QueueCursors,
	next: string | null | undefined
): QueueCursors {
	return { ...cursors, history: next ?? null };
}

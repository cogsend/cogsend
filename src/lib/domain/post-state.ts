import { STALE_CLAIM_MS, isFreshPublishing } from './due-jobs';
import { PROCESSING_MARK } from './video-rules';

/**
 * A publish target as the composer receives it. Loose on purpose: the page
 * load hands over Date objects and the draft API ISO strings.
 */
export type TargetSnapshot = {
	id?: string | null;
	connectionId?: string | null;
	status?: string | null;
	scheduledFor?: unknown;
	remotePostId?: string | null;
	errorMessage?: string | null;
	jobId?: string | null;
	updatedAt?: unknown;
	/** The account as the draft API attaches it, for naming one since removed. */
	connection?: { platform: string; handle?: string | null } | null;
};

export type WaitingTarget = {
	targetId: string | null;
	connectionId: string;
	/** When it is due; null when no usable time is stored. */
	at: Date | null;
	/** Due now: a publish left it for the next scheduler run. */
	queued: boolean;
	/** A retryable failure backing off; `at` is the next attempt. */
	retrying: boolean;
	error: string | null;
};

export type PostState = {
	published: string[];
	sending: string[];
	/**
	 * Parked while the platform processes a video. It publishes on its own, so
	 * it is neither waiting for a time nor something to change or unschedule.
	 */
	processing: string[];
	waiting: WaitingTarget[];
	failed: Array<{ connectionId: string; error: string | null }>;
	/** Earliest waiting time; a queued target counts as now. */
	nextAt: Date | null;
};

function toDate(value: unknown): Date | null {
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
	if (typeof value !== 'string' && typeof value !== 'number') return null;
	if (value === '') return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function isPublished(t: TargetSnapshot): boolean {
	return t.status === 'published' || Boolean(t.remotePostId);
}

/**
 * The server's in-flight rule (`draftHasInFlightPublish`): a queued claim or a
 * fresh `publishing` row. While any target matches, the server refuses edits.
 */
export function isTargetSending(t: TargetSnapshot, now: Date = new Date()): boolean {
	const updated = toDate(t.updatedAt);
	// A queue tag whose consumer never ran is re-tagged after STALE_CLAIM_MS;
	// until then it is sending, after that it is waiting like any other row.
	if (t.jobId) return !updated || now.getTime() - updated.getTime() < STALE_CLAIM_MS;
	return isFreshPublishing(
		{ status: t.status ?? '', updatedAt: updated, remotePostId: t.remotePostId ?? null },
		now
	);
}

/**
 * Where a post stands, one class per account. An account can hold several
 * rows (a cancelled sibling, an old attempt), so the strongest wins: what went
 * out, then what is going out, then what is still to go, then what failed.
 */
export function summarizePost(
	targets: ReadonlyArray<TargetSnapshot> | null | undefined,
	now: Date = new Date()
): PostState {
	const byConnection = new Map<string, TargetSnapshot[]>();
	for (const t of targets ?? []) {
		if (!t.connectionId || t.status === 'cancelled') continue;
		const rows = byConnection.get(t.connectionId);
		if (rows) rows.push(t);
		else byConnection.set(t.connectionId, [t]);
	}
	const state: PostState = {
		published: [],
		sending: [],
		processing: [],
		waiting: [],
		failed: [],
		nextAt: null
	};
	for (const [connectionId, rows] of byConnection) {
		if (rows.some(isPublished)) {
			state.published.push(connectionId);
			continue;
		}
		if (rows.some((t) => isTargetSending(t, now))) {
			state.sending.push(connectionId);
			continue;
		}
		// A stale `publishing` row is one the scheduler re-queues, not a failure.
		const waiting = rows.find(
			(t) => t.status === 'scheduled' || t.status === 'pending' || t.status === 'publishing'
		);
		if (waiting?.status === 'scheduled' && (waiting.errorMessage ?? '').includes(PROCESSING_MARK)) {
			state.processing.push(connectionId);
			continue;
		}
		if (waiting) {
			const queued = waiting.status !== 'scheduled';
			const at = queued ? null : toDate(waiting.scheduledFor);
			state.waiting.push({
				targetId: waiting.id ?? null,
				connectionId,
				at,
				queued,
				retrying: waiting.status === 'scheduled' && Boolean(waiting.errorMessage),
				error: waiting.errorMessage ?? null
			});
			const due = queued ? now : at;
			if (due && (!state.nextAt || due.getTime() < state.nextAt.getTime())) state.nextAt = due;
			continue;
		}
		const failed = rows.find((t) => t.status === 'failed');
		if (failed) state.failed.push({ connectionId, error: failed.errorMessage ?? null });
	}
	return state;
}

/** How a finished post went, across the accounts it was sent to. */
export type CardOutcome = {
	kind: 'published' | 'partial' | 'failed';
	/** Accounts it went out on. */
	published: number;
	/** Accounts it was sent to and that have finished, either way. */
	total: number;
};

/**
 * A post that went out on some accounts and failed on others is neither: it
 * needs a retry, and it was also published. Rows still waiting or cancelled do
 * not count, so this only describes what has finished.
 */
export function cardOutcome(rows: ReadonlyArray<{ status?: string | null }>): CardOutcome | null {
	const published = rows.filter((r) => r.status === 'published').length;
	const failed = rows.filter((r) => r.status === 'failed').length;
	if (!published && !failed) return null;
	const kind = !failed ? 'published' : published ? 'partial' : 'failed';
	return { kind, published, total: published + failed };
}

/**
 * How the ticked accounts differ from what is scheduled. The scheduler reads
 * the targets, not the selection, so until the schedule is updated a removed
 * account still posts and an added one does not. Published and sending
 * accounts are settled either way and never count.
 */
export function selectionDrift(
	state: PostState,
	selected: Iterable<string>
): { added: string[]; removed: string[] } {
	if (!state.waiting.length) return { added: [], removed: [] };
	const ticked = new Set(selected);
	const waiting = new Set(state.waiting.map((w) => w.connectionId));
	const settled = new Set([...state.published, ...state.sending]);
	return {
		added: [...ticked].filter((id) => !waiting.has(id) && !settled.has(id)),
		removed: [...waiting].filter((id) => !ticked.has(id))
	};
}

import { humanizeError } from '#lib/domain/human-error.js';
import { summarizePost, type TargetSnapshot } from '#lib/domain/post-state.js';
import {
	mayUnscheduleOthers,
	outcomeOfRow,
	summarizeProgress,
	summarizePublish,
	type DestinationOutcome,
	type PublishRow
} from '#lib/domain/publish-outcome.js';
import { announce, showToast } from './toast.svelte.js';

/**
 * Publishes the composer has handed off. They run here, outside any page, so
 * the composer can clear for the next post the moment Publish is confirmed and
 * the result still arrives as a toast wherever the person has gone since.
 * Leaving the tab only stops the browser waiting: the server finishes each
 * publish on its own, and Posts shows how it went.
 */
export const publishActivity = $state({
	/** Publishes still waiting for an answer. */
	inFlight: 0,
	/** Bumped as each one settles, so Posts can re-read. */
	version: 0,
	/** Something failed and Posts has not been opened since. */
	unseenFailure: false
});

export function markPublishSeen() {
	publishActivity.unseenFailure = false;
}

async function publishOne(draftId: string, connectionId: string): Promise<DestinationOutcome> {
	try {
		const res = await fetch(`/api/drafts/${draftId}/publish`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ connectionIds: [connectionId] })
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error || 'Publish failed');
		return outcomeOfRow(connectionId, (data.results || [])[0] as PublishRow | undefined);
	} catch (e) {
		const message = humanizeError(e instanceof Error ? e.message : 'Publish failed');
		return { connectionId, status: 'failed', error: message };
	}
}

/** Unschedule every account still waiting on the post except `keep`. */
export async function cancelWaitingExcept(
	draftId: string,
	keep: string[],
	fallback: TargetSnapshot[] = []
): Promise<{ cancelled: string[]; kept: string[] }> {
	let list: TargetSnapshot[] = fallback;
	try {
		const res = await fetch(`/api/drafts/${encodeURIComponent(draftId)}`);
		const data = res.ok ? await res.json().catch(() => null) : null;
		if (Array.isArray(data?.draft?.targets)) list = data.draft.targets;
	} catch {
		// Fall back to the caller's copy of the targets.
	}
	const waiting = summarizePost(list)
		.waiting.filter((w) => !keep.includes(w.connectionId) && w.targetId)
		.map((w) => ({ targetId: w.targetId as string, connectionId: w.connectionId }));
	const cancelled: string[] = [];
	const kept: string[] = [];
	// The bulk route takes ten ids per request.
	for (let i = 0; i < waiting.length; i += 10) {
		const chunk = waiting.slice(i, i + 10);
		let results: Array<{ id: string; ok: boolean }> = [];
		try {
			const res = await fetch('/api/targets/bulk', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ op: 'cancel', ids: chunk.map((w) => w.targetId) })
			});
			const data = await res.json().catch(() => ({}));
			if (res.ok && Array.isArray(data.results)) results = data.results;
		} catch {
			// Reported as still scheduled.
		}
		for (const w of chunk) {
			if (results.some((r) => r.id === w.targetId && r.ok)) cancelled.push(w.connectionId);
			else kept.push(w.connectionId);
		}
	}
	return { cancelled, kept };
}

/**
 * Publish to every destination in parallel, one request each, so each send
 * keeps its own Worker call budget. Returns at once; the outcome is a toast.
 */
export function handOff(opts: {
	draftId: string;
	connectionIds: string[];
	/** Names as the composer knew them; it may be gone when the answers come. */
	nameOf: (connectionId: string) => string;
	/** Accounts still scheduled that were left unticked: publishing now replaces their schedule. */
	unscheduleOthers: boolean;
	targets: TargetSnapshot[];
}): Promise<void> {
	const { draftId, connectionIds, nameOf } = opts;
	publishActivity.inFlight++;
	announce(
		`Publishing to ${connectionIds.length} ${connectionIds.length === 1 ? 'account' : 'accounts'}.`
	);
	return (async () => {
		try {
			const settled: DestinationOutcome[] = [];
			const outcomes = await Promise.all(
				connectionIds.map((id) =>
					publishOne(draftId, id).then((outcome) => {
						settled.push(outcome);
						if (outcome.status === 'failed') publishActivity.unseenFailure = true;
						// Posts shows each account's result as it lands, not after the slowest.
						publishActivity.version++;
						const waiting = connectionIds.filter((c) => !settled.some((o) => o.connectionId === c));
						const progress = summarizeProgress(settled, waiting, nameOf);
						if (progress) {
							showToast(progress.message, progress.tone, progress.action);
							announce(progress.announcement);
						}
						return outcome;
					})
				)
			);
			let note = '';
			let noteKept = false;
			if (opts.unscheduleOthers && mayUnscheduleOthers(outcomes)) {
				const { cancelled, kept } = await cancelWaitingExcept(draftId, connectionIds, opts.targets);
				noteKept = kept.length > 0;
				note =
					(cancelled.length ? ` · unscheduled on ${cancelled.map(nameOf).join(', ')}` : '') +
					(kept.length ? ` · ${kept.map(nameOf).join(', ')} still scheduled` : '');
			}
			const summary = summarizePublish(outcomes, nameOf, { note, noteKept });
			if (outcomes.some((o) => o.status === 'failed')) publishActivity.unseenFailure = true;
			showToast(summary.message, summary.tone, summary.action);
			announce(summary.announcement);
		} finally {
			publishActivity.inFlight--;
			publishActivity.version++;
		}
	})();
}

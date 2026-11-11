import { humanizeError } from './human-error';
import { PROCESSING_MARK } from './video-rules';

/** How one destination's publish request came back. */
export type DestinationOutcome = {
	connectionId: string;
	/**
	 * `retrying` = left for the scheduler: a retryable failure backing off, a
	 * video the platform is still processing, or work deferred to the next tick.
	 * `cancelled` = cancelled while the request was on its way; nothing was sent.
	 */
	status: 'published' | 'publishing' | 'retrying' | 'failed' | 'cancelled';
	error: string | null;
	processing?: boolean;
	/** Published before this attempt: the server skipped it, nothing was sent. */
	already?: boolean;
};

export type PublishRow = {
	status?: string;
	error?: string | null;
	deferred?: boolean;
	skipped?: boolean;
};

/** One row of `POST /api/drafts/:id/publish`, as the composer reports it. */
export function outcomeOfRow(
	connectionId: string,
	row: PublishRow | undefined
): DestinationOutcome {
	if (!row) return { connectionId, status: 'failed', error: 'Publish failed' };
	// The platform took this request's post, but another run had claimed the
	// row by the time it could say so. A failure here would invite a Retry that
	// posts it twice.
	if (row.status === 'preempted') return { connectionId, status: 'published', error: null };
	if (row.status === 'cancelled') return { connectionId, status: 'cancelled', error: null };
	if (row.status === 'published') {
		return { connectionId, status: 'published', error: null, already: row.skipped === true };
	}
	if (row.status === 'publishing') return { connectionId, status: 'publishing', error: null };
	if (row.deferred) {
		// The request's call budget ran short: it is on its way, not failed.
		return {
			connectionId,
			status: 'retrying',
			error: 'Queued — goes out on the next scheduler tick'
		};
	}
	if (row.status === 'scheduled') {
		const processing = (row.error ?? '').includes(PROCESSING_MARK);
		return {
			connectionId,
			status: 'retrying',
			error: processing ? (row.error ?? '') : humanizeError(row.error ?? 'Retrying automatically'),
			processing
		};
	}
	return { connectionId, status: 'failed', error: humanizeError(row.error ?? 'Publish failed') };
}

export type PublishSummary = {
	message: string;
	tone: 'success' | 'warn' | 'error';
	action: { label: string; href: string } | null;
	/** The same news for screen readers. */
	announcement: string;
};

/**
 * Publishing now replaces the schedule, so accounts left unticked must not
 * still post later; but only once the post is on its way everywhere it was
 * sent, so a failed publish never also loses the rest of the schedule.
 */
export function mayUnscheduleOthers(outcomes: DestinationOutcome[]): boolean {
	return !outcomes.some(
		(o) => o.status === 'failed' || o.status === 'publishing' || o.status === 'cancelled'
	);
}

/**
 * The one toast a publish ends with. `note` is what unscheduling the accounts
 * left unticked did (`· unscheduled on …`); `noteKept` is true when one of
 * them could not be unscheduled.
 */
export function summarizePublish(
	outcomes: DestinationOutcome[],
	nameOf: (connectionId: string) => string,
	opts: { note?: string; noteKept?: boolean } = {}
): PublishSummary {
	const failed = outcomes.filter((o) => o.status === 'failed');
	const published = outcomes.filter((o) => o.status === 'published');
	const inFlight = outcomes.filter((o) => o.status === 'publishing');
	const retrying = outcomes.filter((o) => o.status === 'retrying');
	const cancelled = outcomes.filter((o) => o.status === 'cancelled');
	const names = (list: DestinationOutcome[]) => list.map((o) => nameOf(o.connectionId)).join(', ');
	const posts = { label: 'View posts', href: '/posts' };
	const note = (opts.note ?? '') + (cancelled.length ? ` · cancelled on ${names(cancelled)}` : '');

	if (failed.length) {
		const where = names(failed);
		const detail =
			failed.length === 1 && failed[0].error ? `: ${humanizeError(failed[0].error)}` : '';
		return {
			message:
				(published.length ? `Published to ${published.length} · ` : '') +
				`Failed on ${where}${detail}`,
			tone: 'error',
			action: { label: 'View', href: '/posts?tab=failed' },
			announcement:
				(published.length ? `Published to ${published.length}. ` : '') + `Failed for ${where}.`
		};
	}
	if (retrying.length && retrying.every((r) => r.processing)) {
		const verb = retrying.length === 1 ? 'is' : 'are';
		return {
			message:
				`${names(retrying)} ${verb} processing the video — it publishes on its own in a minute or two` +
				(published.length ? ` · already published to ${published.length}` : '') +
				note,
			tone: 'success',
			action: posts,
			announcement: `${names(retrying)} ${verb} processing the video.`
		};
	}
	if (retrying.length) {
		return {
			message:
				`Retrying automatically for ${names(retrying)}` +
				(published.length ? ` — already published to ${published.length}` : '') +
				note,
			tone: 'warn',
			action: posts,
			announcement: `Retrying automatically for ${names(retrying)}.`
		};
	}
	if (inFlight.length) {
		return {
			message: 'One of these accounts is already publishing',
			tone: 'warn',
			action: posts,
			announcement: 'One of these accounts is already publishing.'
		};
	}
	if (!published.length && cancelled.length) {
		const message = `Nothing was sent: cancelled on ${names(cancelled)}${opts.note ?? ''}`;
		return { message, tone: 'warn', action: posts, announcement: `${message}.` };
	}
	const sent = published.filter((p) => !p.already).length;
	const already = published.length - sent;
	const message =
		(sent
			? `Published to ${sent} ${sent === 1 ? 'account' : 'accounts'}` +
				(already ? ` · already on ${already}` : '')
			: `Already published to ${already} ${already === 1 ? 'account' : 'accounts'} — nothing new was sent`) +
		note;
	return {
		message,
		tone: sent && !opts.noteKept ? 'success' : 'warn',
		action: { label: 'View', href: '/posts?tab=published' },
		announcement: `${message}.`
	};
}

/**
 * What a publish to several accounts has done so far, shown as each one lands
 * so a slow platform does not hold back the news from the quick ones. Null
 * when there is nothing to add: no result yet, or none still waiting, which
 * is when summarizePublish takes over.
 */
export function summarizeProgress(
	settled: DestinationOutcome[],
	waiting: string[],
	nameOf: (connectionId: string) => string
): PublishSummary | null {
	if (!settled.length || !waiting.length) return null;
	const names = (list: DestinationOutcome[]) => list.map((o) => nameOf(o.connectionId)).join(', ');
	const failed = settled.filter((o) => o.status === 'failed');
	const sent = settled.filter((o) => o.status === 'published' && !o.already);
	const already = settled.filter((o) => o.status === 'published' && o.already);
	const processing = settled.filter((o) => o.status === 'retrying' && o.processing);
	const retrying = settled.filter((o) => o.status === 'retrying' && !o.processing);
	const inFlight = settled.filter((o) => o.status === 'publishing');
	const cancelled = settled.filter((o) => o.status === 'cancelled');
	const parts: string[] = [];
	if (sent.length) parts.push(`Published to ${names(sent)}`);
	if (already.length) parts.push(`already on ${names(already)}`);
	if (processing.length) parts.push(`${names(processing)} processing the video`);
	if (retrying.length) parts.push(`retrying ${names(retrying)}`);
	if (inFlight.length) parts.push(`${names(inFlight)} already publishing`);
	if (cancelled.length) parts.push(`cancelled on ${names(cancelled)}`);
	if (failed.length) {
		const detail =
			failed.length === 1 && failed[0].error ? `: ${humanizeError(failed[0].error)}` : '';
		parts.push(`failed on ${names(failed)}${detail}`);
	}
	const head = parts.join(' · ');
	const still = `still sending to ${waiting.map(nameOf).join(', ')}`;
	const message = `${head.charAt(0).toUpperCase()}${head.slice(1)} · ${still}`;
	return {
		message,
		tone: failed.length ? 'error' : 'success',
		action: failed.length
			? { label: 'View', href: '/posts?tab=failed' }
			: { label: 'View posts', href: '/posts' },
		announcement: `${message}.`
	};
}

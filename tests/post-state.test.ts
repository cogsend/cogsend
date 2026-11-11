import { describe, expect, it } from 'vitest';
import { STALE_CLAIM_MS } from '#lib/domain/due-jobs.js';
import { restorableTargetIds } from '#lib/domain/platform-sync.js';
import {
	cardOutcome,
	isTargetSending,
	selectionDrift,
	summarizePost
} from '#lib/domain/post-state.js';
import { PROCESSING_MARK } from '#lib/domain/video-rules.js';
import { schedulePreviewText, scheduleWhenText } from '#lib/domain/schedule-helpers.js';
import { draftHasInFlightPublish } from '#lib/server/publish-plan.js';

const NOW = new Date('2030-06-10T12:00:00.000Z');
const IN_AN_HOUR = new Date(NOW.getTime() + 60 * 60_000);
const IN_TWO_HOURS = new Date(NOW.getTime() + 2 * 60 * 60_000);

describe('summarizePost', () => {
	it('sorts each account into one class, strongest first', () => {
		const state = summarizePost(
			[
				{ connectionId: 'pub', status: 'published', remotePostId: 'r1' },
				// A remote id means it went out, whatever the claim fields still say.
				{ connectionId: 'pub-claimed', status: 'publishing', remotePostId: 'r2', jobId: 'j1' },
				{ connectionId: 'send', status: 'scheduled', jobId: 'job-1', scheduledFor: IN_AN_HOUR },
				{ connectionId: 'wait', id: 't-wait', status: 'scheduled', scheduledFor: IN_AN_HOUR },
				{ connectionId: 'fail', status: 'failed', errorMessage: 'nope' },
				{ connectionId: 'gone', status: 'cancelled', scheduledFor: null }
			],
			NOW
		);
		expect(state.published).toEqual(['pub', 'pub-claimed']);
		expect(state.sending).toEqual(['send']);
		expect(state.waiting).toEqual([
			{
				targetId: 't-wait',
				connectionId: 'wait',
				at: IN_AN_HOUR,
				queued: false,
				retrying: false,
				error: null
			}
		]);
		expect(state.failed).toEqual([{ connectionId: 'fail', error: 'nope' }]);
		expect(state.nextAt).toEqual(IN_AN_HOUR);
	});

	it('lets a published sibling win over an older failed row', () => {
		const state = summarizePost(
			[
				{ connectionId: 'a', status: 'failed', errorMessage: 'first try' },
				{ connectionId: 'a', status: 'published', remotePostId: 'r' }
			],
			NOW
		);
		expect(state.published).toEqual(['a']);
		expect(state.failed).toEqual([]);
	});

	it('counts retrying, queued and stale publishing rows as still to go', () => {
		const stale = new Date(NOW.getTime() - STALE_CLAIM_MS - 1000);
		const state = summarizePost(
			[
				{
					connectionId: 'retry',
					status: 'scheduled',
					scheduledFor: IN_TWO_HOURS.toISOString(),
					errorMessage: 'rate limited'
				},
				{ connectionId: 'queued', status: 'pending', scheduledFor: null },
				{ connectionId: 'stuck', status: 'publishing', updatedAt: stale.toISOString() }
			],
			NOW
		);
		expect(state.sending).toEqual([]);
		expect(state.waiting.map((w) => [w.connectionId, w.queued, w.retrying])).toEqual([
			['retry', false, true],
			['queued', true, false],
			['stuck', true, false]
		]);
		expect(state.waiting[0].at).toEqual(IN_TWO_HOURS);
		expect(state.waiting[0].error).toBe('rate limited');
		// A queued target is due now.
		expect(state.nextAt).toEqual(NOW);
	});

	it('treats a fresh publishing row as being sent', () => {
		const state = summarizePost(
			[{ connectionId: 'a', status: 'publishing', updatedAt: new Date(NOW.getTime() - 60_000) }],
			NOW
		);
		expect(state.sending).toEqual(['a']);
		expect(state.waiting).toEqual([]);
	});

	it('keeps a scheduled row with an unusable time, without a time', () => {
		const state = summarizePost(
			[
				{ connectionId: 'a', status: 'scheduled', scheduledFor: 'not-a-date' },
				{ connectionId: 'b', status: 'scheduled', scheduledFor: null }
			],
			NOW
		);
		expect(state.waiting.map((w) => w.at)).toEqual([null, null]);
		expect(state.nextAt).toBeNull();
	});

	it('is empty for a draft with no live targets', () => {
		expect(summarizePost([], NOW)).toEqual({
			published: [],
			sending: [],
			processing: [],
			waiting: [],
			failed: [],
			nextAt: null
		});
		expect(summarizePost(null, NOW).waiting).toEqual([]);
	});

	it('keeps a video the platform is processing apart from what waits for a time', () => {
		const state = summarizePost(
			[
				{
					connectionId: 'threads',
					id: 't-1',
					status: 'scheduled',
					scheduledFor: IN_AN_HOUR,
					errorMessage: `Threads ${PROCESSING_MARK} — it publishes on its own`
				},
				{
					connectionId: 'masto',
					id: 't-2',
					status: 'scheduled',
					scheduledFor: IN_TWO_HOURS,
					errorMessage: 'Mastodon returned 503'
				}
			],
			NOW
		);
		expect(state.processing).toEqual(['threads']);
		expect(state.waiting.map((w) => [w.connectionId, w.retrying])).toEqual([['masto', true]]);
		expect(state.nextAt).toEqual(IN_TWO_HOURS);
		// Nothing to unschedule or re-time while the platform finishes it.
		expect(selectionDrift(state, [])).toEqual({ added: [], removed: ['masto'] });
	});
});

describe('isTargetSending', () => {
	it('matches the server rule that refuses edits', () => {
		const rows = [
			{ status: 'scheduled', jobId: 'job' },
			{ status: 'scheduled', jobId: null },
			{ status: 'publishing', updatedAt: new Date(NOW.getTime() - 1000) },
			{ status: 'publishing', updatedAt: new Date(NOW.getTime() - STALE_CLAIM_MS - 1000) },
			{ status: 'publishing', updatedAt: new Date(NOW.getTime() - 1000), remotePostId: 'r' },
			{ status: 'published', remotePostId: 'r' },
			{ status: 'failed' }
		];
		for (const row of rows) {
			expect(isTargetSending(row, NOW)).toBe(draftHasInFlightPublish([row], NOW));
		}
		expect(rows.map((row) => isTargetSending(row, NOW))).toEqual([
			true,
			false,
			true,
			false,
			false,
			false,
			false
		]);
	});

	it('reads ISO strings as the draft API sends them', () => {
		expect(
			isTargetSending(
				{ status: 'publishing', updatedAt: new Date(NOW.getTime() - 1000).toISOString() },
				NOW
			)
		).toBe(true);
	});
	it('stops counting a queue tag as sending once its claim is stale', () => {
		const fresh = new Date(NOW.getTime() - 1000);
		const stale = new Date(NOW.getTime() - STALE_CLAIM_MS - 1000);
		expect(isTargetSending({ status: 'scheduled', jobId: 'job', updatedAt: fresh }, NOW)).toBe(
			true
		);
		expect(isTargetSending({ status: 'scheduled', jobId: 'job', updatedAt: stale }, NOW)).toBe(
			false
		);
	});
});

describe('selectionDrift', () => {
	const scheduled = summarizePost(
		[
			{ connectionId: 'a', status: 'scheduled', scheduledFor: IN_AN_HOUR },
			{ connectionId: 'b', status: 'scheduled', scheduledFor: IN_AN_HOUR },
			{ connectionId: 'p', status: 'published', remotePostId: 'r' }
		],
		NOW
	);

	it('reports nothing while the ticks match the schedule', () => {
		expect(selectionDrift(scheduled, ['a', 'b'])).toEqual({ added: [], removed: [] });
		// A published account ticked or not makes no difference.
		expect(selectionDrift(scheduled, ['a', 'b', 'p'])).toEqual({ added: [], removed: [] });
	});

	it('names accounts unticked and ticked since scheduling', () => {
		expect(selectionDrift(scheduled, ['a', 'c'])).toEqual({ added: ['c'], removed: ['b'] });
	});

	it('reports nothing when nothing is waiting', () => {
		const published = summarizePost([{ connectionId: 'p', status: 'published' }], NOW);
		expect(selectionDrift(published, ['x'])).toEqual({ added: [], removed: [] });
	});
});

describe('restorableTargetIds', () => {
	it('leaves out accounts taken off the post', () => {
		expect(
			restorableTargetIds([
				{ connectionId: 'a', status: 'scheduled' },
				{ connectionId: 'b', status: 'cancelled' },
				{ connectionId: null, status: 'scheduled' },
				{ connectionId: 'c', status: 'published' }
			])
		).toEqual(['a', 'c']);
		expect(restorableTargetIds(undefined)).toEqual([]);
	});
});

describe('scheduleWhenText', () => {
	it('reads like the schedule preview', () => {
		const now = new Date();
		const at = new Date(now.getTime() + 3 * 60 * 60_000);
		at.setSeconds(0, 0);
		const value = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}T${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
		expect(schedulePreviewText(value, now)).toBe(scheduleWhenText(at, now));
		expect(scheduleWhenText(at, now)).toMatch(/\(in 3h\)$/);
	});
});

describe('cardOutcome', () => {
	it('tells a partly published post from a published or a failed one', () => {
		expect(cardOutcome([{ status: 'published' }, { status: 'published' }])).toEqual({
			kind: 'published',
			published: 2,
			total: 2
		});
		expect(cardOutcome([{ status: 'failed' }, { status: 'failed' }])).toEqual({
			kind: 'failed',
			published: 0,
			total: 2
		});
		expect(cardOutcome([{ status: 'published' }, { status: 'failed' }])).toEqual({
			kind: 'partial',
			published: 1,
			total: 2
		});
	});

	it('counts only what has finished', () => {
		expect(
			cardOutcome([{ status: 'published' }, { status: 'cancelled' }, { status: 'scheduled' }])
		).toEqual({ kind: 'published', published: 1, total: 1 });
		expect(cardOutcome([{ status: 'scheduled' }, { status: 'cancelled' }])).toBeNull();
		expect(cardOutcome([])).toBeNull();
	});
});

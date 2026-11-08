import { describe, expect, it } from 'vitest';
import {
	aspectOf,
	coverUrl,
	FALLBACK_ASPECT,
	frameFor,
	gridFor,
	isVideoMedia
} from '#lib/domain/media-layout.js';
import { imageOverCap, mediaSizeProblem } from '#lib/domain/media-limits.js';
import {
	mayUnscheduleOthers,
	outcomeOfRow,
	summarizeProgress,
	summarizePublish,
	type DestinationOutcome
} from '#lib/domain/publish-outcome.js';
import { fitByPlatform, PROCESSING_MARK } from '#lib/domain/video-rules.js';

describe('media frames', () => {
	it('keeps an item at its own shape, narrowed to the height cap', () => {
		expect(frameFor(16 / 9, 400)).toEqual({ aspect: 16 / 9, maxWidth: 711 });
		// A phone video is 400 tall and only as wide as that makes it.
		expect(frameFor(9 / 16, 400)).toEqual({ aspect: 9 / 16, maxWidth: 225 });
		expect(frameFor(1, 280).maxWidth).toBe(280);
	});

	it('frames an item of unknown size as 16:9, and stops extremes at a sane shape', () => {
		expect(frameFor(null, 400).aspect).toBe(FALLBACK_ASPECT);
		expect(frameFor(10, 400).aspect).toBe(3);
		expect(frameFor(0.1, 400).aspect).toBe(0.5);
	});

	it('reads the shape from the stored size, and nothing from a missing one', () => {
		expect(aspectOf({ width: 1080, height: 1920 })).toBe(1080 / 1920);
		expect(aspectOf({ width: null, height: 1920 })).toBeNull();
		expect(aspectOf({ width: 0, height: 0 })).toBeNull();
	});

	it('lays out two to four photos the way X does', () => {
		expect(gridFor(2)).toEqual({
			rows: 1,
			cells: [
				{ column: '1 / 2', row: '1 / 2' },
				{ column: '2 / 3', row: '1 / 2' }
			]
		});
		// Three: one tall on the left, two stacked on the right.
		expect(gridFor(3).cells[0]).toEqual({ column: '1 / 2', row: '1 / 3' });
		expect(
			gridFor(3)
				.cells.slice(1)
				.map((c) => c.column)
		).toEqual(['2 / 3', '2 / 3']);
		expect(gridFor(4).cells).toHaveLength(4);
		expect(gridFor(4).rows).toBe(2);
	});

	it('builds a cover URL only for a video that has one', () => {
		expect(coverUrl({ storageKey: 'a/b.mp4', meta: { cover: { v: 7 } } })).toBe(
			'/api/media/a%2Fb.mp4?cover=7'
		);
		expect(coverUrl({ storageKey: 'a/b.mp4', meta: null })).toBeNull();
		expect(isVideoMedia({ mime: 'Video/MP4' })).toBe(true);
		expect(isVideoMedia({ mime: 'image/png' })).toBe(false);
	});
});

describe('fitByPlatform', () => {
	const phone = {
		durationMs: 160_000,
		width: 1080,
		height: 1920,
		size: 20_000_000,
		videoCodec: 'avc',
		fps: 30,
		faststart: true
	};

	it('says nothing when every platform takes the video', () => {
		expect(
			fitByPlatform(
				[{ platform: 'bluesky' }, { platform: 'threads' }, { platform: 'linkedin' }],
				phone
			)
		).toEqual([]);
	});

	it('names only the platform that refuses it, with the reason', () => {
		expect(fitByPlatform([{ platform: 'x' }, { platform: 'bluesky' }], phone)).toEqual([
			{
				platform: 'x',
				level: 'error',
				message:
					'X takes videos up to 2:20 — this one is 2:40. Accounts with X Premium can post longer ones.'
			}
		]);
	});

	it('holds two accounts on one platform to the stricter one', () => {
		const accounts = [
			{ platform: 'x', meta: { xSubscription: 'Premium' } },
			{ platform: 'x', meta: null }
		];
		expect(fitByPlatform(accounts, phone).map((r) => r.platform)).toEqual(['x']);
		expect(fitByPlatform(accounts.slice(0, 1), phone)).toEqual([]);
	});
});

describe('imageOverCap', () => {
	it('says which platform an image is too large for, plainly and in the publish message', () => {
		const media = [{ mime: 'image/jpeg', size: 3_000_000 }];
		expect(imageOverCap('bluesky', media)).toBe("An image is over Bluesky's 2MB limit");
		expect(imageOverCap('mastodon', media)).toBeNull();
		expect(mediaSizeProblem(['mastodon', 'bluesky'], media)).toBe(
			"An image is over Bluesky's 2MB limit — remove it or uncheck Bluesky"
		);
	});
});

describe('publish outcome', () => {
	const nameOf = (id: string) => ({ a: 'Bluesky · a', b: 'Threads · b' })[id] ?? id;
	const out = (connectionId: string, row: Parameters<typeof outcomeOfRow>[1]) =>
		outcomeOfRow(connectionId, row);

	it('reads each kind of answer the publish route gives', () => {
		expect(out('a', { status: 'published', skipped: true })).toEqual({
			connectionId: 'a',
			status: 'published',
			error: null,
			already: true
		});
		expect(out('a', { status: 'scheduled', deferred: true }).status).toBe('retrying');
		expect(out('a', { status: 'scheduled', error: `Threads ${PROCESSING_MARK}` })).toMatchObject({
			status: 'retrying',
			processing: true
		});
		expect(out('a', { status: 'failed', error: null })).toMatchObject({
			status: 'failed',
			error: 'Publish failed'
		});
		expect(out('a', undefined).status).toBe('failed');
	});

	it('reports a post another run took over as published, and a cancelled one as not sent', () => {
		expect(out('a', { status: 'preempted', skipped: true })).toEqual({
			connectionId: 'a',
			status: 'published',
			error: null
		});
		expect(
			summarizePublish([out('a', { status: 'preempted', skipped: true })], nameOf)
		).toMatchObject({ message: 'Published to 1 destination', tone: 'success' });

		const cancelled = out('b', { status: 'cancelled', error: 'Target cancelled' });
		expect(cancelled).toEqual({ connectionId: 'b', status: 'cancelled', error: null });
		expect(summarizePublish([cancelled], nameOf)).toMatchObject({
			message: 'Nothing was sent: cancelled on Threads · b',
			tone: 'warn',
			action: { label: 'View posts', href: '/posts' }
		});
		expect(summarizePublish([out('a', { status: 'published' }), cancelled], nameOf).message).toBe(
			'Published to 1 destination · cancelled on Threads · b'
		);
		expect(summarizeProgress([cancelled], ['a'], nameOf)?.message).toBe(
			'Cancelled on Threads · b · still sending to Bluesky · a'
		);
		// Nothing went out there, so the rest of the schedule stays.
		expect(mayUnscheduleOthers([out('a', { status: 'published' }), cancelled])).toBe(false);
	});

	it('reports each account as it lands while others are still sending', () => {
		const names = (id: string) =>
			({ a: 'Bluesky · a', b: 'Threads · b', c: 'Mastodon · c' })[id] ?? id;
		expect(summarizeProgress([], ['a'], names)).toBeNull();
		// The last one in is the final summary's job.
		expect(summarizeProgress([out('a', { status: 'published' })], [], names)).toBeNull();

		const quick = summarizeProgress([out('a', { status: 'published' })], ['b', 'c'], names);
		expect(quick).toMatchObject({
			message: 'Published to Bluesky · a · still sending to Threads · b, Mastodon · c',
			tone: 'success',
			action: { label: 'View posts', href: '/posts' }
		});

		const mixed = summarizeProgress(
			[
				out('a', { status: 'published' }),
				out('c', { status: 'scheduled', error: `Mastodon ${PROCESSING_MARK}` })
			],
			['b'],
			names
		);
		expect(mixed?.message).toBe(
			'Published to Bluesky · a · Mastodon · c processing the video · still sending to Threads · b'
		);
		expect(mixed?.tone).toBe('success');

		const failed = summarizeProgress(
			[out('b', { status: 'failed', error: 'Invalid token' })],
			['a'],
			names
		);
		expect(failed?.message).toMatch(/^Failed on Threads · b: .+ · still sending to Bluesky · a$/);
		expect(failed?.tone).toBe('error');
		expect(failed?.action).toEqual({ label: 'View', href: '/posts?tab=failed' });
	});

	it('reports a clean publish, and one already out', () => {
		const sent = summarizePublish([out('a', { status: 'published' })], nameOf);
		expect(sent).toMatchObject({
			message: 'Published to 1 destination',
			tone: 'success',
			action: { label: 'View', href: '/posts?tab=published' }
		});
		const mixed = summarizePublish(
			[out('a', { status: 'published' }), out('b', { status: 'published', skipped: true })],
			nameOf,
			{ note: ' · unscheduled on Mastodon · c' }
		);
		expect(mixed.message).toBe(
			'Published to 1 destination · already on 1 · unscheduled on Mastodon · c'
		);
		const none = summarizePublish([out('a', { status: 'published', skipped: true })], nameOf);
		expect(none).toMatchObject({
			message: 'Already published to 1 destination — nothing new was sent',
			tone: 'warn'
		});
		// An account that could not be unscheduled turns a clean publish amber.
		expect(
			summarizePublish([out('a', { status: 'published' })], nameOf, { noteKept: true }).tone
		).toBe('warn');
	});

	it('names where it failed and links to the failures', () => {
		const one = summarizePublish(
			[
				out('a', { status: 'published' }),
				out('b', { status: 'failed', error: 'The account was suspended' })
			],
			nameOf
		);
		expect(one).toMatchObject({
			message: 'Published to 1 · Failed on Threads · b: The account was suspended',
			tone: 'error',
			action: { label: 'View', href: '/posts?tab=failed' }
		});
		const both = summarizePublish(
			[out('a', { status: 'failed', error: 'x' }), out('b', { status: 'failed', error: 'y' })],
			nameOf
		);
		expect(both.message).toBe('Failed on Bluesky · a, Threads · b');
	});

	it('tells processing apart from retrying', () => {
		const processing = summarizePublish(
			[out('b', { status: 'scheduled', error: `Threads ${PROCESSING_MARK}` })],
			nameOf
		);
		expect(processing).toMatchObject({
			message: 'Threads · b is processing the video — it publishes on its own in a minute or two',
			tone: 'success',
			action: { label: 'View posts', href: '/posts' }
		});
		const retrying = summarizePublish(
			[out('a', { status: 'published' }), out('b', { status: 'scheduled', error: 'HTTP 503' })],
			nameOf
		);
		expect(retrying).toMatchObject({
			message: 'Retrying automatically for Threads · b — already published to 1',
			tone: 'warn'
		});
	});

	it('unschedules the accounts left out only once nothing failed or is still going', () => {
		const ok: DestinationOutcome[] = [out('a', { status: 'published' })];
		expect(mayUnscheduleOthers(ok)).toBe(true);
		expect(mayUnscheduleOthers([...ok, out('b', { status: 'scheduled', error: 'x' })])).toBe(true);
		expect(mayUnscheduleOthers([...ok, out('b', { status: 'failed', error: 'x' })])).toBe(false);
		expect(mayUnscheduleOthers([...ok, out('b', { status: 'publishing' })])).toBe(false);
	});
});

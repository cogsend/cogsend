import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { connections, drafts, publishTargets, users } from '$lib/server/db/schema';
import { newId, type AppDb } from '$lib/server/db/client';
import { createTestDb } from '$lib/server/db/test';
import { SERIES_BUCKETS_PER_STATEMENT } from '$lib/server/insights-report';
import {
	bucketKind,
	buildInsightSeries,
	categorizeFailure,
	groupFailureReasons,
	insightFrames,
	localDayKey,
	parseInsightRange,
	rangeSpanDays,
	rateOf,
	tallyInsightFrames,
	type InsightTargetRow
} from '$lib/domain/insights';
import { GET as insightsGET } from '../src/routes/api/insights/+server';

const DAY = 86_400_000;
/** Sep 11 2026, 21:00 JST — a time of day that is a different UTC date. */
const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);

describe('range helpers', () => {
	it('accepts only the three shipped ranges', () => {
		expect(parseInsightRange('7')).toBe(7);
		expect(parseInsightRange('30')).toBe(30);
		expect(parseInsightRange('90')).toBe(90);
		expect(parseInsightRange('13')).toBe(30);
		expect(parseInsightRange('abc')).toBe(30);
		expect(parseInsightRange(null)).toBe(30);
	});

	it('covers whole weeks for the 90-day range', () => {
		expect(rangeSpanDays(7)).toBe(7);
		expect(rangeSpanDays(30)).toBe(30);
		expect(rangeSpanDays(90)).toBe(91);
		expect(bucketKind(90)).toBe('week');
		expect(bucketKind(30)).toBe('day');
	});

	it('rates are rounded and null when nothing was attempted', () => {
		expect(rateOf(3, 1)).toBe(75);
		expect(rateOf(4, 2)).toBe(67);
		expect(rateOf(0, 0)).toBeNull();
	});
});

describe('local-day bucketing', () => {
	it('keys days in the account timezone, not UTC', () => {
		const lateUtc = Date.UTC(2026, 8, 11, 20, 0, 0);
		expect(localDayKey(lateUtc, 'Asia/Tokyo')).toBe('2026-09-12');
		expect(localDayKey(lateUtc, 'UTC')).toBe('2026-09-11');
	});

	it('falls back to UTC for an invalid timezone instead of throwing', () => {
		expect(localDayKey(NOW, 'Not/AZone')).toBe('2026-09-11');
	});

	it('places a late-evening post in the owner’s day bucket', () => {
		const rows: InsightTargetRow[] = [
			{
				connectionId: 'c1',
				status: 'published',
				// Sep 11, 05:00 JST — still the previous UTC day.
				updatedAtMs: Date.UTC(2026, 8, 10, 20, 0, 0)
			}
		];
		const ist = buildInsightSeries({
			currentRows: rows,
			previousRows: [],
			nowMs: NOW,
			days: 7,
			timeZone: 'Asia/Tokyo'
		});
		const utc = buildInsightSeries({
			currentRows: rows,
			previousRows: [],
			nowMs: NOW,
			days: 7,
			timeZone: 'UTC'
		});
		expect(ist.current).toHaveLength(7);
		expect(ist.current[6]).toMatchObject({ label: 'Sep 11', published: 1 });
		expect(ist.current.reduce((n, b) => n + b.published, 0)).toBe(1);
		expect(utc.current[5]).toMatchObject({ label: 'Sep 10', published: 1 });
	});

	it('keeps whole local days across a DST change', () => {
		// The one timezone shape the other cases miss: a zone whose local day is
		// not always 24 hours. US daylight saving starts 2026-03-08 and ends
		// 2026-11-01; the keys are calendar dates, so both must still produce
		// seven distinct days with a post on each landing in its own bucket.
		for (const [nowMs, startDay] of [
			[Date.UTC(2026, 2, 10, 16, 0, 0), '2026-03-04'], // spring forward
			[Date.UTC(2026, 10, 3, 16, 0, 0), '2026-10-28'] // fall back
		] as const) {
			const rows: InsightTargetRow[] = Array.from({ length: 7 }, (_, i) => ({
				connectionId: 'c1',
				status: 'published',
				// 09:00 local on each of the seven days (13:00/14:00 UTC).
				updatedAtMs: Date.UTC(
					Number(startDay.slice(0, 4)),
					Number(startDay.slice(5, 7)) - 1,
					Number(startDay.slice(8, 10)) + i,
					14,
					0,
					0
				)
			}));
			const series = buildInsightSeries({
				currentRows: rows,
				previousRows: [],
				nowMs,
				days: 7,
				timeZone: 'America/New_York'
			});
			expect(series.current.map((b) => b.label)).toHaveLength(7);
			// Every post is counted, and no day is counted twice.
			expect(series.current.reduce((n, b) => n + b.published, 0)).toBe(7);
			expect(new Set(series.current.map((b) => b.label)).size).toBe(7);
		}
	});

	it('buckets 90 days into 13 whole weeks', () => {
		const rows: InsightTargetRow[] = [
			{ connectionId: 'c1', status: 'published', updatedAtMs: NOW - 1 * DAY },
			{ connectionId: 'c1', status: 'published', updatedAtMs: NOW - 5 * DAY },
			{ connectionId: 'c1', status: 'failed', updatedAtMs: NOW - 5 * DAY }
		];
		const series = buildInsightSeries({
			currentRows: rows,
			previousRows: [],
			nowMs: NOW,
			days: 90,
			timeZone: 'Asia/Tokyo'
		});
		expect(series.current).toHaveLength(13);
		expect(series.current.reduce((n, b) => n + b.published, 0)).toBe(2);
		expect(series.current.reduce((n, b) => n + b.failed, 0)).toBe(1);
		// Both rows fall in the final (current) week.
		expect(series.current[12]).toMatchObject({ published: 2, failed: 1 });
	});

	it('keeps rows from both windows in their own bucketed series', () => {
		const series = buildInsightSeries({
			currentRows: [
				{ connectionId: 'c1', status: 'published', updatedAtMs: NOW - 1 * DAY },
				{ connectionId: 'c1', status: 'failed', updatedAtMs: NOW - 2 * DAY }
			],
			previousRows: [
				{ connectionId: 'c1', status: 'published', updatedAtMs: NOW - 31 * DAY },
				{ connectionId: 'c1', status: 'failed', updatedAtMs: NOW - 32 * DAY }
			],
			nowMs: NOW,
			days: 30,
			timeZone: 'Asia/Tokyo'
		});
		expect(series.current).toHaveLength(30);
		expect(series.previous).toHaveLength(30);
		expect(series.current.reduce((n, b) => n + b.published + b.failed, 0)).toBe(2);
		expect(series.previous.reduce((n, b) => n + b.published + b.failed, 0)).toBe(2);
		expect(series.previous.reduce((n, b) => n + b.published, 0)).toBe(1);
	});

	it('counts the same buckets from millisecond ranges', () => {
		// The SQL path counts these ranges instead of loading every row. They
		// have to land on the same bars, including the DST weeks and the clamp
		// of a stamp that sits just outside the first local day.
		const cases: Array<{
			nowMs: number;
			days: 7 | 30 | 90;
			timeZone: string;
			rows: InsightTargetRow[];
		}> = [
			{
				nowMs: NOW,
				days: 30,
				timeZone: 'Asia/Tokyo',
				rows: [
					{ connectionId: 'c', status: 'published', updatedAtMs: NOW - 1 * DAY },
					{ connectionId: 'c', status: 'failed', updatedAtMs: NOW - 2 * DAY },
					{ connectionId: 'c', status: 'published', updatedAtMs: NOW - 31 * DAY },
					{ connectionId: 'c', status: 'failed', updatedAtMs: NOW - 32 * DAY },
					{ connectionId: 'c', status: 'published', updatedAtMs: NOW - 29 * DAY - 3_600_000 }
				]
			},
			{
				nowMs: NOW,
				days: 90,
				timeZone: 'America/New_York',
				rows: Array.from({ length: 20 }, (_, i) => ({
					connectionId: 'c',
					status: i % 4 === 0 ? 'failed' : 'published',
					updatedAtMs: NOW - i * 4 * DAY
				}))
			},
			{
				nowMs: Date.UTC(2026, 2, 10, 16, 0, 0),
				days: 7,
				timeZone: 'America/New_York',
				rows: Array.from({ length: 7 }, (_, i) => ({
					connectionId: 'c',
					status: 'published',
					updatedAtMs: Date.UTC(2026, 2, 4 + i, 14, 0, 0)
				}))
			}
		];
		for (const c of cases) {
			const frames = insightFrames(c.nowMs, c.days, c.timeZone);
			const currentRows = c.rows.filter((r) => r.updatedAtMs >= frames.sinceMs);
			const previousRows = c.rows.filter(
				(r) => r.updatedAtMs >= frames.previousSinceMs && r.updatedAtMs < frames.sinceMs
			);
			expect(tallyInsightFrames(currentRows, previousRows, frames)).toEqual(
				buildInsightSeries({
					currentRows,
					previousRows,
					nowMs: c.nowMs,
					days: c.days,
					timeZone: c.timeZone
				})
			);
		}
	});
});

describe('failure categorisation', () => {
	it('groups raw provider messages into stable short reasons', () => {
		expect(
			categorizeFailure('threads', 'Threads media download has failed [meta 100.2207052]')
		).toBe('Threads media timeout');
		expect(categorizeFailure('threads', 'Threads container failed (400) missing permissions')).toBe(
			'Threads permission'
		);
		expect(categorizeFailure('bluesky', 'HTTP 429 rate limited')).toBe('Bluesky rate limit');
		expect(
			categorizeFailure('linkedin', 'LinkedIn does not support threads — keep it to a single post')
		).toBe('LinkedIn threads unsupported');
		expect(categorizeFailure('x', '')).toBe('X failure');
		expect(categorizeFailure('mastodon', 'something odd happened')).toBe('Mastodon failed');
		expect(categorizeFailure(null, null)).toBe('Account failure');
	});

	it('labels the real setup failures the app stores', () => {
		// Bluesky rejects a PDS by validation before any request is made.
		expect(categorizeFailure('bluesky', 'PDS host not allowed')).toBe('Bluesky host not allowed');
		// An incomplete credential row is a reconnect, not a mystery.
		expect(
			categorizeFailure('linkedin', 'LinkedIn credentials require personUrn (reconnect account)')
		).toBe('LinkedIn auth expired');
	});

	it('counts failed rows only, most common first, capped', () => {
		const rows: InsightTargetRow[] = [
			{
				connectionId: 'c1',
				status: 'failed',
				updatedAtMs: NOW,
				platform: 'bluesky',
				errorMessage: 'HTTP 429 rate limited'
			},
			{
				connectionId: 'c1',
				status: 'failed',
				updatedAtMs: NOW,
				platform: 'bluesky',
				errorMessage: 'HTTP 429 rate limited'
			},
			{
				connectionId: 'c1',
				status: 'failed',
				updatedAtMs: NOW,
				platform: 'linkedin',
				errorMessage: 'HTTP 429 rate limited'
			},
			{
				connectionId: 'c1',
				status: 'failed',
				updatedAtMs: NOW,
				platform: 'x',
				errorMessage: 'HTTP 401 unauthorized'
			},
			{
				connectionId: 'c1',
				status: 'published',
				updatedAtMs: NOW,
				platform: 'x',
				errorMessage: 'HTTP 429 rate limited'
			}
		];
		expect(groupFailureReasons(rows)).toEqual([
			{ label: 'Bluesky rate limit', count: 2 },
			{ label: 'LinkedIn rate limit', count: 1 },
			{ label: 'X auth expired', count: 1 }
		]);
		expect(groupFailureReasons(rows, 2)).toHaveLength(2);
	});
});

describe('GET /api/insights', () => {
	let db: AppDb;
	let close: () => void;
	let count: () => number;
	let maxParams: () => number;
	let lastBatchSql: () => string[];
	let reset: () => void;

	const localsFor = (
		id: string,
		apiKeyScopes: string[] | null = null,
		timezone = 'Asia/Tokyo'
	) => ({
		db,
		user: {
			id,
			email: 'insights@localhost',
			timezone,
			totpEnabled: true,
			mfaVerified: true
		},
		apiKeyScopes
	});

	async function addTarget(
		connectionId: string,
		userId: string,
		status: string,
		daysAgo: number,
		opts: { errorMessage?: string; scheduledAtMs?: number } = {}
	) {
		const draftId = newId();
		const at = new Date(NOW - daysAgo * DAY);
		await db.insert(drafts).values({
			id: draftId,
			userId,
			baseBody: 'body',
			status: 'published',
			createdAt: at,
			updatedAt: at
		});
		await db.insert(publishTargets).values({
			id: newId(),
			draftId,
			connectionId,
			status,
			scheduledFor: opts.scheduledAtMs !== undefined ? new Date(opts.scheduledAtMs) : null,
			remotePostId: status === 'published' ? `remote-${draftId}` : null,
			attemptCount: 1,
			errorMessage: opts.errorMessage ?? null,
			createdAt: at,
			updatedAt: at
		});
	}

	beforeAll(async () => {
		const harness = await createTestDb();
		db = harness.db;
		close = harness.close;
		count = harness.count;
		maxParams = harness.maxParams;
		lastBatchSql = harness.lastBatchSql;
		reset = harness.reset;

		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);

		const stamp = { createdAt: new Date(NOW), updatedAt: new Date(NOW) };
		await db.insert(users).values([
			{ id: 'u1', email: 'u1@localhost', passwordHash: 'x', timezone: 'Asia/Tokyo', ...stamp },
			{ id: 'u2', email: 'u2@localhost', passwordHash: 'x', timezone: 'UTC', ...stamp }
		]);
		await db.insert(connections).values([
			{
				id: 'c1',
				userId: 'u1',
				platform: 'bluesky',
				handle: 'alpha.bsky.social',
				displayName: 'Alpha',
				credentialsEncrypted: 'x',
				status: 'active',
				...stamp
			},
			{
				id: 'c2',
				userId: 'u1',
				platform: 'linkedin',
				handle: 'person',
				displayName: 'Beta',
				credentialsEncrypted: 'x',
				status: 'active',
				...stamp
			},
			{
				id: 'c3',
				userId: 'u1',
				platform: 'mastodon',
				handle: 'm@x',
				displayName: 'Gamma',
				credentialsEncrypted: 'x',
				status: 'disconnected',
				...stamp
			},
			{
				id: 'c4',
				userId: 'u1',
				platform: 'x',
				handle: 'old',
				displayName: 'Archived',
				credentialsEncrypted: 'x',
				status: 'disconnected',
				...stamp
			},
			{
				id: 'c9',
				userId: 'u2',
				platform: 'bluesky',
				handle: 'other',
				displayName: 'Other',
				credentialsEncrypted: 'x',
				status: 'active',
				...stamp
			}
		]);

		// Current window.
		await addTarget('c1', 'u1', 'published', 1);
		await addTarget('c1', 'u1', 'published', 10);
		await addTarget('c1', 'u1', 'published', 3);
		await addTarget('c2', 'u1', 'failed', 1, { errorMessage: 'HTTP 429 rate limited' });
		await addTarget('c1', 'u1', 'failed', 2, { errorMessage: 'HTTP 429 rate limited' });
		await addTarget('c3', 'u1', 'published', 2);
		// Previous window.
		await addTarget('c1', 'u1', 'published', 35);
		await addTarget('c1', 'u1', 'published', 40);
		await addTarget('c1', 'u1', 'failed', 45, { errorMessage: 'HTTP 500 upstream error' });
		// Older than both windows.
		await addTarget('c1', 'u1', 'published', 100);
		await addTarget('c4', 'u1', 'published', 100);
		// Another user's history must never leak in.
		await addTarget('c9', 'u2', 'published', 1);
		// Queue snapshot.
		await addTarget('c1', 'u1', 'scheduled', 0, { scheduledAtMs: NOW + 2 * 3_600_000 });
		await addTarget('c2', 'u1', 'scheduled', 0, { scheduledAtMs: NOW + DAY });
	});

	afterAll(() => {
		vi.useRealTimers();
		close();
	});

	it('returns totals, comparison, series, failures, accounts and queue', async () => {
		reset();
		const res = await insightsGET({
			locals: localsFor('u1'),
			url: new URL('http://localhost/api/insights?days=30')
		} as never);
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body.range).toMatchObject({ days: 30, bucket: 'day', buckets: 30 });
		expect(body.totals).toMatchObject({ published: 4, failed: 2, rate: 67, scheduled: 2 });
		expect(body.totals.nextScheduledAt).toBe(NOW + 2 * 3_600_000);
		expect(body.previous).toMatchObject({ published: 2, failed: 1, rate: 67 });

		const sum = (list: { published: number; failed: number }[]) =>
			list.reduce((acc, b) => ({ p: acc.p + b.published, f: acc.f + b.failed }), { p: 0, f: 0 });
		expect(sum(body.series.current)).toEqual({ p: 4, f: 2 });
		expect(sum(body.series.previous)).toEqual({ p: 2, f: 1 });

		expect(body.failures).toEqual([
			{ label: 'Bluesky rate limit', count: 1 },
			{ label: 'LinkedIn rate limit', count: 1 }
		]);

		expect(body.accounts.map((a: { connectionId: string }) => a.connectionId)).toEqual([
			'c1',
			'c3',
			'c2'
		]);
		const c1 = body.accounts[0];
		expect(c1).toMatchObject({
			connectionId: 'c1',
			platform: 'bluesky',
			handle: 'alpha.bsky.social',
			connected: true,
			published: 3,
			failed: 1,
			rate: 75,
			lastPublishedAt: NOW - DAY
		});
		// Archived tombstones stay while they anchor in-window history.
		expect(body.accounts[1]).toMatchObject({
			connectionId: 'c3',
			connected: false,
			published: 1,
			failed: 0,
			rate: 100,
			lastPublishedAt: NOW - 2 * DAY
		});
		expect(body.accounts[2]).toMatchObject({
			connectionId: 'c2',
			published: 0,
			failed: 1,
			rate: 0
		});

		// One batch: four overview statements plus five chart chunks (30
		// buckets at seven per statement). The timezone rides on the session.
		expect(count()).toBeLessThanOrEqual(10);
	});

	it('keeps every statement inside the D1 bound-parameter cap', async () => {
		for (const days of [7, 30, 90]) {
			reset();
			const res = await insightsGET({
				locals: localsFor('u1'),
				url: new URL(`http://localhost/api/insights?days=${days}`)
			} as never);
			expect(res.status).toBe(200);
			// D1 refuses any statement with more than 100 bound parameters
			// ("too many SQL variables"); the chart's CASE-per-bucket aggregate
			// is the statement that grows with the range. The lower bound keeps
			// the counter honest: a broken probe would read 0 and pass the cap.
			expect(maxParams(), `days=${days}`).toBeGreaterThan(10);
			expect(maxParams(), `days=${days}`).toBeLessThanOrEqual(100);
		}
	});

	it('aliases every chart bucket so D1 cannot collapse the columns', async () => {
		reset();
		const res = await insightsGET({
			locals: localsFor('u1'),
			url: new URL('http://localhost/api/insights?days=30')
		} as never);
		expect(res.status).toBe(200);
		// D1 keys a result row by column name and collapses duplicates. The
		// bucket expressions bind the status and both bounds, so without an
		// alias every one reads the same, the 120 columns fold into one, and
		// every bucket after the first decodes as 0.
		const series = lastBatchSql().filter((sql) =>
			sql.includes('coalesce(sum(case when "publish_targets"."status" = ?')
		);
		const buckets = 30;
		expect(series).toHaveLength(Math.ceil(buckets / SERIES_BUCKETS_PER_STATEMENT));
		series.forEach((sql, chunk) => {
			const from = chunk * SERIES_BUCKETS_PER_STATEMENT;
			const to = Math.min(from + SERIES_BUCKETS_PER_STATEMENT, buckets) - 1;
			for (const index of [from, to]) {
				for (const prefix of ['cp', 'cf', 'pp', 'pf']) {
					expect(sql, `${prefix}${index}`).toContain(` as "${prefix}${index}"`);
				}
			}
			// Every selected expression is aliased, not only the bucket edges.
			expect(sql.match(/ as "/g) ?? [], `chunk ${chunk}`).toHaveLength(4 * (to - from + 1));
		});
	});

	it('narrows the window and compares against the window right before it', async () => {
		const res = await insightsGET({
			locals: localsFor('u1'),
			url: new URL('http://localhost/api/insights?days=7')
		} as never);
		const body = await res.json();
		expect(body.range).toMatchObject({ days: 7, bucket: 'day', buckets: 7 });
		expect(body.totals).toMatchObject({ published: 3, failed: 2, rate: 60 });
		// The 10-day-old post belongs to the previous 7-day window, not this one.
		expect(body.previous).toMatchObject({ published: 1, failed: 0, rate: 100 });
		expect(body.series.current).toHaveLength(7);
		const total = body.series.current.reduce(
			(n: number, b: { published: number; failed: number }) => n + b.published + b.failed,
			0
		);
		expect(total).toBe(5);
	});

	it('reports a null comparison rate when the previous window is empty', async () => {
		const res = await insightsGET({
			locals: localsFor('u2'),
			url: new URL('http://localhost/api/insights?days=7')
		} as never);
		const body = await res.json();
		expect(body.totals).toMatchObject({ published: 1, failed: 0, rate: 100 });
		expect(body.previous).toEqual({ published: 0, failed: 0, rate: null });
		// Another user's rows and connections never appear.
		expect(body.accounts.map((a: { connectionId: string }) => a.connectionId)).toEqual(['c9']);
	});

	it('falls back to the default range for anything unexpected', async () => {
		const res = await insightsGET({
			locals: localsFor('u1'),
			url: new URL('http://localhost/api/insights?days=13')
		} as never);
		const body = await res.json();
		expect(body.range.days).toBe(30);
	});

	it('rejects a key without read scope', async () => {
		const res = await insightsGET({
			locals: localsFor('u1', []),
			url: new URL('http://localhost/api/insights')
		} as never);
		expect(res.status).toBe(403);
	});

	it('answers with zeros and no accounts on an empty database', async () => {
		const empty = await createTestDb();
		try {
			const res = await insightsGET({
				locals: {
					db: empty.db,
					user: {
						id: 'u1',
						email: 'x@localhost',
						timezone: 'UTC',
						totpEnabled: true,
						mfaVerified: true
					},
					apiKeyScopes: null
				},
				url: new URL('http://localhost/api/insights?days=30')
			} as never);
			const body = await res.json();
			expect(res.status).toBe(200);
			expect(body.totals).toEqual({
				published: 0,
				failed: 0,
				rate: null,
				scheduled: 0,
				nextScheduledAt: null
			});
			expect(body.previous).toEqual({ published: 0, failed: 0, rate: null });
			expect(body.accounts).toEqual([]);
			expect(body.failures).toEqual([]);
			expect(body.series.current).toHaveLength(30);
			// The empty case is still one batched round trip.
			expect(empty.count()).toBeLessThanOrEqual(10);
		} finally {
			empty.close();
		}
	});

	it('still answers when the session timezone is invalid', async () => {
		const res = await insightsGET({
			locals: localsFor('u1', null, 'Not/AZone'),
			url: new URL('http://localhost/api/insights?days=30')
		} as never);
		const body = await res.json();
		expect(res.status).toBe(200);
		expect(body.series.current).toHaveLength(30);
		expect(body.series.current.every((b: { label: string }) => b.label.length > 0)).toBe(true);
	});
});

/**
 * Days are the viewer's. The zone stored on the account starts as UTC, so the
 * page sends the browser's own and the answer says which one it used.
 */
describe('GET /api/insights in the viewer’s time zone', () => {
	let db: AppDb;
	let close: () => void;
	// Noon UTC on Sep 15: 20:00 UTC the evening before is already Sep 15 in India.
	const now = Date.UTC(2026, 8, 15, 12, 0, 0);
	const postedAt = new Date(Date.UTC(2026, 8, 14, 20, 0, 0));

	const get = async (query: string) => {
		const res = (await insightsGET({
			locals: {
				db,
				user: {
					id: 'tz-user',
					email: 'tz@localhost',
					timezone: 'UTC',
					totpEnabled: true,
					mfaVerified: true
				},
				apiKeyScopes: null
			},
			url: new URL(`http://localhost/api/insights?days=7${query}`)
		} as never)) as Response;
		return res.json();
	};

	beforeAll(async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(now);
		({ db, close } = await createTestDb());
		await db.insert(users).values({
			id: 'tz-user',
			email: 'tz@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: postedAt,
			updatedAt: postedAt
		});
		await db.insert(connections).values({
			id: 'tz-conn',
			userId: 'tz-user',
			platform: 'mastodon',
			handle: 'tz@example.social',
			credentialsEncrypted: 'enc',
			status: 'active',
			createdAt: postedAt,
			updatedAt: postedAt
		});
		const draftId = newId();
		await db.insert(drafts).values({
			id: draftId,
			userId: 'tz-user',
			baseBody: 'evening post',
			status: 'published',
			createdAt: postedAt,
			updatedAt: postedAt
		});
		await db.insert(publishTargets).values({
			id: newId(),
			draftId,
			connectionId: 'tz-conn',
			status: 'published',
			remotePostId: 'remote-tz',
			attemptCount: 1,
			createdAt: postedAt,
			updatedAt: postedAt
		});
	});

	afterAll(() => {
		vi.useRealTimers();
		close();
	});

	it('counts the post on the viewer’s day, not UTC’s', async () => {
		const utc = await get('');
		expect(utc.range.timeZone).toBe('UTC');
		expect(utc.series.current.at(-1).published).toBe(0);
		expect(utc.series.current.at(-2).published).toBe(1);

		const india = await get('&tz=Asia/Kolkata');
		expect(india.range.timeZone).toBe('Asia/Kolkata');
		expect(india.series.current.at(-1).published).toBe(1);
		expect(india.totals.published).toBe(1);
	});

	it('ignores a zone the runtime does not know', async () => {
		const body = await get('&tz=Not/AZone');
		expect(body.range.timeZone).toBe('UTC');
	});
});

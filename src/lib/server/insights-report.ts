import { and, eq, gte, inArray, isNull, min, sql, type SQL } from 'drizzle-orm';
import {
	bucketKind,
	categorizeFailure,
	insightFrames,
	parseInsightRange,
	rangeSpanDays,
	rateOf,
	type InsightBound
} from '$lib/domain/insights';
import { platformName } from '$lib/domain/platforms';
import { parseTimeZone } from '$lib/domain/time-zone';
import { batchQueries, type AppDb } from './db/client';
import { connections, drafts, publishTargets } from './db/schema';

function num(value: unknown): number {
	if (typeof value === 'bigint') return Number(value);
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

/** D1 returns raw SQLite integers for aggregates; tests may hand back Dates. */
function toMs(value: unknown): number | null {
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'bigint') return Number(value);
	return null;
}

/**
 * One chart bucket, under an explicit alias. D1 keys each result row by column
 * name and collapses duplicate names; the status and both bounds are bound
 * parameters, so without an alias every bucket's text is identical and the
 * whole row folds into one column — every bucket after the first then reads 0.
 */
function boundSum(
	alias: string,
	status: 'published' | 'failed',
	bound: InsightBound
): SQL.Aliased<number> {
	if (bound.end != null && bound.start >= bound.end) return sql<number>`0`.as(alias);
	const upper = bound.end == null ? sql`` : sql` and ${publishTargets.updatedAt} < ${bound.end}`;
	return sql<number>`coalesce(sum(case when ${publishTargets.status} = ${status} and ${publishTargets.updatedAt} >= ${bound.start}${upper} then 1 else 0 end), 0)`.as(
		alias
	);
}

/**
 * Chart buckets per series statement. One bucket is at most twelve bound
 * parameters (two statuses × two windows × three bounds) and D1 rejects a
 * statement with more than 100, so seven leaves headroom.
 */
export const SERIES_BUCKETS_PER_STATEMENT = 7;

/**
 * Insights for one account. Totals, per-account counts, and chart buckets are
 * SQL aggregates over the same local-day ranges the chart has always used, so
 * a long history does not have to be loaded into the isolate.
 *
 * The bucket series is the one statement that grows with the range, so it is
 * split into several statements inside the same batch; every other read is a
 * single statement. The timezone comes from the caller (the browser's, or the
 * one the session already read) instead of a second round trip, and the zone
 * actually used is returned so a page can tell when it was not its own.
 */
export async function loadInsights(
	db: AppDb,
	userId: string,
	daysRaw: string | null,
	timeZone: string | null | undefined
) {
	const days = parseInsightRange(daysRaw);
	const span = rangeSpanDays(days);
	const nowMs = Date.now();
	const zone = parseTimeZone(timeZone) ?? 'UTC';
	const frames = insightFrames(nowMs, days, zone);

	const owned = and(
		eq(drafts.userId, userId),
		inArray(publishTargets.status, ['published', 'failed'])
	);
	const seriesQueries: unknown[] = [];
	for (let from = 0; from < frames.currentBounds.length; from += SERIES_BUCKETS_PER_STATEMENT) {
		const to = Math.min(from + SERIES_BUCKETS_PER_STATEMENT, frames.currentBounds.length);
		const shape: Record<string, SQL.Aliased<number>> = {};
		for (let i = from; i < to; i++) {
			const current = frames.currentBounds[i];
			const previous = frames.previousBounds[i];
			if (!current || !previous) continue;
			shape[`cp${i}`] = boundSum(`cp${i}`, 'published', current);
			shape[`cf${i}`] = boundSum(`cf${i}`, 'failed', current);
			shape[`pp${i}`] = boundSum(`pp${i}`, 'published', previous);
			shape[`pf${i}`] = boundSum(`pf${i}`, 'failed', previous);
		}
		seriesQueries.push(
			db
				.select(shape)
				.from(publishTargets)
				.innerJoin(drafts, eq(publishTargets.draftId, drafts.id))
				.where(and(owned, gte(publishTargets.updatedAt, new Date(frames.previousSinceMs))))
		);
	}

	const [connRows, scheduledRows, accountRows, failureRows, ...seriesResultSets] =
		(await batchQueries(db, [
			db
				.select({
					id: connections.id,
					platform: connections.platform,
					handle: connections.handle,
					displayName: connections.displayName,
					avatarUrl: connections.avatarUrl,
					status: connections.status
				})
				.from(connections)
				.where(eq(connections.userId, userId)),
			db
				.select({
					n: sql<number>`count(*)`,
					nextAt: min(publishTargets.scheduledFor)
				})
				.from(publishTargets)
				.innerJoin(drafts, eq(publishTargets.draftId, drafts.id))
				.where(
					and(
						eq(drafts.userId, userId),
						isNull(publishTargets.remotePostId),
						inArray(publishTargets.status, ['scheduled', 'pending', 'publishing'])
					)
				),
			db
				.select({
					connectionId: publishTargets.connectionId,
					published: sql<number>`coalesce(sum(case when ${publishTargets.status} = 'published' and ${publishTargets.updatedAt} >= ${frames.sinceMs} then 1 else 0 end), 0)`,
					failed: sql<number>`coalesce(sum(case when ${publishTargets.status} = 'failed' and ${publishTargets.updatedAt} >= ${frames.sinceMs} then 1 else 0 end), 0)`,
					lastAt: sql<
						number | null
					>`max(case when ${publishTargets.status} = 'published' then ${publishTargets.updatedAt} end)`
				})
				.from(publishTargets)
				.innerJoin(drafts, eq(publishTargets.draftId, drafts.id))
				.where(owned)
				.groupBy(publishTargets.connectionId),
			db
				.select({
					connectionId: publishTargets.connectionId,
					errorMessage: publishTargets.errorMessage,
					n: sql<number>`count(*)`
				})
				.from(publishTargets)
				.innerJoin(drafts, eq(publishTargets.draftId, drafts.id))
				.where(
					and(
						eq(drafts.userId, userId),
						eq(publishTargets.status, 'failed'),
						gte(publishTargets.updatedAt, new Date(frames.sinceMs))
					)
				)
				.groupBy(publishTargets.connectionId, publishTargets.errorMessage),
			...seriesQueries
		])) as [
			{
				id: string;
				platform: string;
				handle: string | null;
				displayName: string | null;
				avatarUrl: string | null;
				status: string;
			}[],
			{ n: unknown; nextAt: unknown }[],
			{ connectionId: string; published: unknown; failed: unknown; lastAt: unknown }[],
			{ connectionId: string; errorMessage: string | null; n: unknown }[],
			...Record<string, unknown>[]
		];

	const platformByConnection = new Map(connRows.map((c) => [c.id, c.platform]));
	const statsByConnection = new Map(accountRows.map((row) => [row.connectionId, row]));
	const seriesRow: Record<string, unknown> = {};
	for (const set of seriesResultSets) Object.assign(seriesRow, set[0] ?? {});

	const current = frames.currentLabels.map((label, i) => ({
		label,
		published: num(seriesRow[`cp${i}`]),
		failed: num(seriesRow[`cf${i}`])
	}));
	const previous = frames.previousLabels.map((label, i) => ({
		label,
		published: num(seriesRow[`pp${i}`]),
		failed: num(seriesRow[`pf${i}`])
	}));

	const published = current.reduce((n, b) => n + b.published, 0);
	const failed = current.reduce((n, b) => n + b.failed, 0);
	const previousPublished = previous.reduce((n, b) => n + b.published, 0);
	const previousFailed = previous.reduce((n, b) => n + b.failed, 0);

	const accounts = connRows
		.filter((c) => {
			const stats = statsByConnection.get(c.id);
			const inWindow = num(stats?.published) + num(stats?.failed);
			return c.status !== 'disconnected' || inWindow > 0;
		})
		.map((c) => {
			const stats = statsByConnection.get(c.id);
			const publishedCount = num(stats?.published);
			const failedCount = num(stats?.failed);
			return {
				connectionId: c.id,
				platform: c.platform,
				handle: c.handle,
				displayName: c.displayName,
				avatarUrl: c.avatarUrl,
				connected: c.status !== 'disconnected',
				published: publishedCount,
				failed: failedCount,
				rate: rateOf(publishedCount, failedCount),
				lastPublishedAt: toMs(stats?.lastAt)
			};
		})
		.sort(
			(a, b) =>
				b.published - a.published ||
				(platformName(a.platform) + (a.displayName ?? a.handle ?? '')).localeCompare(
					platformName(b.platform) + (b.displayName ?? b.handle ?? '')
				)
		);

	const reasonCounts = new Map<string, number>();
	for (const row of failureRows) {
		const label = categorizeFailure(platformByConnection.get(row.connectionId), row.errorMessage);
		reasonCounts.set(label, (reasonCounts.get(label) ?? 0) + num(row.n));
	}
	const failures = [...reasonCounts.entries()]
		.map(([label, count]) => ({ label, count }))
		.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
		.slice(0, 4);

	const scheduled = scheduledRows[0];
	return {
		range: {
			days,
			spanDays: span,
			bucket: bucketKind(days),
			buckets: current.length,
			timeZone: zone
		},
		now: nowMs,
		totals: {
			published,
			failed,
			rate: rateOf(published, failed),
			scheduled: num(scheduled?.n),
			nextScheduledAt: toMs(scheduled?.nextAt)
		},
		previous: {
			published: previousPublished,
			failed: previousFailed,
			rate: rateOf(previousPublished, previousFailed)
		},
		series: { current, previous },
		failures,
		accounts
	};
}

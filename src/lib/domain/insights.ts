import { platformName } from './platforms';
import { isThreadsAuthFailure, isThreadsMediaFetchFailure } from './threads-error';

const DAY_MS = 86_400_000;

/** One terminal publish target: the only rows Insights reads. */
export interface InsightTargetRow {
	connectionId: string;
	status: string;
	updatedAtMs: number;
	errorMessage?: string | null;
	/** Filled in by the API from the connection so failures can be labelled. */
	platform?: string;
}

/** One bar/point: a local day, or a local week when the range is 90 days. */
export interface InsightBucket {
	label: string;
	published: number;
	failed: number;
}

export interface FailureReason {
	label: string;
	count: number;
}

export const INSIGHT_RANGES = [7, 30, 90] as const;
export type InsightRange = (typeof INSIGHT_RANGES)[number];
export const DEFAULT_INSIGHT_RANGE: InsightRange = 30;

/** Query-string range, falling back to the default for anything unexpected. */
export function parseInsightRange(raw: string | null | undefined): InsightRange {
	const n = Number(raw);
	return (INSIGHT_RANGES as readonly number[]).includes(n)
		? (n as InsightRange)
		: DEFAULT_INSIGHT_RANGE;
}

/**
 * Whole local days a range covers. The 90-day range is 13 whole weeks: 90 is
 * not divisible by 7, and a trailing partial week would make the last bar
 * unrepresentative next to the others.
 */
export function rangeSpanDays(days: InsightRange): number {
	return days === 90 ? 91 : days;
}

export function bucketKind(days: InsightRange): 'day' | 'week' {
	return days === 90 ? 'week' : 'day';
}

/** Success percentage, or null when nothing was attempted (renders as "—"). */
export function rateOf(sent: number, failed: number): number | null {
	const total = sent + failed;
	return total ? Math.round((sent / total) * 100) : null;
}

/* ── Local-day bucketing ──────────────────────────────────────────────────
   Days are the account owner's days, not UTC days: a post at 11 PM local time
   belongs to that evening, not to the next UTC date. Keys are YYYY-MM-DD in
   the owner's timezone; labels are the same calendar date, so they never
   shift again when displayed. Formatters are cached — constructing them is
   the expensive part and one account has one timezone. */

const dayKeyFormatters = new Map<string, Intl.DateTimeFormat>();

function dayKeyFormatter(timeZone: string): Intl.DateTimeFormat {
	const cached = dayKeyFormatters.get(timeZone);
	if (cached) return cached;
	let fmt: Intl.DateTimeFormat;
	try {
		fmt = new Intl.DateTimeFormat('en-CA', {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit'
		});
	} catch {
		// Bad zone stored in the DB must not break the page.
		fmt = new Intl.DateTimeFormat('en-CA', {
			timeZone: 'UTC',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit'
		});
	}
	dayKeyFormatters.set(timeZone, fmt);
	return fmt;
}

export function localDayKey(ms: number, timeZone: string): string {
	const parts = dayKeyFormatter(timeZone).formatToParts(new Date(ms));
	const year = parts.find((p) => p.type === 'year')?.value ?? '1970';
	const month = parts.find((p) => p.type === 'month')?.value ?? '01';
	const day = parts.find((p) => p.type === 'day')?.value ?? '01';
	return `${year}-${month}-${day}`;
}

/** Labels are formatted in UTC: the key already is the owner's local date. */
const labelFormatter = new Intl.DateTimeFormat('en-US', {
	timeZone: 'UTC',
	month: 'short',
	day: 'numeric'
});

function keyToUtcMs(key: string): number {
	const [year, month, day] = key.split('-').map(Number);
	return Date.UTC(year, (month ?? 1) - 1, day ?? 1);
}

function addDays(key: string, n: number): string {
	const d = new Date(keyToUtcMs(key) + n * DAY_MS);
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
		d.getUTCDate()
	).padStart(2, '0')}`;
}

function labelFor(key: string): string {
	const [year, month, day] = key.split('-').map(Number);
	// Noon avoids any formatter edge at midnight.
	return labelFormatter.format(new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1, 12)));
}

/**
 * Bucket terminal rows into the selected window and the window before it.
 * Both periods get the same bucket layout, so the chart can draw them over
 * each other; `previousKeys` are the current keys shifted back one span.
 */
export function buildInsightSeries(opts: {
	currentRows: InsightTargetRow[];
	previousRows: InsightTargetRow[];
	nowMs: number;
	days: InsightRange;
	timeZone: string;
}): { current: InsightBucket[]; previous: InsightBucket[] } {
	const span = rangeSpanDays(opts.days);
	const weekly = bucketKind(opts.days) === 'week';
	const bucketCount = weekly ? span / 7 : span;

	const todayKey = localDayKey(opts.nowMs, opts.timeZone);
	const currentKeys: string[] = [];
	for (let i = span - 1; i >= 0; i--) currentKeys.push(addDays(todayKey, -i));
	const previousKeys = currentKeys.map((key) => addDays(key, -span));

	const indexOf = (keys: string[]): Map<string, number> => {
		const map = new Map<string, number>();
		keys.forEach((key, i) => map.set(key, weekly ? Math.floor(i / 7) : i));
		return map;
	};
	const currentIndex = indexOf(currentKeys);
	const previousIndex = indexOf(previousKeys);

	const build = (keys: string[]): InsightBucket[] =>
		Array.from({ length: bucketCount }, (_, i) => ({
			label: labelFor(keys[weekly ? i * 7 : i]),
			published: 0,
			failed: 0
		}));

	const current = build(currentKeys);
	const previous = build(previousKeys);

	const fill = (
		buckets: InsightBucket[],
		keys: string[],
		index: Map<string, number>,
		rows: InsightTargetRow[]
	) => {
		for (const row of rows) {
			if (row.status !== 'published' && row.status !== 'failed') continue;
			const key = localDayKey(row.updatedAtMs, opts.timeZone);
			// A clock-skewed row can fall outside the generated keys; clamp it
			// into the nearest bucket so chart sums always match the totals.
			let idx = index.get(key);
			if (idx === undefined) idx = key < keys[0] ? 0 : bucketCount - 1;
			const bucket = buckets[idx];
			if (!bucket) continue;
			if (row.status === 'published') bucket.published += 1;
			else bucket.failed += 1;
		}
	};

	fill(current, currentKeys, currentIndex, opts.currentRows);
	fill(previous, previousKeys, previousIndex, opts.previousRows);
	return { current, previous };
}

/**
 * Half-open millisecond range for one chart bucket. `end === null` means no
 * upper bound (the current window's last bucket also catches a future stamp).
 * Ranges are already clipped to the rolling window `buildInsightSeries` uses,
 * including the clamp of a stamp whose local day falls outside the keys.
 */
export interface InsightBound {
	start: number;
	end: number | null;
}

export interface InsightFrames {
	sinceMs: number;
	previousSinceMs: number;
	currentLabels: string[];
	previousLabels: string[];
	currentBounds: InsightBound[];
	previousBounds: InsightBound[];
}

const zonedFormatters = new Map<string, Intl.DateTimeFormat>();

function resolvedTimeZone(timeZone: string): string {
	try {
		new Intl.DateTimeFormat('en-CA', { timeZone }).format(0);
		return timeZone;
	} catch {
		return 'UTC';
	}
}

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
	const zone = resolvedTimeZone(timeZone);
	const cached = zonedFormatters.get(zone);
	if (cached) return cached;
	const fmt = new Intl.DateTimeFormat('en-US', {
		timeZone: zone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	});
	zonedFormatters.set(zone, fmt);
	return fmt;
}

function zonedParts(ms: number, timeZone: string) {
	const parts = zonedFormatter(timeZone).formatToParts(new Date(ms));
	const n = (type: Intl.DateTimeFormatPartTypes) =>
		Number(parts.find((p) => p.type === type)?.value ?? '0');
	let hour = n('hour');
	// A few engines report midnight as 24:00 on the previous date.
	if (hour === 24) hour = 0;
	return {
		year: n('year'),
		month: n('month'),
		day: n('day'),
		hour,
		minute: n('minute'),
		second: n('second')
	};
}

/** UTC instant of local midnight at the start of `key` (YYYY-MM-DD). */
export function localDayStartMs(key: string, timeZone: string): number {
	const [y, m, d] = key.split('-').map(Number);
	const year = y ?? 1970;
	const month = m ?? 1;
	const day = d ?? 1;
	let utc = Date.UTC(year, month - 1, day);
	for (let i = 0; i < 4; i++) {
		const p = zonedParts(utc, timeZone);
		const got = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
		const want = Date.UTC(year, month - 1, day);
		if (got === want) return utc;
		utc += want - got;
	}
	return utc;
}

function windowKeys(nowMs: number, days: InsightRange, timeZone: string) {
	const span = rangeSpanDays(days);
	const todayKey = localDayKey(nowMs, timeZone);
	const currentKeys: string[] = [];
	for (let i = span - 1; i >= 0; i--) currentKeys.push(addDays(todayKey, -i));
	const previousKeys = currentKeys.map((key) => addDays(key, -span));
	return { span, currentKeys, previousKeys };
}

function boundsFor(
	keys: string[],
	timeZone: string,
	weekly: boolean,
	winStart: number,
	winEnd: number | null
): InsightBound[] {
	const bucketCount = weekly ? keys.length / 7 : keys.length;
	const startOf = (index: number) => localDayStartMs(keys[index] ?? keys[0]!, timeZone);
	const bounds: InsightBound[] = [];
	for (let i = 0; i < bucketCount; i++) {
		const first = weekly ? i * 7 : i;
		const next = weekly ? (i + 1) * 7 : i + 1;
		let start = i === 0 ? winStart : startOf(first);
		let end: number | null = next < keys.length ? startOf(next) : winEnd;
		if (i === bucketCount - 1) end = winEnd;
		if (start < winStart) start = winStart;
		if (end != null && end > (winEnd ?? end)) end = winEnd;
		if (end != null && start >= end) {
			bounds.push({ start, end: start });
			continue;
		}
		bounds.push({ start, end });
	}
	return bounds;
}

/**
 * The same buckets as `buildInsightSeries`, as millisecond ranges a SQL
 * `SUM(CASE …)` can count without pulling every target into the isolate.
 * Calendar days stay in the account timezone, including DST.
 */
export function insightFrames(nowMs: number, days: InsightRange, timeZone: string): InsightFrames {
	const weekly = bucketKind(days) === 'week';
	const { span, currentKeys, previousKeys } = windowKeys(nowMs, days, timeZone);
	const sinceMs = nowMs - span * DAY_MS;
	const previousSinceMs = sinceMs - span * DAY_MS;
	const labelsOf = (keys: string[]) =>
		Array.from({ length: weekly ? keys.length / 7 : keys.length }, (_, i) =>
			labelFor(keys[weekly ? i * 7 : i] ?? keys[0]!)
		);
	return {
		sinceMs,
		previousSinceMs,
		currentLabels: labelsOf(currentKeys),
		previousLabels: labelsOf(previousKeys),
		currentBounds: boundsFor(currentKeys, timeZone, weekly, sinceMs, null),
		previousBounds: boundsFor(previousKeys, timeZone, weekly, previousSinceMs, sinceMs)
	};
}

/** Place rows into `insightFrames` bounds. Used to prove the ranges match the series. */
export function tallyInsightFrames(
	currentRows: InsightTargetRow[],
	previousRows: InsightTargetRow[],
	frames: InsightFrames
): { current: InsightBucket[]; previous: InsightBucket[] } {
	const fill = (rows: InsightTargetRow[], labels: string[], bounds: InsightBound[]) => {
		const buckets = labels.map((label) => ({ label, published: 0, failed: 0 }));
		for (const row of rows) {
			if (row.status !== 'published' && row.status !== 'failed') continue;
			const idx = bounds.findIndex(
				(b) => row.updatedAtMs >= b.start && (b.end == null || row.updatedAtMs < b.end)
			);
			const bucket = buckets[idx];
			if (!bucket) continue;
			if (row.status === 'published') bucket.published += 1;
			else bucket.failed += 1;
		}
		return buckets;
	};
	return {
		current: fill(currentRows, frames.currentLabels, frames.currentBounds),
		previous: fill(previousRows, frames.previousLabels, frames.previousBounds)
	};
}

/**
 * Short, stable label for a failure, so the compaction of dozens of raw
 * provider messages into a handful of reasons is deterministic (and testable).
 * Threads reuses the shared Meta-error classifiers, so this can never drift
 * from the retry logic that depends on the same shapes.
 */
export function categorizeFailure(
	platform: string | null | undefined,
	message: string | null | undefined
): string {
	const name = platform ? platformName(platform) : 'Account';
	const raw = message ?? '';
	const s = raw.toLowerCase();
	if (!s.trim()) return `${name} failure`;

	// The connection's platform decides which rule set applies: "LinkedIn does
	// not support threads" must not be read as a Threads failure. Message text
	// only stands in when the row outlived its connection.
	const isThreads = platform === 'threads' || (!platform && s.includes('threads'));
	const isLinkedIn = platform === 'linkedin' || (!platform && s.includes('linkedin'));
	const isInstagram = platform === 'instagram' || (!platform && s.includes('instagram'));

	if (isThreads) {
		if (isThreadsMediaFetchFailure(raw)) return 'Threads media timeout';
		if (isThreadsAuthFailure(raw)) return 'Threads permission';
		if (s.includes('429') || s.includes('rate limit')) return 'Threads rate limit';
		if (s.includes('does not support') || s.includes('not supported'))
			return 'Threads unsupported content';
	}
	if (isInstagram) {
		if (isThreadsMediaFetchFailure(raw)) return 'Instagram media timeout';
		if (isThreadsAuthFailure(raw)) return 'Instagram permission';
		if (s.includes('100 posts a day')) return 'Instagram daily limit';
		if (s.includes('needs a photo or video')) return 'Instagram needs media';
	}
	if (isLinkedIn) {
		if (s.includes('does not support threads') || s.includes('single post'))
			return 'LinkedIn threads unsupported';
		if (s.includes('permission') || s.includes('forbidden') || s.includes('403'))
			return 'LinkedIn permission';
		if (s.includes('does not support') || s.includes('not supported'))
			return 'LinkedIn unsupported content';
	}
	if (s.includes('429') || s.includes('rate limit')) return `${name} rate limit`;
	if (
		s.includes('timeout') ||
		s.includes('timed out') ||
		s.includes('fetch failed') ||
		s.includes('econnrefused') ||
		s.includes('enotfound') ||
		s.includes('network')
	) {
		return `${name} timeout`;
	}
	if (
		s.includes('401') ||
		s.includes('unauthorized') ||
		s.includes('invalid credentials') ||
		s.includes('credentials require') ||
		s.includes('expired') ||
		s.includes('reconnect')
	) {
		return `${name} auth expired`;
	}
	if (s.includes('host not allowed') || s.includes('instance host')) {
		return `${name} host not allowed`;
	}
	if (/max \d|too large|too long|characters|grapheme|byte/.test(s))
		return `${name} rejected the post`;
	return `${name} failed`;
}

/** Failure reasons for a window, most common first, capped for the one-liner. */
export function groupFailureReasons(rows: InsightTargetRow[], limit = 4): FailureReason[] {
	const counts = new Map<string, number>();
	for (const row of rows) {
		if (row.status !== 'failed') continue;
		const label = categorizeFailure(row.platform, row.errorMessage);
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([label, count]) => ({ label, count }))
		.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
		.slice(0, Math.max(1, limit));
}

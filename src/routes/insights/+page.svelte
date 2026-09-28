<script lang="ts">
	import { onMount } from 'svelte';
	import { ChartColumn, X } from '@lucide/svelte';
	import AccountAvatar from '$lib/components/AccountAvatar.svelte';
	import { humanizeError } from '$lib/domain/human-error';
	import { sessionExpiredIfUnauthorized } from '$lib/components/session-expired';
	import { displayHandle, platformName } from '$lib/domain/platforms';
	import { formatRelativeTime } from '$lib/domain/relative-time';

	type Range = 7 | 30 | 90;

	interface Bucket {
		label: string;
		published: number;
		failed: number;
	}

	interface FailureReason {
		label: string;
		count: number;
	}

	interface AccountStat {
		connectionId: string;
		platform: string;
		handle: string | null;
		displayName: string | null;
		avatarUrl: string | null;
		connected: boolean;
		published: number;
		failed: number;
		rate: number | null;
		lastPublishedAt: number | null;
	}

	interface InsightPayload {
		range: { days: Range; spanDays: number; bucket: 'day' | 'week'; buckets: number };
		now: number;
		totals: {
			published: number;
			failed: number;
			rate: number | null;
			scheduled: number;
			nextScheduledAt: number | null;
		};
		previous: { published: number; failed: number; rate: number | null };
		series: { current: Bucket[]; previous: Bucket[] };
		failures: FailureReason[];
		accounts: AccountStat[];
	}

	/**
	 * Every range switch is a fresh request, guarded by a token: a slow
	 * response must never overwrite a newer one. On failure the last good
	 * payload stays on screen (its caption still describes it) with an error
	 * banner above, so a network blip never blanks the page.
	 */
	let { data: pageData } = $props();
	// svelte-ignore state_referenced_locally
	let range = $state<Range>(pageData.insights?.range.days ?? 30);
	const RANGES: Range[] = [7, 30, 90];
	let style = $state<'cum' | 'bars'>('cum');
	// svelte-ignore state_referenced_locally
	let stats = $state<InsightPayload | null>(pageData.insights ?? null);
	// svelte-ignore state_referenced_locally
	let loading = $state(!pageData.insights);
	let error = $state<string | null>(null);
	let requestToken = 0;

	async function load(next: Range) {
		const token = ++requestToken;
		loading = true;
		error = null;
		try {
			const res = await fetch(`/api/insights?days=${next}`);
			// Same helper the other client-fetching pages use: a 401 means the
			// session is gone, not that the page needs a Retry button that can
			// never succeed.
			if (sessionExpiredIfUnauthorized(res)) return;
			const payload = await res.json().catch(() => ({}));
			if (token !== requestToken) return;
			if (!res.ok) {
				error = humanizeError(payload.error || 'Could not load insights');
				return;
			}
			// A 200 with an unexpected body (proxy page, truncated response)
			// must not reach the template, where every field is dereferenced.
			if (!isInsightPayload(payload)) {
				error = 'Unexpected response from the server — retry.';
				return;
			}
			stats = payload;
		} catch {
			if (token === requestToken) {
				error = 'Could not reach the server — check your connection and retry.';
			}
		} finally {
			if (token === requestToken) loading = false;
		}
	}

	function pickRange(next: Range) {
		if (next === range) return;
		range = next;
		void load(next);
	}

	function isInsightPayload(value: unknown): value is InsightPayload {
		if (!value || typeof value !== 'object') return false;
		const candidate = value as Partial<InsightPayload>;
		return (
			!!candidate.range &&
			typeof candidate.range.days === 'number' &&
			!!candidate.totals &&
			typeof candidate.totals.published === 'number' &&
			!!candidate.series &&
			Array.isArray(candidate.series.current) &&
			Array.isArray(candidate.series.previous) &&
			Array.isArray(candidate.failures) &&
			Array.isArray(candidate.accounts)
		);
	}

	onMount(() => {
		if (!stats) void load(range);
	});

	const totalAttempts = $derived((stats?.totals.published ?? 0) + (stats?.totals.failed ?? 0));
	const hasActivity = $derived(
		totalAttempts > 0 || (stats?.totals.scheduled ?? 0) > 0 || (stats?.accounts.length ?? 0) > 0
	);

	function countDelta(current: number, previous: number): string {
		const d = current - previous;
		if (d === 0) return '±0 vs previous';
		return `${d > 0 ? '+' : '−'}${Math.abs(d)} vs previous`;
	}

	function deltaTone(current: number, previous: number): string {
		if (current > previous) return 'text-emerald-700';
		if (current < previous) return 'text-red-700';
		return 'text-stone-500';
	}

	/** "90 days" only covers whole weeks, so it is described as 13 weeks. */
	function rangeWords(days: Range | undefined): string {
		if (!days) return 'selected period';
		return days === 90 ? '13 weeks' : `${days} days`;
	}

	/* ── Chart ─────────────────────────────────────────────────────────────
	   Buckets are already local days (or weeks) with display labels, so the
	   page only lays them out. Heights compare published only: a taller bar
	   always means more posts, and failures are a marker on top. */
	const buckets = $derived(stats?.series.current ?? []);
	const previousBuckets = $derived(stats?.series.previous ?? []);
	const chartMax = $derived(
		Math.max(1, ...buckets.map((b) => b.published), ...previousBuckets.map((b) => b.published))
	);

	function barHeight(value: number): string {
		return `${Math.max(2, (value / chartMax) * 100)}%`;
	}

	/** The newest bucket is always labelled; a stepped label too close to it is dropped so the two never collide. */
	function showBarLabel(index: number): boolean {
		const n = buckets.length;
		if (n <= 7 || index === n - 1) return true;
		const step = n <= 31 ? 5 : 3;
		return index % step === 0 && n - 1 - index >= step / 2;
	}

	const hasFailures = $derived(buckets.some((b) => b.failed > 0));

	const cumulative = $derived.by(() => {
		const acc = (list: Bucket[]) => {
			let n = 0;
			return list.map((b) => (n += b.published));
		};
		return { current: acc(buckets), previous: acc(previousBuckets) };
	});
	const cumulativeMax = $derived(Math.max(1, ...cumulative.current, ...cumulative.previous));

	const CHART_W = 600;
	const CHART_H = 150;
	const CHART_TOP = 8;
	const CHART_BOTTOM = 4;

	function pointX(index: number, count: number): number {
		return ((index + 0.5) / count) * CHART_W;
	}
	function pointY(value: number): number {
		return CHART_H - CHART_BOTTOM - (value / cumulativeMax) * (CHART_H - CHART_TOP - CHART_BOTTOM);
	}
	function linePath(values: number[]): string {
		return values
			.map(
				(value, i) =>
					`${i ? 'L' : 'M'}${pointX(i, values.length).toFixed(1)},${pointY(value).toFixed(1)}`
			)
			.join(' ');
	}
	const currentLine = $derived(linePath(cumulative.current));
	const previousLine = $derived(linePath(cumulative.previous));
	const areaPath = $derived.by(() => {
		const n = cumulative.current.length;
		if (!n) return '';
		return `${currentLine} L${pointX(n - 1, n).toFixed(1)},${CHART_H - CHART_BOTTOM} L${pointX(
			0,
			n
		).toFixed(1)},${CHART_H - CHART_BOTTOM} Z`;
	});

	/* The whole plot is one hit area: the column under the pointer is the
	   active bucket, so a reading never depends on landing on a thin line or
	   a short bar. A stale index from a longer range is ignored rather than
	   reset, which keeps range switches free of effects. */
	let hoverIndex = $state<number | null>(null);
	let keyboardReading = $state(false);
	const active = $derived(hoverIndex !== null && hoverIndex < buckets.length ? hoverIndex : null);

	function indexAt(event: PointerEvent): number | null {
		const n = buckets.length;
		if (!n) return null;
		const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
		if (rect.width <= 0) return null;
		const i = Math.floor(((event.clientX - rect.left) / rect.width) * n);
		return Math.min(n - 1, Math.max(0, i));
	}

	function onPlotPointer(event: PointerEvent) {
		const i = indexAt(event);
		keyboardReading = false;
		if (i !== hoverIndex) hoverIndex = i;
	}

	/* A finger lifting off fires pointerleave, which would hide the reading
	   the tap just asked for, so touch keeps it until the next tap. */
	function onPlotLeave(event: PointerEvent) {
		if (event.pointerType !== 'touch') hoverIndex = null;
	}

	function onPlotKey(event: KeyboardEvent) {
		const n = buckets.length;
		if (!n) return;
		const from = active ?? n - 1;
		let next: number | null;
		switch (event.key) {
			case 'ArrowLeft':
				next = Math.max(0, from - 1);
				break;
			case 'ArrowRight':
				next = Math.min(n - 1, from + 1);
				break;
			case 'Home':
				next = 0;
				break;
			case 'End':
				next = n - 1;
				break;
			case 'Escape':
				next = null;
				break;
			default:
				return;
		}
		event.preventDefault();
		keyboardReading = true;
		hoverIndex = next;
	}

	function onPlotFocus() {
		if (active === null && buckets.length) {
			keyboardReading = true;
			hoverIndex = buckets.length - 1;
		}
	}

	function onPlotBlur() {
		keyboardReading = false;
		hoverIndex = null;
	}

	function pct(index: number, count: number): number {
		return ((index + 0.5) / count) * 100;
	}

	const reading = $derived.by(() => {
		if (active === null || !stats) return null;
		const bucket = buckets[active]!;
		const previous = previousBuckets[active];
		const weekly = stats.range.bucket === 'week';
		return {
			index: active,
			when: weekly ? `Week of ${bucket.label}` : bucket.label,
			previousWhen: previous ? (weekly ? `week of ${previous.label}` : previous.label) : null,
			day: bucket.published,
			failed: bucket.failed,
			current: style === 'cum' ? (cumulative.current[active] ?? 0) : bucket.published,
			previous: style === 'cum' ? (cumulative.previous[active] ?? 0) : (previous?.published ?? 0),
			x: pct(active, buckets.length)
		};
	});

	/** Legend readout: the hovered bucket, or the period totals when nothing is hovered. */
	const legendCurrent = $derived(reading?.current ?? stats?.totals.published ?? 0);
	const legendPrevious = $derived(reading?.previous ?? stats?.previous.published ?? 0);

	const liveText = $derived(
		reading && keyboardReading
			? `${reading.when}: ${reading.current} published${style === 'cum' ? ' so far' : ''}, previous period ${reading.previous}${reading.failed ? `, ${reading.failed} failed` : ''}.`
			: ''
	);

	/* ── Failures ──────────────────────────────────────────────────────── */
	const reasonSummary = $derived(
		(stats?.failures ?? []).map((f) => `${f.label} ×${f.count}`).join(' · ')
	);
	const reasonsCovered = $derived((stats?.failures ?? []).reduce((n, f) => n + f.count, 0));
	const reasonsHidden = $derived(Math.max(0, (stats?.totals.failed ?? 0) - reasonsCovered));

	/* ── Accounts ──────────────────────────────────────────────────────── */
	const accounts = $derived(stats?.accounts ?? []);
	const busiest = $derived(accounts[0] ?? null);

	/** The most recent publish anywhere, for the Last post card. */
	const latestPost = $derived.by(() => {
		let newest: AccountStat | null = null;
		for (const account of accounts) {
			if (!account.lastPublishedAt) continue;
			if (!newest?.lastPublishedAt || account.lastPublishedAt > newest.lastPublishedAt) {
				newest = account;
			}
		}
		if (!newest?.lastPublishedAt) return { text: '—', account: null as AccountStat | null };
		return {
			text: formatRelativeTime(new Date(newest.lastPublishedAt)),
			account: newest as AccountStat
		};
	});

	function lastPost(account: AccountStat): string {
		if (!account.lastPublishedAt) return '—';
		return formatRelativeTime(new Date(account.lastPublishedAt));
	}
</script>

<div
	class="mx-auto flex w-full max-w-2xl flex-1 flex-col"
	aria-busy={loading}
	data-testid="insights-page"
>
	<div class="mb-8 flex flex-wrap items-end justify-between gap-4">
		<div class="flex flex-col gap-2">
			<p class="text-[11px] font-bold tracking-widest text-stone-500 uppercase">Analytics</p>
			<h1 class="text-3xl font-extrabold tracking-tight text-stone-900">Insights</h1>
			<p class="text-[13px] font-medium text-stone-500">
				{#if stats}
					Delivery stats for the last {rangeWords(stats.range.days)}, compared with the previous
					{rangeWords(stats.range.days)}.
				{:else}
					Delivery stats, compared with the period before.
				{/if}
			</p>
		</div>
		<div class="inline-flex rounded-2xl bg-stone-200/50 p-1" role="group" aria-label="Date range">
			{#each RANGES as value (value)}
				<button
					type="button"
					aria-pressed={range === value}
					onclick={() => pickRange(value)}
					class="rounded-xl px-3.5 py-1.5 text-[13px] font-bold transition-colors {range === value
						? 'bg-white text-stone-900 shadow-sm'
						: 'text-stone-500 hover:text-stone-900'}"
				>
					{value} days
				</button>
			{/each}
		</div>
	</div>

	{#if loading && !stats}
		<span class="sr-only">Loading insights…</span>
	{/if}

	{#if error}
		<div
			class="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700"
			role="alert"
		>
			<p class="font-medium">{error}</p>
			<span class="flex items-center gap-3">
				<button
					type="button"
					onclick={() => load(range)}
					class="rounded-full bg-red-600/10 px-3 py-1 text-[12px] font-bold text-red-700 transition-colors hover:bg-red-600/20"
				>
					Retry
				</button>
				<button
					type="button"
					onclick={() => (error = null)}
					aria-label="Dismiss error"
					class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-red-500 transition-colors hover:bg-red-100 hover:text-red-700"
				>
					<X class="h-3.5 w-3.5" />
				</button>
			</span>
		</div>
	{/if}

	{#if !stats && loading}
		<!-- First paint only: skeleton in the real layout's shape. -->
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-3" aria-hidden="true">
			{#each [0, 1, 2] as i (i)}
				<div
					class="animate-pulse rounded-[1.5rem] border border-stone-200/80 bg-white p-4 {i === 2
						? 'col-span-2 sm:col-span-1'
						: ''}"
				>
					<div class="h-6 w-12 rounded bg-stone-100"></div>
					<div class="mt-3 h-3 w-20 rounded bg-stone-100"></div>
				</div>
			{/each}
		</div>
		<div
			class="mt-5 animate-pulse rounded-[2rem] border border-stone-200/80 bg-white p-5"
			aria-hidden="true"
		>
			<div class="h-4 w-32 rounded bg-stone-100"></div>
			<div class="mt-4 h-36 rounded-2xl bg-stone-50"></div>
		</div>
	{:else if stats && !hasActivity}
		<div
			class="flex flex-col items-center justify-center rounded-[2rem] border border-dashed border-stone-200/80 bg-white px-4 py-20 text-center"
		>
			<div
				class="mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-stone-100 bg-stone-50 text-stone-500 shadow-sm"
			>
				<ChartColumn class="h-6 w-6" />
			</div>
			<h3 class="mb-2 text-lg font-extrabold tracking-tight text-stone-900">No data yet</h3>
			<p class="max-w-sm text-[13px] leading-relaxed font-medium text-stone-500">
				Publish a few posts and their delivery stats will show up here.
			</p>
		</div>
	{:else if stats}
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-3" data-testid="insights-stats">
			<div class="rounded-[1.5rem] border border-stone-200/80 bg-white p-4 shadow-sm">
				<p class="text-2xl font-extrabold tracking-tight text-stone-900">
					{stats.totals.published}
				</p>
				<p class="mt-1 text-[11px] font-bold tracking-widest text-stone-500 uppercase">Published</p>
				<p
					class="mt-1 text-[11px] font-bold {deltaTone(
						stats.totals.published,
						stats.previous.published
					)}"
				>
					{countDelta(stats.totals.published, stats.previous.published)}
				</p>
			</div>
			<div class="rounded-[1.5rem] border border-stone-200/80 bg-white p-4 shadow-sm">
				<p class="text-2xl font-extrabold tracking-tight text-stone-900">
					{stats.totals.scheduled}
				</p>
				<p class="mt-1 text-[11px] font-bold tracking-widest text-stone-500 uppercase">Scheduled</p>
				<p class="mt-1 text-[11px] font-bold text-stone-500">
					{stats.totals.nextScheduledAt
						? `next ${formatRelativeTime(new Date(stats.totals.nextScheduledAt))}`
						: stats.totals.scheduled > 0
							? 'no time set'
							: 'nothing queued'}
				</p>
			</div>
			<div
				class="col-span-2 rounded-[1.5rem] border border-stone-200/80 bg-white p-4 shadow-sm sm:col-span-1"
			>
				<p class="text-xl font-extrabold tracking-tight text-stone-900 sm:text-2xl">
					{latestPost.text}
				</p>
				<p class="mt-1 text-[11px] font-bold tracking-widest text-stone-500 uppercase">Last post</p>
				<p class="mt-1 truncate text-[11px] font-bold text-stone-500">
					{latestPost.account ? platformName(latestPost.account.platform) : '—'}
				</p>
			</div>
		</div>

		<div class="mt-7 mb-2.5 flex flex-wrap items-center justify-between gap-3">
			<h2 class="text-[15px] font-extrabold tracking-tight text-stone-900">
				{style === 'cum'
					? 'Published, cumulative'
					: stats.range.bucket === 'week'
						? 'Posts per week'
						: 'Posts per day'}
			</h2>
			<div class="flex flex-wrap items-center gap-2">
				<p class="text-[12px] font-semibold text-stone-500">
					Last {stats.range.days === 90 ? '13 weeks' : `${stats.range.days} days`}
				</p>
				<div
					class="ml-2 inline-flex rounded-xl bg-stone-200/50 p-1"
					role="group"
					aria-label="Chart style"
				>
					<button
						type="button"
						aria-pressed={style === 'cum'}
						onclick={() => (style = 'cum')}
						class="rounded-lg px-2.5 py-1 text-[11px] font-bold transition-colors {style === 'cum'
							? 'bg-white text-stone-900 shadow-sm'
							: 'text-stone-500 hover:text-stone-900'}"
					>
						Cumulative
					</button>
					<button
						type="button"
						aria-pressed={style === 'bars'}
						onclick={() => (style = 'bars')}
						class="rounded-lg px-2.5 py-1 text-[11px] font-bold transition-colors {style === 'bars'
							? 'bg-white text-stone-900 shadow-sm'
							: 'text-stone-500 hover:text-stone-900'}"
					>
						Bars
					</button>
				</div>
			</div>
		</div>

		<div
			class="overflow-hidden rounded-[2rem] border border-stone-200/80 bg-white shadow-[0_8px_30px_-12px_rgb(28_25_23/0.06)]"
			data-testid="insights-chart"
		>
			<div class="p-4 pb-3.5 sm:p-5">
				<div class="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2" data-testid="insights-legend">
					<span class="flex items-center gap-1.5 text-[11px] font-bold text-stone-500">
						{#if style === 'bars'}
							<span class="inline-block h-2.5 w-2.5 rounded-[3px] bg-stone-900"></span>
						{:else}
							<span class="inline-block h-[3px] w-4 rounded bg-stone-900"></span>
						{/if}
						This period
						<span class="text-stone-900 tabular-nums">{legendCurrent}</span>
					</span>
					<span class="flex items-center gap-1.5 text-[11px] font-bold text-stone-500">
						{#if style === 'bars'}
							<span class="inline-block h-2.5 w-2.5 rounded-[3px] bg-stone-300"></span>
						{:else}
							<span class="inline-block h-0 w-4 border-t-[3px] border-dotted border-stone-400"
							></span>
						{/if}
						Previous period
						<span class="text-stone-900 tabular-nums">{legendPrevious}</span>
					</span>
					{#if hasFailures}
						<span class="flex items-center gap-1.5 text-[11px] font-bold text-stone-500">
							<span class="inline-block h-1.5 w-1.5 rounded-full bg-red-500"></span>Failed
						</span>
					{/if}
					{#if reading}
						<span class="ml-auto text-[11px] font-bold text-stone-900">{reading.when}</span>
					{/if}
				</div>

				<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
				<div
					class="relative h-[150px] touch-pan-y rounded-md outline-offset-4 select-none"
					tabindex="0"
					role="group"
					aria-roledescription="chart"
					aria-label="{style === 'cum'
						? 'Cumulative published posts'
						: 'Published posts per bucket'}, this period against the previous period. Use the arrow keys to read each {stats
						.range.bucket}."
					onpointerdown={onPlotPointer}
					onpointermove={onPlotPointer}
					onpointerleave={onPlotLeave}
					onkeydown={onPlotKey}
					onfocus={onPlotFocus}
					onblur={onPlotBlur}
				>
					{#if style === 'bars'}
						<div class="flex h-full items-end gap-1" aria-hidden="true">
							{#each buckets as bucket, i (i)}
								<div
									class="flex h-full min-w-0 flex-1 items-end gap-0.5 transition-opacity duration-100 {reading &&
									reading.index !== i
										? 'opacity-40'
										: ''}"
								>
									<div
										class="min-w-0 flex-1 rounded-t-[3px] bg-stone-900"
										style="height:{barHeight(bucket.published)}"
									></div>
									<div
										class="min-w-0 flex-1 rounded-t-[3px] bg-stone-300"
										style="height:{barHeight(previousBuckets[i]?.published ?? 0)}"
									></div>
								</div>
							{/each}
						</div>
					{:else}
						<svg
							viewBox="0 0 {CHART_W} {CHART_H}"
							preserveAspectRatio="none"
							class="block h-full w-full"
							aria-hidden="true"
						>
							<defs>
								<linearGradient id="insights-area" x1="0" y1="0" x2="0" y2="1">
									<stop offset="0%" stop-color="#1c1917" stop-opacity="0.13"></stop>
									<stop offset="100%" stop-color="#1c1917" stop-opacity="0"></stop>
								</linearGradient>
							</defs>
							<line
								x1="0"
								y1={CHART_H - CHART_BOTTOM}
								x2={CHART_W}
								y2={CHART_H - CHART_BOTTOM}
								stroke="#e7e5e4"
								stroke-width="1"
								vector-effect="non-scaling-stroke"
							></line>
							{#if reading}
								<line
									x1={pointX(reading.index, buckets.length)}
									y1="0"
									x2={pointX(reading.index, buckets.length)}
									y2={CHART_H - CHART_BOTTOM}
									stroke="#d6d3d1"
									stroke-width="1"
									vector-effect="non-scaling-stroke"
								></line>
							{/if}
							<path d={areaPath} fill="url(#insights-area)"></path>
							<path
								d={previousLine}
								fill="none"
								stroke="#a8a29e"
								stroke-width="2"
								stroke-dasharray="2 4"
								stroke-linecap="round"
								stroke-linejoin="round"
								vector-effect="non-scaling-stroke"
							></path>
							<path
								d={currentLine}
								fill="none"
								stroke="#1c1917"
								stroke-width="2.5"
								stroke-linecap="round"
								stroke-linejoin="round"
								vector-effect="non-scaling-stroke"
							></path>
						</svg>
						<!-- Markers are HTML so the stretched viewBox cannot squash them into ovals. -->
						{#if reading}
							<span
								class="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-stone-400 shadow-sm"
								style="left:{reading.x}%;top:{(pointY(reading.previous) / CHART_H) * 100}%"
								aria-hidden="true"
							></span>
							<span
								class="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-stone-900 shadow-sm"
								style="left:{reading.x}%;top:{(pointY(reading.current) / CHART_H) * 100}%"
								aria-hidden="true"
							></span>
						{/if}
					{/if}

					{#if reading}
						<!-- Sits on the far side of the pointer so it never covers the reading. -->
						<div
							class="pointer-events-none absolute top-0 z-10 w-max max-w-[14rem] rounded-xl bg-stone-900 px-3 py-2 text-[11px] font-semibold text-stone-300 shadow-lg"
							style={reading.x > 50
								? `right:calc(${100 - reading.x}% + 12px)`
								: `left:calc(${reading.x}% + 12px)`}
							aria-hidden="true"
							data-testid="insights-tooltip"
						>
							<p class="mb-1 font-bold text-white">{reading.when}</p>
							<p class="flex items-center justify-between gap-4">
								<span class="flex items-center gap-1.5">
									<span class="inline-block h-2 w-2 rounded-full bg-white"></span>This period
								</span>
								<span class="font-bold text-white tabular-nums">{reading.current}</span>
							</p>
							{#if style === 'cum'}
								<p class="pl-3.5 text-stone-400">+{reading.day} that {stats.range.bucket}</p>
							{/if}
							<p class="mt-0.5 flex items-center justify-between gap-4">
								<span class="flex items-center gap-1.5">
									<span class="inline-block h-2 w-2 rounded-full bg-stone-400"></span>Previous
								</span>
								<span class="font-bold text-white tabular-nums">{reading.previous}</span>
							</p>
							{#if reading.previousWhen}
								<p class="pl-3.5 text-stone-400">{reading.previousWhen}</p>
							{/if}
							{#if reading.failed > 0}
								<p class="mt-0.5 flex items-center justify-between gap-4 text-red-300">
									<span class="flex items-center gap-1.5">
										<span class="inline-block h-2 w-2 rounded-full bg-red-400"></span>Failed
									</span>
									<span class="font-bold tabular-nums">{reading.failed}</span>
								</p>
							{/if}
						</div>
					{/if}
				</div>
				<p class="sr-only" aria-live="polite">{liveText}</p>

				{#if hasFailures}
					<div
						class="relative mt-1.5 h-1.5"
						aria-hidden="true"
						data-testid="insights-failure-marks"
					>
						{#each buckets as bucket, i (i)}
							{#if bucket.failed > 0}
								<span
									class="absolute top-0 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-red-500"
									style="left:{pct(i, buckets.length)}%"
								></span>
							{/if}
						{/each}
					</div>
				{/if}

				<!-- Labels are wider than a day's column; flex alignment makes the edge ones overflow inward instead of being clipped by the card. -->
				<div class="mt-2.5 flex gap-1">
					{#each buckets as bucket, i (i)}
						<span
							class="flex min-w-0 flex-1 text-[10px] font-bold tracking-wider whitespace-nowrap uppercase {i ===
							0
								? 'justify-start'
								: i === buckets.length - 1
									? 'justify-end'
									: 'justify-center'} {reading?.index === i ? 'text-stone-900' : 'text-stone-500'}"
						>
							{showBarLabel(i) ? bucket.label : ''}
						</span>
					{/each}
				</div>
			</div>
		</div>

		<p
			class="mt-4 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12.5px] font-medium text-stone-600"
			data-testid="insights-failures"
		>
			{#if stats.totals.failed === 0}
				<span class="text-stone-500">No failures in this period.</span>
			{:else}
				<strong class="text-[13px] font-extrabold text-stone-900"
					>{stats.totals.failed} failed</strong
				>
				<span class="text-stone-500"
					>— {reasonSummary}{#if reasonsHidden > 0}, {reasonsHidden} more{/if}</span
				>
				<a
					href="/posts?tab=failed"
					class="text-[12px] font-extrabold whitespace-nowrap text-stone-900 hover:underline"
				>
					Review in Posts →
				</a>
			{/if}
		</p>

		<div class="mt-7 mb-2.5 flex items-center justify-between gap-3">
			<h2 class="text-[15px] font-extrabold tracking-tight text-stone-900">Accounts</h2>
			<p class="text-[12px] font-semibold text-stone-500">
				{stats.range.days === 90 ? '13 weeks' : `${stats.range.days} days`} · {accounts.length}
				{accounts.length === 1 ? 'account' : 'accounts'}
			</p>
		</div>
		<div
			class="overflow-hidden rounded-[2rem] border border-stone-200/80 bg-white shadow-[0_8px_30px_-12px_rgb(28_25_23/0.06)]"
			data-testid="insights-accounts"
		>
			{#each accounts as account, index (account.connectionId)}
				<div
					class="flex flex-wrap items-center justify-between gap-3 px-5 py-4 sm:flex-nowrap sm:gap-4 {index !==
					accounts.length - 1
						? 'border-b border-stone-100'
						: ''}"
					data-testid="insight-account"
				>
					<div class="flex min-w-0 items-center gap-3">
						<AccountAvatar
							platform={account.platform}
							handle={account.handle}
							displayName={account.displayName}
							avatarUrl={account.avatarUrl}
							size={40}
						/>
						<div class="min-w-0">
							<h3
								class="truncate text-[14.5px] leading-tight font-extrabold tracking-tight text-stone-900"
							>
								{platformName(account.platform)}
								{#if !account.connected}
									<span
										class="ml-2 rounded bg-stone-100 px-1.5 py-0.5 text-[10px] font-bold tracking-widest text-stone-500 uppercase"
										>Archived</span
									>
								{/if}
							</h3>
							<p class="mt-0.5 truncate text-[12.5px] font-medium text-stone-500">
								{account.displayName || displayHandle(account.handle)}
							</p>
						</div>
					</div>
					<div
						class="flex w-full items-center justify-between gap-3 sm:w-auto sm:justify-end sm:gap-6"
					>
						<div class="text-right">
							<p class="text-[15px] font-extrabold text-stone-900">
								{account.published}
							</p>
							<p class="mt-0.5 text-[10px] font-bold tracking-widest text-stone-500 uppercase">
								Published
							</p>
						</div>
						<div class="min-w-14 text-right">
							<p class="text-[15px] font-extrabold text-stone-900">
								{lastPost(account)}
							</p>
							<p class="mt-0.5 text-[10px] font-bold tracking-widest text-stone-500 uppercase">
								Last post
							</p>
						</div>
					</div>
				</div>
			{/each}
			{#if accounts.length > 0}
				<p
					class="border-t border-stone-100 px-5 py-3 text-[12px] font-semibold text-stone-500"
					data-testid="insights-account-note"
				>
					{#if stats.totals.published >= 10 && busiest}
						Most posts: {platformName(busiest.platform)} — {busiest.published} of {stats.totals
							.published}.
					{/if}
				</p>
			{/if}
		</div>

		<p class="mt-5 text-[12px] leading-relaxed font-medium text-stone-500">
			From your publish history. Times are local.
		</p>
	{/if}
</div>

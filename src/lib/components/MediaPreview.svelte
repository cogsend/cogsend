<script lang="ts" module>
	import type { MediaShape } from '#lib/domain/media-layout.js';

	export type PreviewItem = MediaShape & {
		id: string;
		altText: string | null;
		/** A local copy shown before (or instead of) the stored one. */
		previewUrl?: string;
	};

	export type PreviewProgress = {
		label: string;
		/** 0–1. */
		fraction: number;
		onCancel: () => void;
		cancelLabel: string;
		testId: string;
		cancelTestId: string;
	};
</script>

<script lang="ts">
	import { Play } from '@lucide/svelte';
	import type { Snippet } from 'svelte';
	import {
		aspectOf,
		coverUrl,
		frameFor,
		gridFor,
		imageUrl,
		isVideoMedia,
		MEDIA_BASE,
		mediaUrl
	} from '#lib/domain/media-layout.js';
	import { formatDuration } from '#lib/domain/video-rules.js';

	let {
		items,
		maxHeight,
		progress = null,
		extra = 0,
		toolbar,
		testId,
		mediaBase = MEDIA_BASE
	}: {
		items: PreviewItem[];
		/** The tallest the media may stand, in CSS pixels. */
		maxHeight: number;
		/** A video still being prepared or uploaded; it has no item yet. */
		progress?: PreviewProgress | null;
		/** Attachments beyond the ones shown, counted on the last tile. */
		extra?: number;
		toolbar?: Snippet<[PreviewItem]>;
		testId?: string;
		/** Where the files are served from; a preview link has its own route. */
		mediaBase?: string;
	} = $props();

	// Sizes read off the loaded image, for rows stored before sizes were kept
	// and for a local preview the server has not measured yet.
	let natural = $state<Record<string, number>>({});
	// A video becomes a <video> only once someone asks to play it, so a list
	// of posts never downloads one nobody watches.
	let playing = $state<string | null>(null);

	const shown = $derived(items.slice(0, 4));
	const grid = $derived(gridFor(shown.length));
	const single = $derived(shown.length === 1 ? shown[0] : null);
	const frame = $derived(
		single
			? frameFor(aspectOf(single) ?? natural[single.id] ?? null, maxHeight)
			: frameFor(progress ? null : 16 / 9, maxHeight)
	);

	function srcOf(m: PreviewItem): string {
		return m.previewUrl || mediaUrl(m, mediaBase);
	}

	function measure(m: PreviewItem, el: HTMLImageElement) {
		if (aspectOf(m) || !el.naturalWidth || !el.naturalHeight) return;
		natural[m.id] = el.naturalWidth / el.naturalHeight;
	}

	function label(m: PreviewItem, i: number): string {
		const kind = isVideoMedia(m) ? 'video' : 'image';
		return m.altText || `Attached ${kind} ${i + 1}`;
	}
</script>

{#snippet tile(m: PreviewItem, i: number, fit: 'contain' | 'cover')}
	{#if isVideoMedia(m)}
		{#if playing === m.id}
			<!-- svelte-ignore a11y_media_has_caption -->
			<video
				src={srcOf(m)}
				poster={coverUrl(m, mediaBase) ?? undefined}
				controls
				autoplay
				playsinline
				preload="metadata"
				aria-label={label(m, i)}
				class="h-full w-full bg-black object-contain"
			></video>
		{:else}
			{@const cover = coverUrl(m, mediaBase)}
			<button
				type="button"
				class="group/play relative block h-full w-full bg-stone-900"
				aria-label={`Play ${label(m, i)}`}
				data-testid="media-play-{m.id}"
				onclick={() => (playing = m.id)}
			>
				{#if cover}
					<img
						src={cover}
						alt=""
						loading="lazy"
						decoding="async"
						onload={(e) => measure(m, e.currentTarget as HTMLImageElement)}
						class="h-full w-full {fit === 'contain' ? 'object-contain' : 'object-cover'}"
					/>
				{/if}
				<span
					class="absolute top-1/2 left-1/2 flex h-12 w-12 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white shadow-lg backdrop-blur-sm transition-transform group-hover/play:scale-105"
					aria-hidden="true"
				>
					<Play class="ml-0.5 h-5 w-5" fill="currentColor" />
				</span>
				{#if m.meta?.durationMs}
					<span
						class="absolute bottom-2 left-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] font-bold text-white tabular-nums"
						aria-hidden="true"
					>
						{formatDuration(m.meta.durationMs)}
					</span>
				{/if}
			</button>
		{/if}
	{:else}
		<img
			src={m.previewUrl || imageUrl(m, mediaBase)}
			alt={label(m, i)}
			loading="lazy"
			decoding="async"
			onload={(e) => measure(m, e.currentTarget as HTMLImageElement)}
			class="h-full w-full {fit === 'contain' ? 'object-contain' : 'object-cover'}"
		/>
	{/if}
	{#if toolbar}
		<div class="absolute top-2 right-2 z-10 flex items-center gap-1.5">
			{@render toolbar(m)}
		</div>
	{/if}
	{#if i === shown.length - 1 && extra > 0}
		<div
			class="pointer-events-none absolute inset-0 flex items-center justify-center bg-stone-900/60 text-lg font-extrabold text-white"
			role="img"
			aria-label={`${extra} more attachment${extra === 1 ? '' : 's'}`}
		>
			+{extra}
		</div>
	{/if}
{/snippet}

<div
	class="relative overflow-hidden rounded-2xl border border-stone-200/80 bg-stone-100"
	style="aspect-ratio: {frame.aspect}; width: min(100%, {frame.maxWidth}px);"
	data-testid={testId}
>
	{#if progress && !single}
		<div
			class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-stone-900 text-white"
			data-testid={progress.testId}
			role="status"
			aria-live="polite"
		>
			<span class="text-[13px] font-bold">{progress.label}</span>
			<button
				type="button"
				data-testid={progress.cancelTestId}
				onclick={progress.onCancel}
				class="rounded-full bg-white/15 px-3 py-1 text-[12px] font-bold text-white transition-colors hover:bg-white/25"
				aria-label={progress.cancelLabel}
			>
				Cancel
			</button>
			<div class="absolute inset-x-0 bottom-0 h-1 bg-white/15">
				<div
					class="h-full bg-white transition-[width] duration-300"
					style="width: {Math.round(progress.fraction * 100)}%"
				></div>
			</div>
		</div>
	{:else if single}
		<div class="relative h-full w-full">
			{@render tile(single, 0, 'contain')}
		</div>
	{:else}
		<div
			class="grid h-full w-full gap-0.5"
			style="grid-template-columns: 1fr 1fr; grid-template-rows: repeat({grid.rows}, minmax(0, 1fr));"
		>
			{#each shown as m, i (m.id)}
				<div
					class="relative min-h-0 min-w-0 overflow-hidden"
					style="grid-column: {grid.cells[i].column}; grid-row: {grid.cells[i].row};"
				>
					{@render tile(m, i, 'cover')}
				</div>
			{/each}
		</div>
	{/if}
</div>

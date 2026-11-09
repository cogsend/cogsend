<script lang="ts" module>
	export type LibraryFile = {
		storageKey: string;
		mime: string;
		size: number;
		width: number | null;
		height: number | null;
		altText: string | null;
		meta: {
			cover?: { v?: number } | null;
			preview?: { v?: number } | null;
			durationMs?: number | null;
		} | null;
	};
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import { Check, ImageOff, Play } from '@lucide/svelte';
	import { dialogFocus } from '#lib/components/dialog-focus.js';
	import { coverUrl, imageUrl } from '#lib/domain/media-layout.js';
	import { MAX_IMAGES_PER_SEGMENT } from '#lib/domain/media-limits.js';
	import { formatDuration } from '#lib/domain/video-rules.js';

	let {
		card,
		busy = false,
		onAttach,
		onClose
	}: {
		/** What the card being added to already holds. */
		card: { images: number; video: boolean; room: number };
		busy?: boolean;
		onAttach: (files: LibraryFile[]) => void;
		onClose: () => void;
	} = $props();

	let files = $state<LibraryFile[]>([]);
	let next = $state<string | null>(null);
	let loading = $state(false);
	let loaded = $state(false);
	let problem = $state<string | null>(null);
	let picked = $state<string[]>([]);
	let broken = $state<string[]>([]);

	const isVideo = (f: LibraryFile) => f.mime.toLowerCase().startsWith('video/');
	const pickedFiles = $derived(
		picked.flatMap((key) => files.filter((f) => f.storageKey === key).slice(0, 1))
	);
	const pickedVideo = $derived(pickedFiles.some(isVideo));

	async function load(before: string | null) {
		loading = true;
		problem = null;
		try {
			const query = before ? `?before=${encodeURIComponent(before)}` : '';
			const res = await fetch(`/api/media${query}`);
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.error || 'Could not load your media');
			const seen = new Set(files.map((f) => f.storageKey));
			files = [
				...files,
				...((data.items ?? []) as LibraryFile[]).filter((f) => !seen.has(f.storageKey))
			];
			next = typeof data.next === 'string' ? data.next : null;
			loaded = true;
		} catch (e) {
			problem = e instanceof Error ? e.message : 'Could not load your media';
		} finally {
			loading = false;
		}
	}

	onMount(() => void load(null));

	/** Why `f` cannot be picked now, mirroring what the server refuses. */
	function blocked(f: LibraryFile): string | null {
		if (picked.includes(f.storageKey)) return null;
		if (broken.includes(f.storageKey)) return 'This file could not be loaded';
		if (card.video) return 'This post has a video, which goes on its own';
		if (isVideo(f)) {
			if (card.images > 0) return 'A video needs a post of its own';
			if (picked.length) return 'A video goes on its own';
			return null;
		}
		if (pickedVideo) return 'A video goes on its own';
		if (picked.length >= card.room) {
			return card.room > 0
				? `A post takes at most ${MAX_IMAGES_PER_SEGMENT} images`
				: 'This post is full';
		}
		return null;
	}

	function toggle(f: LibraryFile) {
		if (busy) return;
		if (picked.includes(f.storageKey)) {
			picked = picked.filter((key) => key !== f.storageKey);
		} else if (!blocked(f)) {
			picked = [...picked, f.storageKey];
		}
	}

	const describe = (f: LibraryFile) =>
		f.altText || (isVideo(f) ? 'Video without a description' : 'Image without alt text');

	const attachLabel = $derived(
		busy
			? 'Attaching…'
			: picked.length > 1
				? `Attach ${picked.length}`
				: pickedVideo
					? 'Attach video'
					: 'Attach'
	);
</script>

<div
	role="presentation"
	class="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
	onclick={(e) => {
		if (e.target === e.currentTarget && !busy) onClose();
	}}
>
	<div
		role="dialog"
		aria-modal="true"
		aria-labelledby="media-library-title"
		aria-describedby="media-library-body"
		data-testid="media-library"
		class="flex max-h-[90dvh] w-full max-w-lg flex-col rounded-[1.5rem] border border-stone-200/80 bg-white/95 p-5 shadow-[0_16px_40px_-12px_rgb(28_25_23/0.15)] backdrop-blur-xl"
		use:dialogFocus={{ onEscape: () => !busy && onClose() }}
	>
		<h2 id="media-library-title" class="text-sm font-semibold">Your media</h2>
		<p id="media-library-body" class="mt-1 text-xs text-[var(--muted)]">
			Images and videos used in your posts. Attaching one stores nothing new, and you can change its
			alt text in this post without changing the others.
		</p>

		<div class="mt-3 min-h-0 flex-1 overflow-y-auto">
			{#if !loaded && loading}
				<p class="py-8 text-center text-xs font-medium text-stone-500">Loading…</p>
			{:else if loaded && files.length === 0}
				<p class="py-8 text-center text-xs font-medium text-stone-500">
					Nothing here yet. Images and videos you attach to posts show up here.
				</p>
			{:else}
				<ul class="grid grid-cols-3 gap-2 sm:grid-cols-4" aria-label="Your media">
					{#each files as f (f.storageKey)}
						{@const reason = blocked(f)}
						{@const on = picked.includes(f.storageKey)}
						{@const cover = isVideo(f) ? coverUrl(f) : null}
						<li>
							<button
								type="button"
								data-testid="media-library-file"
								data-key={f.storageKey}
								aria-pressed={on}
								aria-label={reason ? `${describe(f)}. ${reason}` : describe(f)}
								title={reason ?? f.altText ?? undefined}
								disabled={Boolean(reason) || busy}
								onclick={() => toggle(f)}
								class="relative block aspect-square w-full overflow-hidden rounded-xl border border-stone-200/80 bg-stone-100 transition hover:border-stone-400 disabled:cursor-not-allowed disabled:opacity-40"
							>
								{#if broken.includes(f.storageKey)}
									<span class="flex h-full w-full items-center justify-center text-stone-400">
										<ImageOff class="h-5 w-5" />
									</span>
								{:else if isVideo(f)}
									{#if cover}
										<img
											src={cover}
											alt=""
											loading="lazy"
											class="h-full w-full object-cover"
											onerror={() => (broken = [...broken, f.storageKey])}
										/>
									{:else}
										<span class="block h-full w-full bg-stone-800"></span>
									{/if}
									<span
										class="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] font-bold text-white"
									>
										<Play class="h-2.5 w-2.5 fill-current" />
										{f.meta?.durationMs ? formatDuration(f.meta.durationMs) : 'Video'}
									</span>
								{:else}
									<img
										src={imageUrl(f)}
										alt=""
										loading="lazy"
										class="h-full w-full object-cover"
										onerror={() => (broken = [...broken, f.storageKey])}
									/>
								{/if}
								{#if on}
									<!-- Over the picture: a ring outside the tile is clipped by the scroll area. -->
									<span
										class="pointer-events-none absolute inset-0 rounded-xl ring-3 ring-stone-900 ring-inset"
									></span>
									<span
										class="absolute top-1.5 right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-stone-900 text-white"
									>
										<Check class="h-3 w-3" />
									</span>
								{/if}
							</button>
						</li>
					{/each}
				</ul>
				{#if next}
					<div class="mt-3 flex justify-center">
						<button
							type="button"
							onclick={() => void load(next)}
							disabled={loading}
							class="rounded-full border border-stone-200 px-3 py-1.5 text-xs font-bold text-stone-700 hover:border-stone-300 disabled:opacity-50"
						>
							{loading ? 'Loading…' : 'Load more'}
						</button>
					</div>
				{/if}
			{/if}
			{#if problem}
				<p class="mt-2 text-xs font-medium text-red-700" role="alert">{problem}</p>
			{/if}
		</div>

		<div class="mt-4 flex items-center justify-end gap-2">
			<button
				type="button"
				onclick={onClose}
				disabled={busy}
				class="rounded-full border border-stone-200 px-4 py-1.5 text-sm font-bold text-stone-500 hover:border-stone-300 hover:text-stone-900 disabled:opacity-50"
			>
				Cancel
			</button>
			<button
				type="button"
				data-testid="media-library-attach"
				onclick={() => onAttach(pickedFiles)}
				disabled={!picked.length || busy}
				class="rounded-full bg-stone-900 px-4 py-1.5 text-sm font-bold text-white hover:bg-stone-800 disabled:opacity-50"
			>
				{attachLabel}
			</button>
		</div>
	</div>
</div>

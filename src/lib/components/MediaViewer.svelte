<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { ChevronLeft, ChevronRight, X } from '@lucide/svelte';
	import { dialogFocus } from '#lib/components/dialog-focus.js';
	import { portal } from '#lib/components/portal.js';
	import { imageUrl, MEDIA_BASE } from '#lib/domain/media-layout.js';
	import type { PreviewItem } from './MediaPreview.svelte';

	let {
		items,
		start = 0,
		mediaBase = MEDIA_BASE,
		onClose
	}: {
		/** Images only: a video plays where it is. */
		items: PreviewItem[];
		start?: number;
		mediaBase?: string;
		onClose: () => void;
	} = $props();

	let index = $state(untrack(() => start));
	const item = $derived(items[Math.min(index, items.length - 1)]);
	const many = $derived(items.length > 1);

	const srcOf = (m: PreviewItem) => m.previewUrl || imageUrl(m, mediaBase);

	// The images either side are fetched ahead, so moving to one shows it at once.
	$effect(() => {
		if (!many) return;
		for (const by of [1, -1]) {
			const near = items[(index + by + items.length) % items.length];
			new Image().src = srcOf(near);
		}
	});

	function step(by: number) {
		index = (index + by + items.length) % items.length;
	}

	function onKey(e: KeyboardEvent) {
		if (!many) return;
		if (e.key === 'ArrowLeft') step(-1);
		else if (e.key === 'ArrowRight') step(1);
		else return;
		e.preventDefault();
	}

	// A swipe moves between images; its pointerup must not also count as a
	// click on the backdrop, which would close the viewer.
	let downX: number | null = null;
	let swiped = false;
	function onPointerDown(e: PointerEvent) {
		downX = e.clientX;
		swiped = false;
	}
	function onPointerUp(e: PointerEvent) {
		if (downX === null) return;
		const dx = e.clientX - downX;
		downX = null;
		if (many && Math.abs(dx) > 50) {
			swiped = true;
			step(dx < 0 ? 1 : -1);
		}
	}

	// The page behind stays put while the viewer is open.
	onMount(() => {
		const root = document.documentElement;
		const before = root.style.overflow;
		root.style.overflow = 'hidden';
		return () => {
			root.style.overflow = before;
		};
	});
</script>

<svelte:window onkeydown={onKey} />

<div
	use:portal
	role="presentation"
	class="fixed inset-0 z-50 touch-pan-y bg-black/95 select-none"
	onpointerdown={onPointerDown}
	onpointerup={onPointerUp}
	onpointercancel={() => (downX = null)}
	onclick={(e) => {
		if (e.target === e.currentTarget && !swiped) onClose();
	}}
>
	<!-- Clicks pass through the dialog's empty space to the backdrop, which
	     closes it; only the picture, its caption and the buttons take them. -->
	<div
		use:dialogFocus={{ onEscape: onClose }}
		role="dialog"
		aria-modal="true"
		aria-label={many ? `Image ${index + 1} of ${items.length}` : 'Image'}
		data-testid="media-viewer"
		class="pointer-events-none absolute inset-0 flex items-center justify-center px-4 py-14 sm:px-16"
	>
		<!-- Read out as the viewer moves: the counter on screen is hidden from it. -->
		<p class="sr-only" aria-live="polite" data-testid="media-viewer-announce">
			{many ? `Image ${index + 1} of ${items.length}` : 'Image'}{item.altText
				? `: ${item.altText}`
				: ''}
		</p>
		<button
			type="button"
			data-testid="media-viewer-close"
			onclick={onClose}
			class="pointer-events-auto absolute top-3 right-3 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
			aria-label="Close"
		>
			<X class="h-5 w-5" />
		</button>
		{#if many}
			<p
				class="absolute top-5 left-4 text-xs font-bold text-white/70"
				data-testid="media-viewer-count"
				aria-hidden="true"
			>
				{index + 1} / {items.length}
			</p>
		{/if}

		<figure class="flex w-full flex-col items-center gap-3">
			<!-- Sized to the picture itself, so a click beside it reaches the backdrop;
			     the height leaves room for the padding and up to four caption lines. -->
			<img
				src={srcOf(item)}
				alt={item.altText || ''}
				draggable="false"
				class="pointer-events-auto h-auto max-w-full rounded-lg {item.altText
					? 'max-h-[calc(100dvh-13rem)]'
					: 'max-h-[calc(100dvh-7rem)]'}"
			/>
			{#if item.altText}
				<figcaption
					class="pointer-events-auto line-clamp-4 max-w-xl text-center text-[13px] leading-relaxed text-white/80"
					data-testid="media-viewer-alt"
				>
					{item.altText}
				</figcaption>
			{/if}
		</figure>

		{#if many}
			<button
				type="button"
				data-testid="media-viewer-prev"
				onclick={() => step(-1)}
				class="pointer-events-auto absolute top-1/2 left-2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 sm:left-4"
				aria-label="Previous image"
			>
				<ChevronLeft class="h-5 w-5" />
			</button>
			<button
				type="button"
				data-testid="media-viewer-next"
				onclick={() => step(1)}
				class="pointer-events-auto absolute top-1/2 right-2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 sm:right-4"
				aria-label="Next image"
			>
				<ChevronRight class="h-5 w-5" />
			</button>
		{/if}
	</div>
</div>

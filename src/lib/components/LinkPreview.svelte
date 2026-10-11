<script lang="ts" module>
	// Shared across all composer segments, so N thread cards showing the same
	// URL fetch it once rather than once each. Bounded LRU-ish (oldest evicted
	// past 50).
	const sharedPreviewCache = new Map<string, Preview>();
	type Preview = {
		url: string;
		title: string;
		description: string;
		image: string | null;
		siteName: string | null;
	};
	function getSharedPreview(url: string): Preview | undefined {
		return sharedPreviewCache.get(url);
	}
	function setSharedPreview(url: string, data: Preview) {
		if (!sharedPreviewCache.has(url) && sharedPreviewCache.size >= 50) {
			const oldest = sharedPreviewCache.keys().next().value;
			if (oldest !== undefined) sharedPreviewCache.delete(oldest);
		}
		sharedPreviewCache.set(url, data);
	}
</script>

<script lang="ts">
	import { extractFirstUrl, previewDomain } from '#lib/domain/links.js';

	let { text = '', hasMedia = false }: { text: string; hasMedia: boolean } = $props();

	let preview = $state<Preview | null>(null);
	let loading = $state(false);
	let dismissedFor = $state<string | null>(null);
	let seq = 0;

	const candidate = $derived(hasMedia ? null : extractFirstUrl(text || ''));

	$effect(() => {
		const url = candidate;
		// Media wins: suppress the card (standard across Bluesky/Mastodon/
		// Threads/LinkedIn — attachments replace the link card).
		if (!url) {
			preview = null;
			loading = false;
			dismissedFor = null;
			return;
		}
		if (dismissedFor === url) {
			preview = null;
			loading = false;
			return;
		}
		const cached = getSharedPreview(url);
		if (cached) {
			preview = cached;
			loading = false;
			return;
		}
		const my = ++seq;
		loading = true;
		const timer = setTimeout(async () => {
			try {
				const res = await fetch(`/api/link-preview?url=${encodeURIComponent(url)}`);
				if (seq !== my) return;
				if (!res.ok) {
					preview = null;
					loading = false;
					return;
				}
				const data = (await res.json()) as Preview;
				setSharedPreview(url, data);
				if (seq === my && extractFirstUrl(text || '') === url && !hasMedia) {
					preview = data;
				}
			} catch {
				if (seq === my) {
					preview = null;
				}
			} finally {
				if (seq === my) loading = false;
			}
		}, 450);
		return () => clearTimeout(timer);
	});

	const domain = $derived(preview ? (previewDomain(preview.url) ?? preview.siteName) : null);
</script>

{#if candidate && !hasMedia && dismissedFor !== candidate}
	{#if loading && !preview}
		<div
			class="mt-3 animate-pulse rounded-xl border border-stone-200/80 bg-stone-50 p-3"
			data-testid="link-preview-loading"
			aria-label="Loading link preview"
		>
			<div class="h-3 w-2/3 rounded bg-stone-200"></div>
			<div class="mt-2 h-3 w-1/3 rounded bg-stone-200"></div>
		</div>
	{:else if preview}
		<div
			class="mt-3 overflow-hidden rounded-xl border border-stone-200/80 bg-white"
			data-testid="link-preview"
		>
			{#if preview.image}
				<img
					src={preview.image}
					alt=""
					loading="lazy"
					decoding="async"
					class="max-h-48 w-full object-cover"
					onerror={(e) => {
						(e.currentTarget as HTMLImageElement).style.display = 'none';
					}}
				/>
			{/if}
			<div class="flex items-start gap-2 p-3">
				<div class="min-w-0 flex-1">
					{#if domain}
						<div class="text-[10px] font-bold tracking-widest text-stone-500 uppercase">
							{domain}
						</div>
					{/if}
					{#if preview.title}
						<div class="truncate text-[13px] font-bold text-stone-900">{preview.title}</div>
					{/if}
					{#if preview.description}
						<div class="mt-0.5 line-clamp-2 text-[12px] font-medium text-stone-500">
							{preview.description}
						</div>
					{/if}
				</div>
				<button
					type="button"
					class="flex min-h-6 min-w-6 items-center justify-center rounded-md px-1.5 py-0.5 text-[11px] font-bold text-stone-500 hover:bg-stone-100 hover:text-stone-700"
					title="Hide preview (link stays in text)"
					aria-label="Hide link preview"
					onclick={() => {
						if (candidate) dismissedFor = candidate;
						preview = null;
					}}
				>
					✕
				</button>
			</div>
		</div>
	{/if}
{/if}

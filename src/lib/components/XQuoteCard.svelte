<script lang="ts" module>
	type XPost = { name: string; handle: string; text: string; date: string };
	type Loaded = { kind: 'post'; post: XPost } | { kind: 'gone' };

	// Shared across cards and remounts: switching tabs or typing must not refetch
	// a post already shown. Failures are not cached, so a later card retries.
	const loadedCache = new Map<string, Loaded>();
	function remember(url: string, value: Loaded) {
		if (!loadedCache.has(url) && loadedCache.size >= 50) {
			const oldest = loadedCache.keys().next().value;
			if (oldest !== undefined) loadedCache.delete(oldest);
		}
		loadedCache.set(url, value);
	}
</script>

<script lang="ts">
	import { TriangleAlert, X } from '@lucide/svelte';
	import { parseXPostUrl, quotedPostText } from '$lib/domain/x-quote';
	import { platformName } from '$lib/domain/platforms';

	let {
		url,
		onRemove,
		otherPlatforms = []
	}: { url: string; onRemove: () => void; otherPlatforms?: string[] } = $props();

	let loaded = $state<Loaded | null>(null);
	let loading = $state(false);
	let seq = 0;

	const ref = $derived(parseXPostUrl(url));
	const othersLabel = $derived.by(() => {
		const names = otherPlatforms.map((p) => platformName(p));
		if (names.length <= 1) return names[0] ?? '';
		return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
	});

	$effect(() => {
		const current = url;
		const my = ++seq;
		const cached = loadedCache.get(current);
		if (cached) {
			loaded = cached;
			loading = false;
			return;
		}
		loaded = null;
		loading = true;
		const timer = setTimeout(async () => {
			try {
				const res = await fetch(`/api/link-preview?url=${encodeURIComponent(current)}`);
				if (my !== seq) return;
				if (res.status === 404) {
					remember(current, { kind: 'gone' });
					loaded = { kind: 'gone' };
					return;
				}
				if (!res.ok) return;
				const data = (await res.json()) as { xPost?: Partial<XPost> };
				if (my !== seq || !data.xPost) return;
				const post: XPost = {
					name: String(data.xPost.name ?? ''),
					handle: String(data.xPost.handle ?? ''),
					text: quotedPostText(String(data.xPost.text ?? '')),
					date: String(data.xPost.date ?? '')
				};
				remember(current, { kind: 'post', post });
				loaded = { kind: 'post', post };
			} catch {
				// Offline or the preview failed: the card falls back to the handle.
			} finally {
				if (my === seq) loading = false;
			}
		}, 300);
		return () => clearTimeout(timer);
	});

	const handle = $derived(
		loaded?.kind === 'post' && loaded.post.handle ? loaded.post.handle : ref?.handle
	);
</script>

<div class="mt-3" data-testid="x-quote">
	{#if loaded?.kind === 'gone'}
		<div
			class="flex items-start gap-2 rounded-xl border border-dashed border-stone-300 bg-stone-50 p-3 text-[12px] font-medium text-stone-600"
			data-testid="x-quote-unavailable"
		>
			<TriangleAlert class="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-600" />
			<p class="min-w-0 flex-1">
				<span class="font-bold text-stone-900">This post can't be loaded.</span>
				It may be deleted or from a protected account. X will show it as unavailable.
			</p>
			<button
				type="button"
				data-testid="x-quote-remove"
				onclick={onRemove}
				class="flex min-h-6 min-w-6 items-center justify-center rounded-md text-stone-500 hover:bg-stone-200 hover:text-stone-900"
				title="Remove quote"
				aria-label="Remove quote"
			>
				<X class="h-3.5 w-3.5" />
			</button>
		</div>
	{:else}
		<div
			class="relative rounded-xl border border-stone-200/80 bg-white p-3"
			data-testid="x-quote-card"
			aria-busy={loading}
		>
			<button
				type="button"
				data-testid="x-quote-remove"
				onclick={onRemove}
				class="absolute top-2 right-2 flex h-6 w-6 items-center justify-center rounded-full bg-stone-900/70 text-white transition-colors hover:bg-stone-900"
				title="Remove quote"
				aria-label="Remove quote"
			>
				<X class="h-3 w-3" />
			</button>
			<div class="flex min-w-0 items-center gap-1.5 pr-8 text-[13px]">
				{#if loaded?.kind === 'post' && loaded.post.name}
					<span class="max-w-[60%] flex-shrink-0 truncate font-bold text-stone-900"
						>{loaded.post.name}</span
					>
				{/if}
				<span class="min-w-0 truncate font-medium text-stone-500">
					{handle ? `@${handle}` : 'Post on X'}{loaded?.kind === 'post' && loaded.post.date
						? ` · ${loaded.post.date}`
						: ''}
				</span>
			</div>
			{#if loaded?.kind === 'post' && loaded.post.text}
				<p
					class="mt-1 line-clamp-4 text-[13px] font-medium break-words whitespace-pre-line text-stone-800"
				>
					{loaded.post.text}
				</p>
			{:else if loading}
				<div class="mt-2 animate-pulse" aria-label="Loading the quoted post">
					<div class="h-3 w-3/4 rounded bg-stone-200"></div>
					<div class="mt-1.5 h-3 w-1/2 rounded bg-stone-200"></div>
				</div>
			{/if}
			<p class="mt-2 text-[10px] font-bold tracking-widest text-stone-500 uppercase">Quote</p>
		</div>
	{/if}
	{#if othersLabel}
		<p class="mt-1.5 text-[11px] font-medium text-stone-500" data-testid="x-quote-others">
			{othersLabel}
			{otherPlatforms.length === 1 ? 'gets' : 'get'} the link instead.
		</p>
	{/if}
</div>

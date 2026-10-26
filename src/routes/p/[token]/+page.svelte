<script lang="ts">
	import MediaPreview from '#lib/components/MediaPreview.svelte';
	import { formatRelativeTime } from '#lib/domain/relative-time.js';

	let { data } = $props();

	let selected = $state<string | null>(null);
	const active = $derived(
		data.versions.find((v) => v.key === selected) ?? data.versions[0] ?? null
	);
</script>

<svelte:head>
	<title>{data.title?.trim() || 'Draft preview'} — {data.appName}</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<main id="main-content" class="min-h-dvh bg-stone-50 px-4 py-10 font-sans text-stone-900 sm:py-16">
	<div class="mx-auto w-full max-w-xl">
		<header class="mb-8">
			<p class="text-[11px] font-bold tracking-widest text-stone-500 uppercase">Draft preview</p>
			{#if data.title?.trim()}
				<h1 class="mt-1 text-xl font-extrabold">{data.title}</h1>
			{:else}
				<h1 class="sr-only">Draft preview</h1>
			{/if}
			<p class="mt-2 text-[13px] font-medium text-stone-500" data-testid="share-meta">
				Not posted yet, and may still change. Last saved {formatRelativeTime(data.updatedAt)};
				refresh to see newer edits.
			</p>
		</header>

		{#if data.versions.length > 1}
			<div class="mb-6 flex flex-wrap gap-2" role="group" aria-label="Version">
				{#each data.versions as version (version.key)}
					<button
						type="button"
						data-testid="share-version-{version.key}"
						aria-pressed={active?.key === version.key}
						onclick={() => (selected = version.key)}
						class="rounded-full px-3 py-1.5 text-[12px] font-bold whitespace-nowrap transition-all {active?.key ===
						version.key
							? 'bg-stone-900 text-white shadow-md'
							: 'border border-stone-200/80 bg-white text-stone-500 hover:border-stone-300 hover:text-stone-900'}"
					>
						{version.label}
					</button>
				{/each}
			</div>
		{/if}

		{#if active}
			<ol class="flex flex-col gap-4" data-testid="share-cards">
				{#each active.cards as card, index (index)}
					<li
						data-testid="share-card-{index}"
						class="flex min-w-0 flex-col gap-3 rounded-[1.5rem] border border-stone-200/80 bg-white p-5 shadow-[0_4px_24px_-8px_rgb(28_25_23/0.06)]"
					>
						{#if card.text}
							<p class="text-[15px] leading-relaxed font-medium break-words whitespace-pre-wrap">
								{card.text}
							</p>
						{/if}
						{#if card.media.length}
							<MediaPreview
								items={card.media}
								maxHeight={420}
								extra={Math.max(0, card.media.length - 4)}
								mediaBase={data.mediaBase}
							/>
						{/if}
						{#if !card.text && !card.media.length}
							<p class="text-[14px] font-medium text-stone-400 italic">Nothing written yet.</p>
						{/if}
					</li>
				{/each}
			</ol>
		{/if}

		<footer class="mt-10 text-center text-[12px] font-medium text-stone-500">
			This link stops working {formatRelativeTime(data.expiresAt)}, or once the post goes out.
		</footer>
	</div>
</main>

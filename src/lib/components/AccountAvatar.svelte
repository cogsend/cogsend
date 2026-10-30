<script lang="ts">
	import PlatformLogo from './PlatformLogo.svelte';

	let {
		platform,
		handle = null,
		displayName = null,
		avatarUrl = null,
		size = 40,
		selected = false,
		title = null
	}: {
		platform: string;
		handle?: string | null;
		displayName?: string | null;
		avatarUrl?: string | null;
		size?: number;
		selected?: boolean;
		title?: string | null;
	} = $props();

	function initials(h?: string | null, d?: string | null): string {
		const s = (d || h || '?').replace(/^@/, '');
		const parts = s.split(/[\s.@_-]+/).filter(Boolean);
		if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
		return s.slice(0, 2).toUpperCase();
	}

	const badge = $derived(Math.max(12, Math.round(size * 0.38)));
	const iconSize = $derived(Math.max(8, Math.round(badge * 0.62)));
	const ring = $derived(
		selected
			? 'ring-2 ring-[var(--fg)] ring-offset-2 ring-offset-[var(--card)]'
			: 'ring-1 ring-[var(--border)]'
	);
	const badgeBg: Record<string, string> = {
		bluesky: '#0085ff',
		mastodon: '#6364ff',
		linkedin: '#0a66c2',
		threads: '#000000',
		instagram: '#e4405f',
		x: '#000000'
	};
	const badgeLabel: Record<string, string> = {
		bluesky: 'Bluesky',
		mastodon: 'Mastodon',
		linkedin: 'LinkedIn',
		threads: 'Threads',
		instagram: 'Instagram',
		x: 'X'
	};
	const bg = $derived(badgeBg[platform] ?? '#6b7280');
	const label = $derived(badgeLabel[platform] ?? platform);
	let imgFailed = $state(false);
	let imgLoaded = $state(false);
	let img = $state<HTMLImageElement>();
	// A cached image can finish before hydration, and then `onload` never runs
	// here; without this it would stay at opacity 0 over the initials.
	$effect(() => {
		if (img?.complete && img.naturalWidth > 0) imgLoaded = true;
	});
</script>

<span
	class="relative inline-flex shrink-0 rounded-full {ring}"
	style="width:{size}px;height:{size}px"
	role="img"
	aria-label={`${displayName || handle || 'Account'} on ${badgeLabel[platform] ?? platform}`}
	{title}
>
	<span
		class="flex h-full w-full items-center justify-center rounded-full bg-gradient-to-br from-neutral-200 to-neutral-300 text-[11px] font-semibold text-[var(--fg)]"
		aria-hidden="true"
	>
		{initials(handle, displayName)}
	</span>
	{#if avatarUrl && !imgFailed}
		<img
			bind:this={img}
			src={avatarUrl}
			alt=""
			width={size}
			height={size}
			loading="lazy"
			decoding="async"
			referrerpolicy="no-referrer"
			class="absolute inset-0 h-full w-full rounded-full object-cover transition-opacity duration-200 {imgLoaded
				? 'opacity-100'
				: 'opacity-0'}"
			onload={() => (imgLoaded = true)}
			onerror={() => (imgFailed = true)}
		/>
	{/if}
	<span
		class="absolute -right-0.5 -bottom-0.5 flex items-center justify-center rounded-full text-white ring-2 ring-[var(--card)]"
		style="width:{badge}px;height:{badge}px;background:{bg}"
		title={label}
		aria-hidden="true"
	>
		<PlatformLogo {platform} size={iconSize} />
	</span>
</span>

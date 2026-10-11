<script lang="ts">
	import { platformMark } from '#lib/domain/platform-marks.js';

	let { platform, className = '' }: { platform: string; className?: string } = $props();

	// `null` for a platform we have no mark for. Never another brand's mark:
	// answering an unknown platform with the Bluesky logo (which this used to
	// do) mislabels the account it belongs to.
	const path = $derived(platformMark(platform));
</script>

<svg
	role="img"
	viewBox="0 0 24 24"
	xmlns="http://www.w3.org/2000/svg"
	class={className}
	fill="currentColor"
>
	<title>{platform}</title>
	{#if path}
		<path d={path} />
	{:else}
		<g fill="none" stroke="currentColor" stroke-width="2">
			<circle cx="12" cy="12" r="9" />
			<text x="12" y="16" text-anchor="middle" font-size="12" fill="currentColor" stroke="none"
				>?</text
			>
		</g>
	{/if}
</svg>

<script lang="ts">
	import { platformMark } from '#lib/domain/platform-marks.js';

	let { platform, size = 10 }: { platform: string; size?: number } = $props();

	const path = $derived(platformMark(platform));
</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="currentColor"
	aria-hidden="true"
	focusable="false"
>
	{#if path}
		<path d={path} />
	{:else}
		<!-- Truly unknown platform: neutral glyph, never another brand's mark. -->
		<g fill="none" stroke="currentColor" stroke-width="2">
			<circle cx="12" cy="12" r="9" />
			<text x="12" y="16" text-anchor="middle" font-size="12" fill="currentColor" stroke="none"
				>?</text
			>
		</g>
	{/if}
</svg>

<script lang="ts">
	import type { TextPart } from '#lib/domain/linkify.js';

	let { parts }: { parts: TextPart[] } = $props();
</script>

<!-- No whitespace between these tags: the text sits in a pre-wrap block, where it would show. -->
{#each parts as part, i (i)}{#if part.href}<a
			href={part.href}
			target="_blank"
			rel="noopener noreferrer nofollow"
			class="text-sky-700 underline-offset-2 hover:underline"
			data-testid="post-link">{part.text}</a
		>{:else}{part.text}{/if}{/each}

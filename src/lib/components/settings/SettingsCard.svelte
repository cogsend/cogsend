<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title,
		description,
		id,
		testid,
		label,
		children
	}: {
		title: string;
		description?: string | Snippet;
		id?: string;
		testid?: string;
		label?: string;
		children: Snippet;
	} = $props();
</script>

<section
	{id}
	class="min-w-0 scroll-mt-24 rounded-[2rem] border border-stone-200/80 bg-white p-6 shadow-[0_8px_30px_-12px_rgb(28_25_23/0.06)] sm:p-8"
	aria-label={label}
	data-testid={testid}
>
	<h2
		class="{description ? 'mb-2' : 'mb-6'} text-[17px] font-extrabold tracking-tight text-stone-900"
	>
		{title}
	</h2>
	{#if description}
		<p class="mb-6 max-w-md text-[13px] leading-relaxed font-medium text-stone-500">
			{#if typeof description === 'string'}{description}{:else}{@render description()}{/if}
		</p>
	{/if}
	{@render children()}
</section>

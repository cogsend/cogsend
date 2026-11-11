<script lang="ts">
	import type { SettingsNotice } from './settings-notice.svelte.js';

	let { notice }: { notice: SettingsNotice } = $props();
</script>

{#if notice.msg || notice.err}
	<div
		class="mb-6 rounded-xl px-3 py-2 text-sm {notice.err
			? 'bg-red-50 text-red-700'
			: 'bg-emerald-50 text-emerald-800'}"
		role="alert"
	>
		{notice.err || notice.msg}
	</div>
{/if}

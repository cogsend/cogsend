<script lang="ts">
	import Editor from '#lib/components/Editor.svelte';

	let { data } = $props();
</script>

<Editor
	initialConnections={data.connections}
	initialSettings={data.settings}
	initialDraft={data.draft}
	displayName={data.displayName}
	videoEnabled={data.videoEnabled}
/>

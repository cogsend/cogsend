<script lang="ts">
	import InstanceNameCard from '#lib/components/settings/InstanceNameCard.svelte';
	import UpdatesCard from '#lib/components/settings/UpdatesCard.svelte';

	let { data } = $props();
</script>

<UpdatesCard />
<InstanceNameCard initialName={data.appName ?? ''} />

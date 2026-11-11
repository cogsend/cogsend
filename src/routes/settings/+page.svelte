<script lang="ts">
	import LoginCard from '#lib/components/settings/LoginCard.svelte';
	import ProfileCard from '#lib/components/settings/ProfileCard.svelte';
	import TwoFactorCard from '#lib/components/settings/TwoFactorCard.svelte';

	let { data } = $props();
</script>

<ProfileCard initialName={data.displayName ?? ''} initialPicture={data.profilePictureUrl ?? ''} />
<LoginCard email={data.user?.email ?? ''} />
<TwoFactorCard />

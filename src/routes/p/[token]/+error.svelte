<script lang="ts">
	import { page } from '$app/state';
</script>

<svelte:head>
	<title>Preview unavailable</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<main
	id="main-content"
	class="flex min-h-dvh items-center justify-center bg-stone-50 px-4 font-sans"
>
	<div class="w-full max-w-sm text-center" data-testid="share-unavailable">
		<h1 class="text-lg font-extrabold text-stone-900">Preview unavailable</h1>
		<p class="mt-2 text-[14px] font-medium text-stone-500">
			{page.status === 404
				? 'This link has expired, was turned off, or the post has already gone out.'
				: page.error?.message || 'Something went wrong. Try again in a moment.'}
		</p>
	</div>
</main>

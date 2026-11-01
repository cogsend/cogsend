<script lang="ts">
	import { goto } from '$app/navigation';
	import favicon from '#lib/assets/favicon.svg';

	let { data } = $props();

	let error = $state<string | null>(null);
	let loading = $state(false);
	let outcome = $state<'waitlist' | 'login' | null>(null);

	// A button rather than confirming on load: mail scanners fetch every link in
	// a message, and must not confirm an address for its owner.
	async function confirm() {
		loading = true;
		error = null;
		try {
			const res = await fetch('/api/auth/signup/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ token: data.token })
			});
			const body = (await res.json()) as { error?: string; next?: string };
			if (!res.ok) throw new Error(body.error || 'Could not confirm the address');
			if (body.next === 'enroll') {
				await goto('/login/setup-2fa');
				return;
			}
			outcome = body.next === 'waitlist' ? 'waitlist' : 'login';
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not confirm the address';
		} finally {
			loading = false;
		}
	}
</script>

<svelte:head>
	<title>Confirm your email</title>
</svelte:head>

<div class="flex min-h-dvh items-center justify-center bg-stone-50 px-4">
	<div class="w-full max-w-sm">
		<div class="mb-8 text-center">
			<img
				src={favicon}
				alt=""
				aria-hidden="true"
				class="mx-auto mb-4 h-12 w-12 rounded-xl shadow-md"
			/>
			<h1 class="text-2xl font-extrabold tracking-tight text-stone-900">{data.appName}</h1>
		</div>
		<div
			class="space-y-4 rounded-[2rem] border border-stone-200/80 bg-white p-6 shadow-[0_8px_30px_-12px_rgb(28_25_23/0.06)]"
		>
			{#if outcome === 'waitlist'}
				<h2 class="text-sm font-bold text-stone-900">Address confirmed</h2>
				<p class="text-sm font-medium text-stone-600">
					Your account is on the waitlist. Once an admin approves it you can sign in.
				</p>
			{:else if outcome === 'login'}
				<h2 class="text-sm font-bold text-stone-900">Nothing left to confirm</h2>
				<p class="text-sm font-medium text-stone-600">
					<a href="/login" class="font-bold underline">Sign in</a> to continue.
				</p>
			{:else}
				<h2 class="text-sm font-bold text-stone-900">Confirm your email address</h2>
				{#if error}
					<p class="text-sm font-bold text-red-600" role="alert">{error}</p>
				{/if}
				<button
					type="button"
					onclick={confirm}
					disabled={loading || !data.token}
					class="w-full rounded-full bg-stone-900 py-2.5 text-sm font-bold text-white transition-all hover:bg-stone-800 disabled:opacity-50"
				>
					{loading ? 'Confirming…' : 'Confirm'}
				</button>
			{/if}
		</div>
	</div>
</div>

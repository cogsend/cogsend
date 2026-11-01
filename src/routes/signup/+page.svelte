<script lang="ts">
	import { goto } from '$app/navigation';
	import favicon from '#lib/assets/favicon.svg';

	let { data } = $props();

	let email = $state('');
	let password = $state('');
	// Hidden from people (see api/auth/signup); a bot that fills every field fills it.
	let website = $state('');
	let error = $state<string | null>(null);
	let loading = $state(false);
	let outcome = $state<'verify-email' | 'waitlist' | null>(null);

	const closed = $derived(data.mode === 'off' && !data.invite);

	async function onSubmit(e: Event) {
		e.preventDefault();
		loading = true;
		error = null;
		try {
			const res = await fetch('/api/auth/signup', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					email,
					password,
					website,
					invite: data.invite,
					formToken: data.formToken
				})
			});
			const body = (await res.json()) as {
				error?: string;
				next?: 'verify-email' | 'waitlist';
				needEnroll?: boolean;
			};
			if (!res.ok) throw new Error(body.error || 'Could not create the account');
			password = '';
			if (body.next) {
				outcome = body.next;
				return;
			}
			await goto(body.needEnroll ? '/login/setup-2fa' : '/compose');
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not create the account';
		} finally {
			loading = false;
		}
	}
</script>

<svelte:head>
	<title>Create an account</title>
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
			<p class="mt-1 text-sm font-medium text-stone-500">Create an account</p>
		</div>
		<div
			class="space-y-4 rounded-[2rem] border border-stone-200/80 bg-white p-6 shadow-[0_8px_30px_-12px_rgb(28_25_23/0.06)]"
			data-testid="signup-card"
		>
			{#if outcome === 'verify-email'}
				<h2 class="text-sm font-bold text-stone-900">Check your inbox</h2>
				<p class="text-sm font-medium text-stone-600" data-testid="signup-outcome">
					If the address can be registered, we sent it a link to confirm it. The link works for 24
					hours.
				</p>
			{:else if outcome === 'waitlist'}
				<h2 class="text-sm font-bold text-stone-900">You are on the waitlist</h2>
				<p class="text-sm font-medium text-stone-600" data-testid="signup-outcome">
					Thanks. An admin reviews new accounts by hand; once yours is approved you can sign in with
					the email and password you just chose.
				</p>
			{:else if closed}
				<h2 class="text-sm font-bold text-stone-900">Sign-up is closed</h2>
				<p class="text-sm font-medium text-stone-600">
					This instance is not taking new accounts right now. If you were sent an invite link, open
					it again.
				</p>
			{:else}
				<form onsubmit={onSubmit} class="space-y-4">
					{#if data.invite}
						<p class="text-xs font-medium text-emerald-800">
							You were invited: your account is ready as soon as you finish.
						</p>
					{:else if data.mode === 'waitlist'}
						<p class="text-xs font-medium text-stone-500">
							New accounts wait for an admin's approval before they can sign in.
						</p>
					{/if}
					<label class="block text-sm">
						<span class="text-[11px] font-bold tracking-widest text-stone-500 uppercase">Email</span
						>
						<input
							type="email"
							autocomplete="email"
							placeholder="you@example.com"
							bind:value={email}
							class="mt-1.5 w-full rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-2.5 text-sm font-bold text-stone-900 focus:border-stone-400 focus:bg-white focus:outline-none pointer-coarse:text-base"
							required
						/>
					</label>
					<label class="block text-sm">
						<span class="text-[11px] font-bold tracking-widest text-stone-500 uppercase"
							>Password</span
						>
						<input
							type="password"
							autocomplete="new-password"
							minlength="8"
							bind:value={password}
							class="mt-1.5 w-full rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-2.5 text-sm font-bold text-stone-900 focus:border-stone-400 focus:bg-white focus:outline-none pointer-coarse:text-base"
							required
						/>
					</label>
					<div class="absolute -left-[10000px] h-px w-px overflow-hidden" aria-hidden="true">
						<label>
							Website
							<input type="text" tabindex="-1" autocomplete="off" bind:value={website} />
						</label>
					</div>
					<p class="text-xs font-medium text-stone-500">
						{data.verifyEmail ? 'We will email you a link to confirm the address. ' : ''}After that
						you set up an authenticator app: two-factor sign-in is required for every account.
					</p>
					{#if error}
						<p class="text-sm font-bold text-red-600" role="alert">{error}</p>
					{/if}
					<button
						type="submit"
						disabled={loading}
						class="w-full rounded-full bg-stone-900 py-2.5 text-sm font-bold text-white transition-all hover:bg-stone-800 disabled:opacity-50"
					>
						{loading ? 'Creating…' : 'Create account'}
					</button>
				</form>
			{/if}
		</div>
		<p class="mt-4 text-center text-xs font-medium text-stone-500">
			Already have an account? <a href="/login" class="font-bold text-stone-700 underline"
				>Sign in</a
			>
		</p>
	</div>
</div>

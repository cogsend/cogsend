<script lang="ts">
	import { goto } from '$app/navigation';
	import favicon from '$lib/assets/favicon.svg';

	let { data } = $props();

	let email = $state('');
	let password = $state('');
	let remember = $state(true);
	let error = $state<string | null>(null);
	let loading = $state(false);

	async function onSubmit(e: Event) {
		e.preventDefault();
		loading = true;
		error = null;
		try {
			const res = await fetch('/api/auth/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email, password, remember })
			});
			const data = (await res.json()) as {
				error?: string;
				needEnroll?: boolean;
				needTotp?: boolean;
			};
			if (!res.ok) throw new Error(data.error || 'Login failed');
			if (data.needEnroll) {
				await goto('/login/setup-2fa');
				return;
			}
			if (data.needTotp) {
				await goto('/login/verify');
				return;
			}
			await goto('/compose');
		} catch (err) {
			error = err instanceof Error ? err.message : 'Login failed';
		} finally {
			loading = false;
		}
	}
</script>

<div class="flex min-h-dvh items-center justify-center bg-stone-50 px-4">
	<div class="w-full max-w-sm">
		<div class="mb-8 text-center">
			<img
				src={favicon}
				alt=""
				aria-hidden="true"
				data-testid="brand-mark"
				class="mx-auto mb-4 h-12 w-12 rounded-xl shadow-md"
			/>
			<h1 class="text-2xl font-extrabold tracking-tight text-stone-900">{data.appName}</h1>
			<p class="mt-1 text-sm font-medium text-stone-500">Write once. Post everywhere.</p>
		</div>
		{#if data.notConfigured}
			<div class="rounded-[2rem] border border-amber-300 bg-amber-50 p-6">
				<h2 class="text-sm font-bold text-amber-900">This instance has no account yet</h2>
				<p class="mt-2 text-sm text-amber-900/80">
					It cannot be created from a browser. Run this from the machine that deploys it:
				</p>
				<pre
					class="mt-3 overflow-x-auto rounded-xl bg-white/70 px-3 py-2 text-xs font-bold text-stone-800">npm run setup</pre>
			</div>
		{:else}
			<form
				onsubmit={onSubmit}
				class="space-y-4 rounded-[2rem] border border-stone-200/80 bg-white p-6 shadow-[0_8px_30px_-12px_rgb(28_25_23/0.06)]"
			>
				<label class="block text-sm">
					<span class="text-[11px] font-bold tracking-widest text-stone-500 uppercase">Email</span>
					<input
						type="email"
						autocomplete="username"
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
						autocomplete="current-password"
						bind:value={password}
						class="mt-1.5 w-full rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-2.5 text-sm font-bold text-stone-900 focus:border-stone-400 focus:bg-white focus:outline-none pointer-coarse:text-base"
						required
					/>
				</label>
				<label class="flex cursor-pointer items-center gap-2 text-xs font-medium text-stone-500">
					<input type="checkbox" bind:checked={remember} />
					Remember this browser
				</label>
				{#if error}
					<p class="text-sm font-bold text-red-600" role="alert">{error}</p>
				{/if}
				<button
					type="submit"
					disabled={loading}
					class="w-full rounded-full bg-stone-900 py-2.5 text-sm font-bold text-white transition-all hover:bg-stone-800 disabled:opacity-50"
				>
					{loading ? 'Signing in…' : 'Sign in'}
				</button>
			</form>
			<p class="mt-4 text-center text-xs font-medium text-stone-500">
				Use the email and password you set when you ran <code>npm run setup</code>
			</p>
		{/if}
	</div>
</div>

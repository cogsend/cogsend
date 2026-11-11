<script lang="ts">
	import { goto } from '$app/navigation';
	import favicon from '#lib/assets/favicon.svg';
	import { claimPasswordProblem } from '#lib/domain/claim-password.js';
	import { docsLinks } from '#lib/domain/docs-links.js';

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

	let setupKey = $state('');
	let showPassword = $state(false);
	let confirmPassword = $state('');
	let copied = $state<'yes' | 'failed' | null>(null);

	async function copyPassword() {
		try {
			await navigator.clipboard.writeText(password);
			copied = 'yes';
		} catch {
			copied = 'failed';
		}
	}

	/** 18 random bytes, base64url: 24 characters, nothing to mistype. */
	function generatePassword() {
		const bytes = crypto.getRandomValues(new Uint8Array(18));
		password = btoa(String.fromCharCode(...bytes))
			.replace(/\+/g, '-')
			.replace(/\//g, '_');
		showPassword = true;
		confirmPassword = '';
		copied = null;
	}

	async function onClaim(e: Event) {
		e.preventDefault();
		const mismatch = claimPasswordProblem(password, confirmPassword, showPassword);
		if (mismatch) {
			error = mismatch;
			return;
		}
		loading = true;
		error = null;
		try {
			const res = await fetch('/api/auth/claim', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ setupKey, email, password })
			});
			const data = (await res.json()) as { error?: string; needEnroll?: boolean };
			if (!res.ok) throw new Error(data.error || 'Could not create the account');
			setupKey = '';
			await goto(data.needEnroll ? '/login/setup-2fa' : '/compose');
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not create the account';
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
			<form
				onsubmit={onClaim}
				class="space-y-4 rounded-[2rem] border border-stone-200/80 bg-white p-6 shadow-[0_8px_30px_-12px_rgb(28_25_23/0.06)]"
			>
				<div>
					<h2 class="text-sm font-bold text-stone-900">Create your account</h2>
					<p class="mt-1 text-xs font-medium text-stone-500">
						Paste the APP_ENCRYPTION_KEY you entered on the Deploy to Cloudflare page (or set as a
						Worker secret). It proves you deployed this instance, so nobody else who finds the URL
						can claim it.
					</p>
				</div>
				<label class="block text-sm">
					<span class="text-[11px] font-bold tracking-widest text-stone-500 uppercase"
						>Encryption key</span
					>
					<input
						type="password"
						autocomplete="off"
						spellcheck="false"
						placeholder="APP_ENCRYPTION_KEY"
						data-1p-ignore
						data-lpignore="true"
						data-bwignore
						bind:value={setupKey}
						class="mt-1.5 w-full rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-2.5 font-mono text-sm font-bold text-stone-900 focus:border-stone-400 focus:bg-white focus:outline-none pointer-coarse:text-base"
						required
					/>
				</label>
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
					<span class="flex items-center justify-between">
						<span class="text-[11px] font-bold tracking-widest text-stone-500 uppercase"
							>Password</span
						>
						<button
							type="button"
							onclick={generatePassword}
							class="text-xs font-bold text-stone-600 underline-offset-2 hover:underline"
							>Generate</button
						>
					</span>
					<input
						type={showPassword ? 'text' : 'password'}
						autocomplete="new-password"
						minlength="8"
						bind:value={password}
						class="mt-1.5 w-full rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-2.5 text-sm font-bold text-stone-900 focus:border-stone-400 focus:bg-white focus:outline-none pointer-coarse:text-base"
						required
					/>
				</label>
				{#if showPassword}
					<div class="flex items-start justify-between gap-3">
						<p class="text-xs font-medium text-amber-800">
							Save this password in your password manager before you continue.
						</p>
						<button
							type="button"
							onclick={copyPassword}
							class="shrink-0 text-xs font-bold text-stone-600 underline-offset-2 hover:underline"
							>{copied === 'yes' ? 'Copied' : 'Copy'}</button
						>
					</div>
					{#if copied === 'failed'}
						<p class="text-xs font-medium text-red-600" role="alert">
							Could not copy — select the password and copy it yourself.
						</p>
					{/if}
				{:else}
					<label class="block text-sm">
						<span class="text-[11px] font-bold tracking-widest text-stone-500 uppercase"
							>Confirm password</span
						>
						<input
							type="password"
							autocomplete="new-password"
							bind:value={confirmPassword}
							class="mt-1.5 w-full rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-2.5 text-sm font-bold text-stone-900 focus:border-stone-400 focus:bg-white focus:outline-none pointer-coarse:text-base"
							required
						/>
					</label>
				{/if}
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
			<p class="mt-4 text-center text-xs font-medium text-stone-500">
				Deployed from a terminal? <code>npm run setup</code> creates the account too.
			</p>
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
				Use the email and password you chose when you created the account.
			</p>
			<p class="mt-2 text-center text-xs font-medium text-stone-500">
				<a
					href={docsLinks.login}
					target="_blank"
					rel="noopener noreferrer"
					class="underline underline-offset-2 hover:text-stone-900"
					>Lost your password or authenticator?</a
				>
			</p>
		{/if}
	</div>
</div>

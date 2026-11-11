<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { docsLinks } from '#lib/domain/docs-links.js';

	let code = $state('');
	let useBackup = $state(false);
	let error = $state<string | null>(null);
	let loading = $state(false);

	async function onSubmit(e: Event) {
		e.preventDefault();
		loading = true;
		error = null;
		try {
			const res = await fetch('/api/auth/totp/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ code })
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.error || 'Invalid code');
			await invalidateAll();
			await goto('/compose');
		} catch (err) {
			error = err instanceof Error ? err.message : 'Invalid code';
		} finally {
			loading = false;
		}
	}
</script>

<div class="flex min-h-dvh items-center justify-center px-4">
	<div class="w-full max-w-sm">
		<div class="mb-8 text-center">
			<h1 class="text-2xl font-semibold tracking-tight">Authenticator code</h1>
			<p class="mt-1 text-sm text-stone-500">
				{useBackup
					? 'Enter one unused backup code.'
					: 'Open your authenticator app and enter the 6-digit code.'}
			</p>
		</div>
		<form
			onsubmit={onSubmit}
			class="space-y-4 rounded-[2rem] border border-stone-200/80 bg-white p-6 shadow-[0_8px_30px_-12px_rgb(28_25_23/0.06)]"
		>
			<label class="block text-sm">
				<span class="text-xs text-stone-500">{useBackup ? 'Backup code' : 'Code'}</span>
				<input
					type="text"
					inputmode={useBackup ? 'text' : 'numeric'}
					autocomplete="one-time-code"
					bind:value={code}
					placeholder={useBackup ? 'XXXX-XXXX' : '123456'}
					class="mt-1 w-full rounded-xl border border-stone-200/80 bg-stone-50 px-3 py-2 text-center text-lg tracking-[0.2em] focus:border-stone-400 focus:bg-white focus:outline-none"
					required
				/>
			</label>
			{#if error}
				<p class="text-sm text-red-600" role="alert">{error}</p>
			{/if}
			<button
				type="submit"
				disabled={loading}
				class="w-full rounded-full bg-stone-900 py-2.5 text-sm font-medium text-white disabled:opacity-50"
			>
				{loading ? 'Checking…' : 'Continue'}
			</button>
			<button
				type="button"
				onclick={() => {
					useBackup = !useBackup;
					code = '';
					error = null;
				}}
				class="w-full text-xs text-stone-500 underline"
			>
				{useBackup ? 'Use authenticator code' : 'Use a backup code'}
			</button>
		</form>
		<p class="mt-4 text-center text-xs text-stone-500">
			<a href="/login" class="underline">Back to sign in</a>
		</p>
		<p class="mt-2 text-center text-xs text-stone-500">
			<a href={docsLinks.login} target="_blank" rel="noopener noreferrer" class="underline"
				>Lost your authenticator and backup codes?</a
			>
		</p>
	</div>
</div>

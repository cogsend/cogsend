<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { onMount } from 'svelte';
	import { downloadText } from '#lib/components/download-text.js';
	import { backupCodesFile } from '#lib/domain/backup-codes.js';
	import { humanizeError } from '#lib/domain/human-error.js';

	let secret = $state('');
	let qrSvg = $state('');
	let backupCodes = $state<string[]>([]);
	let code = $state('');
	let saved = $state(false);
	let error = $state<string | null>(null);
	let loading = $state(true);
	let confirming = $state(false);
	// Set up could not start: said here, since sending the person back to
	// sign in again would only bring them to the same failure.
	let startError = $state<string | null>(null);
	let copied = $state<'secret' | 'codes' | null>(null);
	let copyFailed = $state(false);

	onMount(async () => {
		try {
			const res = await fetch('/api/auth/totp/enroll/start', { method: 'POST' });
			const data = await res.json().catch(() => ({}));
			if (res.status === 401) {
				await goto('/login');
				return;
			}
			if (!res.ok) {
				startError = humanizeError(data.error || 'Could not start the authenticator setup');
				return;
			}
			secret = data.secret;
			qrSvg = data.qrSvg;
			backupCodes = data.backupCodes;
		} catch {
			startError = humanizeError('fetch failed');
		} finally {
			loading = false;
		}
	});

	async function confirm(e: Event) {
		e.preventDefault();
		if (!saved) {
			error = 'Save the backup codes first';
			return;
		}
		confirming = true;
		error = null;
		try {
			const res = await fetch('/api/auth/totp/enroll/confirm', {
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
			confirming = false;
		}
	}

	async function copy(text: string, what: 'secret' | 'codes') {
		try {
			await navigator.clipboard.writeText(text);
			copied = what;
			copyFailed = false;
		} catch {
			copied = null;
			copyFailed = true;
		}
	}

	function downloadCodes() {
		downloadText('backup-codes.txt', backupCodesFile(backupCodes, window.location.host));
	}
</script>

<div class="flex min-h-dvh items-center justify-center px-4 py-10">
	<div class="w-full max-w-md">
		<div class="mb-6 text-center">
			<h1 class="text-2xl font-semibold tracking-tight">Set up authenticator</h1>
			<p class="mt-1 text-sm text-stone-500">
				Required. Works with Google Authenticator, 1Password, Authy, and any standard app.
			</p>
		</div>

		{#if loading}
			<p class="text-center text-sm text-stone-500">Preparing your codes…</p>
		{:else if startError}
			<div
				class="space-y-3 rounded-[2rem] border border-stone-200/80 bg-white p-6 text-center shadow-[0_8px_30px_-12px_rgb(28_25_23/0.06)]"
			>
				<p class="text-sm text-red-600" role="alert">{startError}</p>
				<a href="/login" class="text-xs text-stone-500 underline">Back to sign in</a>
			</div>
		{:else}
			<div
				class="space-y-5 rounded-[2rem] border border-stone-200/80 bg-white p-6 shadow-[0_8px_30px_-12px_rgb(28_25_23/0.06)]"
			>
				<div class="flex justify-center">
					<!-- QR is generated on the server from the otpauth URI -->
					<div class="rounded-xl border border-stone-200/80 bg-white p-3">
						<div
							class="h-48 w-48 [&>svg]:h-full [&>svg]:w-full"
							role="img"
							aria-label="Authenticator QR code, or enter the key below manually"
						>
							{@html qrSvg}
						</div>
					</div>
				</div>
				<div>
					<p class="text-xs text-stone-500">Or enter this key manually</p>
					<div class="mt-1 flex items-center gap-2">
						<code class="flex-1 rounded-xl bg-stone-50 px-3 py-2 text-sm tracking-wider"
							>{secret}</code
						>
						<button
							type="button"
							aria-label="Copy secret key"
							onclick={() => copy(secret.replace(/\s+/g, ''), 'secret')}
							class="text-xs text-stone-500 underline"
							>{copied === 'secret' ? 'Copied' : 'Copy'}</button
						>
					</div>
				</div>
				<div>
					<p class="text-sm font-medium">Backup codes</p>
					<p class="mt-0.5 text-xs text-stone-500">
						Save these. Each works once if you lose your phone. They will not be shown again.
					</p>
					<ul class="mt-2 grid grid-cols-2 gap-1.5 font-mono text-sm">
						{#each backupCodes as c (c)}
							<li class="rounded-lg bg-stone-50 px-2 py-1">{c}</li>
						{/each}
					</ul>
					<div class="mt-2 flex items-center gap-4">
						<button
							type="button"
							aria-label="Copy all backup codes"
							onclick={() => copy(backupCodes.join('\n'), 'codes')}
							class="text-xs text-stone-500 underline"
							>{copied === 'codes' ? 'Copied' : 'Copy all'}</button
						>
						<button
							type="button"
							onclick={downloadCodes}
							class="text-xs text-stone-500 underline"
							data-testid="download-backup-codes">Download .txt</button
						>
					</div>
					{#if copyFailed}
						<p class="mt-1 text-xs text-red-600" role="alert">
							Could not copy — select the codes and copy them yourself, or download them.
						</p>
					{/if}
					<p class="sr-only" aria-live="polite">{copied ? 'Copied to clipboard' : ''}</p>
				</div>
				<form onsubmit={confirm} class="space-y-3">
					<label class="flex cursor-pointer items-center gap-2 text-xs text-stone-500">
						<input type="checkbox" bind:checked={saved} />
						I saved these backup codes
					</label>
					<label class="block text-sm">
						<span class="text-xs text-stone-500">Code from your app</span>
						<input
							type="text"
							inputmode="numeric"
							autocomplete="one-time-code"
							bind:value={code}
							placeholder="123456"
							class="mt-1 w-full rounded-xl border border-stone-200/80 bg-stone-50 px-3 py-2 text-center text-lg tracking-[0.3em] focus:border-stone-400 focus:bg-white focus:outline-none"
							required
						/>
					</label>
					{#if error}
						<p class="text-sm text-red-600" role="alert">{error}</p>
					{/if}
					<button
						type="submit"
						disabled={confirming || !saved}
						class="w-full rounded-full bg-stone-900 py-2.5 text-sm font-medium text-white disabled:opacity-50"
					>
						{confirming ? 'Checking…' : 'Confirm and continue'}
					</button>
				</form>
			</div>
		{/if}
	</div>
</div>

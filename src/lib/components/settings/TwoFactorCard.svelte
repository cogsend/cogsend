<script lang="ts">
	import { onMount } from 'svelte';
	import { downloadText } from '#lib/components/download-text.js';
	import CopyButton from '#lib/components/CopyButton.svelte';
	import { backupCodesFile } from '#lib/domain/backup-codes.js';
	import { humanizeError } from '#lib/domain/human-error.js';
	import SettingsCard from './SettingsCard.svelte';
	import { settingsGet, useSettingsNotice } from './settings-notice.svelte.js';

	const notice = useSettingsNotice();
	let totpOn = $state(false);
	let backupRemaining = $state(0);
	let rotateOpen = $state(false);
	let rotateCode = $state('');
	let rotateSecret = $state('');
	let rotateQr = $state('');
	let rotateBackups = $state<string[]>([]);
	let rotateSaved = $state(false);
	let rotateConfirm = $state('');
	let rotateBusy = $state(false);
	// A backup code that starts a rotation is spent then and there, even if
	// the rotation is never confirmed. An authenticator code is six digits.
	let rotateUsedBackup = $state(false);

	/** Drops the half-done rotation. The server keeps the old authenticator until a confirm. */
	function cancelRotate() {
		rotateOpen = false;
		rotateQr = '';
		rotateSecret = '';
		rotateBackups = [];
		rotateCode = '';
		rotateConfirm = '';
		rotateSaved = false;
		notice.clearError();
	}

	async function load() {
		const res = await settingsGet('/api/auth/totp/status', notice);
		if (!res?.ok) return;
		const t = await res.json();
		totpOn = Boolean(t.enabled);
		backupRemaining = t.backupRemaining ?? 0;
	}

	async function startRotate(e: Event) {
		e.preventDefault();
		rotateBusy = true;
		notice.clearError();
		try {
			const res = await fetch('/api/auth/totp/rotate/start', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ code: rotateCode })
			});
			const payload = await res.json();
			if (!res.ok) throw new Error(payload.error || 'Invalid code');
			rotateSecret = payload.secret;
			rotateQr = payload.qrSvg;
			rotateBackups = payload.backupCodes;
			rotateUsedBackup = !/^\d{6}$/.test(rotateCode.trim());
		} catch (e) {
			notice.fail(humanizeError(e instanceof Error ? e.message : 'Invalid code'));
		} finally {
			rotateBusy = false;
		}
	}

	async function confirmRotate(e: Event) {
		e.preventDefault();
		rotateBusy = true;
		notice.clearError();
		try {
			const res = await fetch('/api/auth/totp/enroll/confirm', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ code: rotateConfirm })
			});
			const payload = await res.json();
			if (!res.ok) throw new Error(payload.error || 'Invalid code');
			rotateOpen = false;
			rotateQr = '';
			rotateCode = '';
			rotateConfirm = '';
			rotateSaved = false;
			notice.ok('Authenticator updated');
			await load();
		} catch (e) {
			notice.fail(humanizeError(e instanceof Error ? e.message : 'Invalid code'));
		} finally {
			rotateBusy = false;
		}
	}

	onMount(() => {
		void load();
	});
</script>

<SettingsCard
	title="Two-factor authentication"
	description="Authenticator app (Google Authenticator, 1Password, Authy, …) plus one-time backup codes. This cannot be turned off."
>
	{#if totpOn}
		<div
			class="mb-5 flex items-center gap-3 rounded-xl border border-emerald-200/50 bg-emerald-50/50 p-3"
		>
			<div
				class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"
			>
				<svg
					class="h-4 w-4"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="3"
					stroke-linecap="round"
					stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg
				>
			</div>
			<div>
				<p class="text-[13px] font-bold text-emerald-900">Active</p>
				<p class="text-[11px] font-medium text-emerald-700">
					{backupRemaining} backup code{backupRemaining === 1 ? '' : 's'} remaining
				</p>
			</div>
		</div>
	{/if}
	{#if !rotateOpen}
		<button
			type="button"
			onclick={() => (rotateOpen = true)}
			class="rounded-full bg-stone-100 px-6 py-2.5 text-[13px] font-bold text-stone-700 transition-all hover:bg-stone-200"
		>
			Generate new authenticator & codes
		</button>
	{:else if !rotateQr}
		<form class="max-w-sm space-y-4" onsubmit={startRotate}>
			<input
				type="text"
				bind:value={rotateCode}
				placeholder="Current authenticator or backup code"
				aria-label="Current authenticator or backup code"
				class="w-full rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-2.5 text-[13px] font-bold text-stone-900 focus:border-stone-400 focus:bg-white focus:outline-none pointer-coarse:text-base"
				required
			/>
			<div class="flex items-center gap-3">
				<button
					type="submit"
					disabled={rotateBusy}
					class="rounded-full bg-stone-900 px-6 py-2.5 text-[13px] font-bold text-white shadow-md transition-all hover:bg-stone-800 disabled:opacity-50"
					>Continue</button
				>
				<button
					type="button"
					onclick={cancelRotate}
					class="text-[13px] font-bold text-stone-500 hover:text-stone-900">Cancel</button
				>
			</div>
		</form>
	{:else}
		<div class="max-w-sm space-y-4">
			<p class="text-[12px] font-medium text-stone-500">
				Your current authenticator and backup codes keep working until you confirm.{rotateUsedBackup
					? ' The backup code you used is spent either way.'
					: ''}
			</p>
			<div class="flex justify-center">
				<div class="rounded-xl border border-stone-200/80 bg-white p-3 shadow-sm">
					<div
						class="h-48 w-48 [&>svg]:h-full [&>svg]:w-full"
						role="img"
						aria-label="Authenticator QR code, or enter the key below manually"
					>
						{@html rotateQr}
					</div>
				</div>
			</div>
			<code
				class="block rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-3 text-center text-sm font-bold tracking-widest text-stone-900 shadow-sm"
				>{rotateSecret}</code
			>
			<ul class="grid grid-cols-2 gap-2 font-mono text-sm font-bold text-stone-700">
				{#each rotateBackups as c (c)}
					<li class="rounded-lg border border-stone-200/50 bg-stone-50 px-3 py-1.5 text-center">
						{c}
					</li>
				{/each}
			</ul>
			<div class="flex items-center gap-3">
				<CopyButton value={rotateBackups.join('\n')} ariaLabel="Copy the new backup codes" />
				<button
					type="button"
					onclick={() =>
						downloadText('backup-codes.txt', backupCodesFile(rotateBackups, window.location.host))}
					class="text-[13px] font-bold text-stone-600 underline-offset-2 hover:underline"
					>Download .txt</button
				>
			</div>
			<!-- Container click is mouse-only convenience; keyboard users toggle via the switch button. -->
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="flex cursor-pointer items-center gap-3 py-2"
				onclick={() => (rotateSaved = !rotateSaved)}
			>
				<button
					type="button"
					role="switch"
					aria-checked={rotateSaved}
					aria-labelledby="rotate-saved-label"
					onclick={(e) => {
						e.stopPropagation();
						rotateSaved = !rotateSaved;
					}}
					class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none {rotateSaved
						? 'bg-stone-900'
						: 'bg-stone-200'}"
				>
					<span
						class="pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out {rotateSaved
							? 'translate-x-4'
							: 'translate-x-0'}"
					></span>
				</button>
				<span id="rotate-saved-label" class="text-[13px] font-medium text-stone-600"
					>I saved the new backup codes</span
				>
			</div>
			<form class="flex flex-col gap-3 sm:flex-row sm:items-center" onsubmit={confirmRotate}>
				<input
					type="text"
					bind:value={rotateConfirm}
					placeholder="New app code"
					aria-label="New app code"
					class="w-full flex-1 rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-2.5 text-[13px] font-bold text-stone-900 focus:border-stone-400 focus:bg-white focus:outline-none pointer-coarse:text-base"
					required
				/>
				<button
					type="submit"
					disabled={rotateBusy || !rotateSaved}
					class="w-full shrink-0 rounded-full bg-stone-900 px-6 py-2.5 text-[13px] font-bold text-white shadow-md transition-all hover:bg-stone-800 disabled:opacity-50 sm:w-auto"
					>Confirm</button
				>
			</form>
			<button
				type="button"
				onclick={cancelRotate}
				class="text-[13px] font-bold text-stone-500 hover:text-stone-900"
				>Cancel and keep the current authenticator</button
			>
		</div>
	{/if}
</SettingsCard>

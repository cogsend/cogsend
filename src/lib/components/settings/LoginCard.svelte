<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { humanizeError } from '#lib/domain/human-error.js';
	import SettingsCard from './SettingsCard.svelte';
	import { settingsGet, useSettingsNotice } from './settings-notice.svelte.js';

	let { email }: { email: string } = $props();

	const notice = useSettingsNotice();
	// The signed-in address is already on the layout. Show it immediately and
	// don't let the account refresh overwrite a value the user has edited.
	// svelte-ignore state_referenced_locally
	let accountEmail = $state(email);
	// svelte-ignore state_referenced_locally
	const seededAccountEmail = email;
	let accountPassword = $state('');
	let accountNewPassword = $state('');
	let accountConfirm = $state('');
	let accountBusy = $state(false);

	async function load() {
		const res = await settingsGet('/api/account', notice);
		if (!res?.ok) return;
		const a = await res.json();
		if (accountEmail === seededAccountEmail) accountEmail = a.email ?? '';
	}

	async function saveAccount(e: Event) {
		e.preventDefault();
		notice.clearError();
		if (accountNewPassword && accountNewPassword !== accountConfirm) {
			notice.fail('New passwords do not match');
			return;
		}
		accountBusy = true;
		try {
			const res = await fetch('/api/account', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					currentPassword: accountPassword,
					email: accountEmail.trim(),
					...(accountNewPassword ? { newPassword: accountNewPassword } : {})
				})
			});
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(payload.error || 'Could not save');
			accountPassword = '';
			accountNewPassword = '';
			accountConfirm = '';
			accountEmail = payload.email ?? accountEmail;
			if (payload.reauth) {
				// The password change revoked every session, including this one.
				await goto('/login');
				return;
			}
			notice.ok('Login updated');
		} catch (e) {
			notice.fail(humanizeError(e instanceof Error ? e.message : 'Could not save'));
		} finally {
			accountBusy = false;
		}
	}

	onMount(() => {
		void load();
	});
</script>

<SettingsCard
	title="Login"
	description="The email and password used to sign in. Changing the password signs out every device."
>
	<form class="space-y-4" onsubmit={saveAccount}>
		<label class="block text-sm">
			<span class="text-[11px] font-bold tracking-widest text-stone-500 uppercase">Email</span>
			<input
				type="email"
				autocomplete="username"
				bind:value={accountEmail}
				class="mt-1.5 w-full rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-2.5 text-[13px] font-bold text-stone-900 focus:border-stone-400 focus:bg-white focus:outline-none pointer-coarse:text-base"
				required
			/>
		</label>
		<label class="block text-sm">
			<span class="text-[11px] font-bold tracking-widest text-stone-500 uppercase"
				>Current password</span
			>
			<input
				type="password"
				autocomplete="current-password"
				bind:value={accountPassword}
				class="mt-1.5 w-full rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-2.5 text-[13px] font-bold text-stone-900 focus:border-stone-400 focus:bg-white focus:outline-none pointer-coarse:text-base"
				required
			/>
		</label>
		<div class="flex flex-col gap-4 sm:flex-row">
			<label class="block flex-1 text-sm">
				<span class="text-[11px] font-bold tracking-widest text-stone-500 uppercase"
					>New password</span
				>
				<input
					type="password"
					autocomplete="new-password"
					minlength="8"
					bind:value={accountNewPassword}
					placeholder="Leave empty to keep"
					class="mt-1.5 w-full rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-2.5 text-[13px] font-bold text-stone-900 focus:border-stone-400 focus:bg-white focus:outline-none pointer-coarse:text-base"
				/>
			</label>
			<label class="block flex-1 text-sm">
				<span class="text-[11px] font-bold tracking-widest text-stone-500 uppercase">Confirm</span>
				<input
					type="password"
					autocomplete="new-password"
					bind:value={accountConfirm}
					class="mt-1.5 w-full rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-2.5 text-[13px] font-bold text-stone-900 focus:border-stone-400 focus:bg-white focus:outline-none pointer-coarse:text-base"
				/>
			</label>
		</div>
		<button
			type="submit"
			disabled={accountBusy}
			class="self-start rounded-full bg-stone-900 px-6 py-2.5 text-[13px] font-bold text-white shadow-md transition-all hover:bg-stone-800 disabled:opacity-50"
			>Save login</button
		>
	</form>
</SettingsCard>

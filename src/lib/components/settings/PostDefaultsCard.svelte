<script lang="ts">
	import { onMount } from 'svelte';
	import AccountAvatar from '#lib/components/AccountAvatar.svelte';
	import { humanizeError } from '#lib/domain/human-error.js';
	import {
		accountLabel,
		displayHandle,
		platformName,
		platformRank
	} from '#lib/domain/platforms.js';
	import { MASTO_VISIBILITIES, MASTO_VISIBILITY_LABELS } from '#lib/domain/profile-settings.js';
	import SettingsCard from './SettingsCard.svelte';
	import { settingsGet, useSettingsNotice } from './settings-notice.svelte.js';

	const notice = useSettingsNotice();
	let prefVisibility = $state('public');
	let prefAccounts = $state<string[]>([]);
	let allAccounts = $state<
		{
			id: string;
			platform: string;
			handle: string | null;
			displayName: string | null;
			avatarUrl: string | null;
		}[]
	>([]);
	let prefSaved = $state<string | null>(null);
	let prefBusy = $state(false);
	// The form stays disabled until the first load resolves: applying slow
	// fetch results over user edits (and then saving them) would silently
	// reset their choices. `prefsLoaded` separates "the request finished" from
	// "the stored values arrived", so a failed load cannot leave the form
	// editing — and saving — the compile-time defaults.
	let prefsLoading = $state(true);
	let prefsLoaded = $state(false);
	// Client-only preference, mirrored with the editor via localStorage.
	const SKIP_ASK_KEY = 'cogsend-skip-publish-confirm';
	let askPublish = $state(true);
	let loadGen = 0;

	async function load() {
		const gen = ++loadGen;
		if (!prefsLoaded) prefsLoading = true;
		void settingsGet('/api/connections', notice).then(async (res) => {
			if (!res?.ok || gen !== loadGen) return;
			const c = await res.json();
			if (gen !== loadGen) return;
			allAccounts = [...(c.connections || [])].sort(
				(a, b) => platformRank(a.platform) - platformRank(b.platform)
			);
		});
		try {
			const res = await settingsGet('/api/settings', notice);
			if (gen !== loadGen || !res) return;
			if (!res.ok) {
				notice.fail('Could not load your settings');
				return;
			}
			const s = await res.json();
			if (gen !== loadGen) return;
			if (!prefsLoaded) {
				prefVisibility = s.settings?.mastoVisibility ?? 'public';
				prefAccounts = s.settings?.defaultAccountIds ?? [];
			}
			prefsLoaded = true;
		} finally {
			if (gen === loadGen) prefsLoading = false;
		}
	}

	async function savePrefs(e: Event) {
		e.preventDefault();
		prefBusy = true;
		notice.clearError();
		prefSaved = null;
		try {
			const res = await fetch('/api/settings', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mastoVisibility: prefVisibility,
					defaultAccountIds: prefAccounts
				})
			});
			const payload = await res.json();
			if (!res.ok) throw new Error(payload.error || 'Could not save');
			prefSaved = 'Defaults saved';
		} catch (e) {
			notice.fail(humanizeError(e instanceof Error ? e.message : 'Could not save'));
		} finally {
			prefBusy = false;
		}
	}

	function togglePrefAccount(id: string) {
		prefAccounts = prefAccounts.includes(id)
			? prefAccounts.filter((a) => a !== id)
			: [...prefAccounts, id];
	}

	function setAskPublish(on: boolean) {
		askPublish = on;
		try {
			if (on) localStorage.removeItem(SKIP_ASK_KEY);
			else localStorage.setItem(SKIP_ASK_KEY, '1');
		} catch {
			// prefs are cosmetic
		}
	}

	onMount(() => {
		void load();
		try {
			askPublish = localStorage.getItem(SKIP_ASK_KEY) !== '1';
		} catch {
			// storage unavailable: default holds
		}
	});
</script>

<SettingsCard
	title="New post defaults"
	description="Applied to new drafts. Deep-linked drafts keep their own accounts."
>
	<form class="space-y-6" onsubmit={savePrefs}>
		<div class="space-y-2">
			<label
				for="masto-visibility"
				class="block text-[11px] font-bold tracking-widest text-stone-500 uppercase"
			>
				Mastodon visibility
			</label>
			<div class="relative max-w-xs">
				<select
					id="masto-visibility"
					bind:value={prefVisibility}
					disabled={prefsLoading || !prefsLoaded}
					class="w-full appearance-none rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-2.5 text-[13px] font-bold text-stone-900 focus:border-stone-400 focus:bg-white focus:outline-none disabled:opacity-50 pointer-coarse:text-base"
				>
					{#each MASTO_VISIBILITIES as value (value)}
						<option {value}>{MASTO_VISIBILITY_LABELS[value]}</option>
					{/each}
				</select>
				<div class="pointer-events-none absolute inset-y-0 right-4 flex items-center">
					<svg
						class="h-4 w-4 text-stone-500"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"><path d="m6 9 6 6 6-6" /></svg
					>
				</div>
			</div>
		</div>

		<div class="space-y-2" role="group" aria-labelledby="preselected-label">
			<span
				id="preselected-label"
				class="block text-[11px] font-bold tracking-widest text-stone-500 uppercase"
			>
				Selected accounts
			</span>
			<p class="text-[12px] font-medium text-stone-500">
				Ticked when you start a post. With none chosen, every active account is.
			</p>
			<div class="flex flex-col gap-1 pt-1">
				{#each allAccounts as a (a.id)}
					{@const isOn = prefAccounts.includes(a.id)}
					<button
						type="button"
						onclick={() => togglePrefAccount(a.id)}
						disabled={prefsLoading || !prefsLoaded}
						aria-pressed={isOn}
						class="group flex w-full items-center justify-between rounded-xl border border-transparent p-2 text-left transition-colors hover:border-stone-100 hover:bg-stone-50 disabled:opacity-50"
					>
						<div class="flex items-center gap-3 overflow-hidden">
							<div class="shrink-0 transition-transform group-hover:scale-105">
								<AccountAvatar
									platform={a.platform}
									handle={a.handle}
									displayName={a.displayName}
									avatarUrl={a.avatarUrl}
									size={32}
									selected={false}
									title={accountLabel(a.displayName, a.handle) || undefined}
								/>
							</div>
							<div class="flex flex-col overflow-hidden">
								<span class="truncate text-[13px] font-bold text-stone-900"
									>{a.displayName || displayHandle(a.handle) || 'account'}</span
								>
								<span class="truncate text-[11px] font-medium text-stone-500"
									>{platformName(a.platform)}</span
								>
							</div>
						</div>
						<div class="ml-2 shrink-0">
							<div
								class="relative inline-flex h-5 w-9 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out {isOn
									? 'bg-stone-900'
									: 'bg-stone-200'}"
							>
								<span
									class="inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out {isOn
										? 'translate-x-4'
										: 'translate-x-0'}"
								></span>
							</div>
						</div>
					</button>
				{:else}
					{#if prefsLoaded}
						<p class="text-[13px] font-medium text-stone-500">
							No accounts yet. <a
								href="/accounts"
								class="font-bold text-stone-900 underline underline-offset-2 hover:text-stone-700"
								>Connect one</a
							> to choose it here.
						</p>
					{/if}
				{/each}
			</div>
		</div>

		<div class="flex items-center gap-3 border-t border-stone-100 pt-4">
			{#if !prefsLoading && !prefsLoaded}
				<button
					type="button"
					onclick={() => void load()}
					class="rounded-full border border-stone-300 px-6 py-2.5 text-[13px] font-bold text-stone-700 transition-colors hover:bg-stone-100"
					>Retry</button
				>
			{:else}
				<button
					type="submit"
					disabled={prefBusy || prefsLoading || !prefsLoaded}
					class="rounded-full bg-stone-900 px-6 py-2.5 text-[13px] font-bold text-white shadow-md transition-all hover:bg-stone-800 disabled:opacity-50"
					>{prefsLoading ? 'Loading…' : 'Save defaults'}</button
				>
			{/if}
			{#if prefSaved}
				<span class="text-[13px] font-bold text-emerald-700">{prefSaved}</span>
			{/if}
		</div>
	</form>
</SettingsCard>

<SettingsCard
	title="Before publishing"
	description="Kept on this browser, and saved as soon as you switch it."
>
	<!-- Container click is mouse-only convenience; keyboard users toggle via the switch button. -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="flex cursor-pointer items-center gap-3" onclick={() => setAskPublish(!askPublish)}>
		<button
			type="button"
			role="switch"
			aria-checked={askPublish}
			aria-labelledby="ask-publish-label"
			onclick={(e) => {
				e.stopPropagation();
				setAskPublish(!askPublish);
			}}
			class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none {askPublish
				? 'bg-stone-900'
				: 'bg-stone-200'}"
		>
			<span
				class="pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out {askPublish
					? 'translate-x-4'
					: 'translate-x-0'}"
			></span>
		</button>
		<span id="ask-publish-label" class="text-[13px] font-medium text-stone-600"
			>Ask for confirmation before publishing</span
		>
	</div>
</SettingsCard>

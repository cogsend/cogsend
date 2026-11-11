<script lang="ts">
	import { onMount } from 'svelte';
	import UpdatePanel from '#lib/components/UpdatePanel.svelte';
	import { markUpdateSeen, noteRelease } from '#lib/components/update-notice.svelte.js';
	import { timeAgo } from '#lib/domain/relative-time.js';
	import SettingsCard from './SettingsCard.svelte';
	import { settingsGet, useSettingsNotice } from './settings-notice.svelte.js';

	const notice = useSettingsNotice();
	// The update check: a courtesy, so a failure is one quiet line saying why,
	// since installing by tag below still works without it.
	type ReleaseCheck = {
		current: string;
		latest: { tag: string; version: string; url: string } | null;
		updateAvailable: boolean;
		checkedAt: string | null;
		error?: string;
	};
	let release = $state<ReleaseCheck | null>(null);
	let releaseBusy = $state(false);
	let offerPrereleases = $state(false);
	// Seeing the notice here is what clears the header's dot.
	$effect(() => {
		if (!release) return;
		noteRelease(release);
		if (release.updateAvailable) markUpdateSeen();
	});

	async function load() {
		const [settings, check] = await Promise.all([
			settingsGet('/api/settings', notice),
			settingsGet('/api/release', notice)
		]);
		if (settings?.ok) {
			const s = await settings.json();
			offerPrereleases = s.offerPrereleases === true;
		}
		if (check?.ok) release = await check.json();
	}

	async function saveOfferPrereleases(on: boolean) {
		notice.clearError();
		try {
			const res = await fetch('/api/settings', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ offerPrereleases: on })
			});
			if (!res.ok) throw new Error();
			// Which releases count changed: ask again rather than wait for the cache.
			await checkForUpdates();
		} catch {
			offerPrereleases = !on;
			notice.fail('Could not save the pre-release setting');
		}
	}

	async function checkForUpdates() {
		releaseBusy = true;
		try {
			const res = await fetch('/api/release?refresh=1');
			if (res.ok) release = await res.json();
		} catch {
			// Silent: the update check is a courtesy, not a setting.
		} finally {
			releaseBusy = false;
		}
	}

	onMount(() => {
		void load();
	});
</script>

<SettingsCard
	title="Updates"
	description="Install a new release, or go back to the one before, without leaving CogSend."
	id="instance"
>
	<div class="mb-5 flex flex-wrap items-start justify-between gap-3" data-testid="version-line">
		<div class="min-w-0">
			<p class="text-[13px] font-extrabold text-stone-900">Version {__APP_VERSION__}</p>
			<p class="mt-0.5 text-[12px] font-medium text-stone-500">
				{#if release?.updateAvailable && release.latest}
					<span class="font-bold text-amber-700">{release.latest.version} is available</span>
					·
					<a
						href={release.latest.url}
						target="_blank"
						rel="noreferrer"
						class="font-bold text-stone-900 underline underline-offset-2 hover:text-stone-700"
						>What's new</a
					>
				{:else if release?.error && !release.latest}
					<span data-testid="release-check-error"
						>Could not reach GitHub to check ({release.error}). Try again later, or install a
						release by its tag below.</span
					>
				{:else if release}
					Up to date{release.checkedAt ? ` · checked ${timeAgo(release.checkedAt)}` : ''}
				{:else}
					Checking for updates…
				{/if}
			</p>
		</div>
		{#if !release?.updateAvailable}
			<button
				type="button"
				onclick={() => void checkForUpdates()}
				disabled={releaseBusy}
				class="shrink-0 rounded-full bg-stone-100 px-4 py-1.5 text-[12px] font-bold text-stone-700 transition-all hover:bg-stone-200 disabled:opacity-50"
				>{releaseBusy ? 'Checking…' : 'Check for updates'}</button
			>
		{/if}
	</div>

	<UpdatePanel latestTag={release?.updateAvailable ? (release.latest?.tag ?? null) : null} />

	<div class="mt-6 border-t border-stone-100 pt-5">
		<label class="flex items-start gap-2.5 text-[12px] font-medium text-stone-500">
			<input
				type="checkbox"
				bind:checked={offerPrereleases}
				onchange={() => void saveOfferPrereleases(offerPrereleases)}
				class="mt-0.5"
				data-testid="offer-prereleases"
			/>
			<span>
				<span class="block text-[13px] font-bold text-stone-700">Offer pre-releases too</span>
				Release candidates, for testing a release before it is published. Not for an instance you rely
				on.
			</span>
		</label>
	</div>
</SettingsCard>

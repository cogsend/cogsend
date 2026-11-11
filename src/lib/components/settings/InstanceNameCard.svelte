<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { humanizeError } from '#lib/domain/human-error.js';
	import { INSTANCE_NAME_MAX } from '#lib/domain/instance-name.js';
	import SettingsCard from './SettingsCard.svelte';
	import { settingsGet, useSettingsNotice } from './settings-notice.svelte.js';

	let { initialName }: { initialName: string } = $props();

	const notice = useSettingsNotice();
	// svelte-ignore state_referenced_locally
	let instanceName = $state(initialName);
	// svelte-ignore state_referenced_locally
	let savedInstanceName = $state(initialName.trim());
	let instanceBusy = $state(false);

	async function load() {
		const res = await settingsGet('/api/settings', notice);
		if (!res) return;
		if (!res.ok) {
			notice.fail('Could not load your settings');
			return;
		}
		const s = await res.json();
		// Don't clobber a name the user already edited.
		if (instanceName.trim() === savedInstanceName) {
			instanceName = s.instanceName ?? '';
			savedInstanceName = instanceName.trim();
		}
	}

	/** Same rules as the server, so a typo never costs the user their other edits. */
	async function saveInstanceName(e: Event) {
		e.preventDefault();
		const name = instanceName.trim();
		if (name.length > INSTANCE_NAME_MAX) {
			notice.fail(`Keep the instance name under ${INSTANCE_NAME_MAX} characters`);
			return;
		}
		instanceBusy = true;
		notice.clearError();
		try {
			const res = await fetch('/api/settings', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ instanceName: name })
			});
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(payload.error || 'Could not save');
			instanceName = payload.instanceName ?? name;
			savedInstanceName = instanceName.trim();
			notice.ok('Instance name saved');
			// The title and header come from the layout, which reads the stored
			// name: refresh them without a full reload.
			await invalidateAll();
		} catch (e) {
			notice.fail(humanizeError(e instanceof Error ? e.message : 'Could not save'));
		} finally {
			instanceBusy = false;
		}
	}

	onMount(() => {
		void load();
	});
</script>

<SettingsCard
	title="Instance name"
	description="Shown in the page title, the header and the login screen. Leave it empty for the default."
>
	<form class="flex flex-col gap-3 sm:flex-row sm:items-center" onsubmit={saveInstanceName}>
		<input
			type="text"
			bind:value={instanceName}
			maxlength={INSTANCE_NAME_MAX}
			placeholder="CogSend"
			aria-label="Instance name"
			class="w-full flex-1 rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-2.5 text-[13px] font-bold text-stone-900 focus:border-stone-400 focus:bg-white focus:outline-none pointer-coarse:text-base"
		/>
		<button
			type="submit"
			disabled={instanceBusy || instanceName.trim() === savedInstanceName}
			class="w-full shrink-0 rounded-full bg-stone-900 px-6 py-2.5 text-[13px] font-bold text-white shadow-md transition-all hover:bg-stone-800 disabled:opacity-50 sm:w-auto"
			>Save</button
		>
	</form>
</SettingsCard>

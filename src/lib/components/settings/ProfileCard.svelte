<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { Pencil, User } from '@lucide/svelte';
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import { humanizeError } from '#lib/domain/human-error.js';
	import {
		isValidProfilePictureUrl,
		PROFILE_PICTURE_URL_MAX
	} from '#lib/domain/profile-settings.js';
	import SettingsCard from './SettingsCard.svelte';
	import { settingsGet, useSettingsNotice } from './settings-notice.svelte.js';

	let { initialName, initialPicture }: { initialName: string; initialPicture: string } = $props();

	const notice = useSettingsNotice();
	// Name and photo are already on the layout load, so the card is not blank
	// while the stored settings are still fetching.
	// svelte-ignore state_referenced_locally
	let displayName = $state(initialName);
	// The name the server last accepted: Save stays disabled until the draft
	// drifts from it. The picture is not tracked here because it saves from its
	// own dialog.
	// svelte-ignore state_referenced_locally
	let savedDisplayName = $state(initialName.trim());
	// svelte-ignore state_referenced_locally
	let profilePictureUrl = $state(initialPicture);
	let pictureBroken = $state(false);
	let isPictureDialogOpen = $state(false);
	let pictureDialogUrl = $state('');
	// Set once the user has tried to save a bad URL, so the message appears on
	// demand and then keeps up as they edit.
	let pictureTouched = $state(false);
	let pictureServerError = $state<string | null>(null);
	let pictureBusy = $state(false);
	let profileSaved = $state<string | null>(null);
	let profileSavedTimer: ReturnType<typeof setTimeout> | null = null;
	let profileBusy = $state(false);
	const nameDirty = $derived(displayName.trim() !== savedDisplayName);
	const pictureMessage = $derived(
		pictureServerError ?? (pictureTouched ? pictureUrlError(pictureDialogUrl) : null)
	);

	async function load() {
		const res = await settingsGet('/api/settings', notice);
		if (!res) return;
		if (!res.ok) {
			notice.fail('Could not load your settings');
			return;
		}
		const s = await res.json();
		// Don't clobber a name the user already edited.
		if (displayName.trim() === savedDisplayName) {
			displayName = s.displayName ?? '';
			savedDisplayName = displayName.trim();
		}
		if (!isPictureDialogOpen) {
			profilePictureUrl = s.settings?.profilePictureUrl ?? '';
			pictureBroken = false;
		}
	}

	async function saveProfile(e: Event) {
		e.preventDefault();
		profileBusy = true;
		notice.clearError();
		clearProfileSaved();
		try {
			// This card owns the name only. Sending the picture or the new-post
			// defaults would commit edits the user never saved in those sections.
			const res = await fetch('/api/settings', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ displayName: displayName.trim() })
			});
			const payload = await res.json();
			if (!res.ok) throw new Error(payload.error || 'Could not save');
			displayName = payload.displayName ?? '';
			savedDisplayName = displayName.trim();
			flashProfileSaved('Profile saved');
			await invalidateAll();
		} catch (e) {
			notice.fail(humanizeError(e instanceof Error ? e.message : 'Could not save'));
		} finally {
			profileBusy = false;
		}
	}

	function pictureUrlError(value: string): string | null {
		const trimmed = value.trim();
		if (!trimmed) return null;
		if (trimmed.length > PROFILE_PICTURE_URL_MAX) {
			return `URL is too long (max ${PROFILE_PICTURE_URL_MAX} characters)`;
		}
		return isValidProfilePictureUrl(trimmed) ? null : 'Enter an https:// image URL';
	}

	async function commitPictureUrl(url: string) {
		pictureBusy = true;
		pictureServerError = null;
		try {
			const res = await fetch('/api/settings', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ profilePictureUrl: url })
			});
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(payload.error || 'Could not save picture');
			profilePictureUrl = payload.settings?.profilePictureUrl ?? '';
			pictureBroken = false;
			pictureTouched = false;
			isPictureDialogOpen = false;
			flashProfileSaved(url ? 'Profile picture saved' : 'Profile picture removed');
			await invalidateAll();
		} catch (e) {
			pictureServerError = humanizeError(e instanceof Error ? e.message : 'Could not save picture');
		} finally {
			pictureBusy = false;
		}
	}

	function savePicture() {
		// Enter in the URL field reaches this too, bypassing the dialog's busy button.
		if (pictureBusy) return;
		if (pictureUrlError(pictureDialogUrl)) {
			pictureTouched = true;
			return;
		}
		void commitPictureUrl(pictureDialogUrl.trim());
	}

	function removePicture() {
		void commitPictureUrl('');
	}

	function flashProfileSaved(text: string) {
		clearProfileSaved();
		profileSaved = text;
		profileSavedTimer = setTimeout(() => {
			profileSaved = null;
			profileSavedTimer = null;
		}, 4000);
	}

	function clearProfileSaved() {
		if (profileSavedTimer) clearTimeout(profileSavedTimer);
		profileSavedTimer = null;
		profileSaved = null;
	}

	onMount(() => {
		void load();
		return () => {
			if (profileSavedTimer) clearTimeout(profileSavedTimer);
		};
	});
</script>

<SettingsCard title="Profile">
	<form class="space-y-5" onsubmit={saveProfile}>
		<div class="flex flex-col gap-5 sm:flex-row sm:items-start sm:gap-6">
			<div class="relative shrink-0 self-start">
				<span
					class="flex h-20 w-20 items-center justify-center rounded-full border border-stone-200 bg-stone-100 text-stone-500 shadow-sm"
					aria-hidden="true"
				>
					<User class="h-7 w-7" />
				</span>
				{#if profilePictureUrl.trim() && !pictureBroken}
					<img
						src={profilePictureUrl.trim()}
						alt="Profile avatar"
						class="absolute inset-0 h-20 w-20 rounded-full border border-stone-200 object-cover shadow-sm"
						onerror={() => (pictureBroken = true)}
					/>
				{/if}
				<button
					type="button"
					onclick={() => {
						pictureDialogUrl = profilePictureUrl;
						pictureTouched = false;
						pictureServerError = null;
						isPictureDialogOpen = true;
					}}
					aria-label={profilePictureUrl.trim() ? 'Edit profile picture' : 'Add profile picture'}
					title="Edit profile picture"
					class="absolute -right-0.5 -bottom-0.5 flex h-8 w-8 items-center justify-center rounded-full border border-stone-200 bg-white text-stone-600 shadow-sm transition-colors hover:bg-stone-100 hover:text-stone-900 disabled:opacity-50"
				>
					<Pencil class="h-4 w-4" />
				</button>
			</div>
			<div class="flex min-w-0 flex-1 flex-col gap-5">
				<div>
					<label
						for="display-name"
						class="mb-2 block text-[11px] font-bold tracking-widest text-stone-500 uppercase"
						>Display name</label
					>
					<input
						id="display-name"
						type="text"
						bind:value={displayName}
						placeholder="Your name"
						maxlength="80"
						autocomplete="name"
						class="w-full rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-2.5 text-[13px] font-bold text-stone-900 shadow-sm transition-all focus:border-stone-900 focus:bg-white focus:ring-2 focus:ring-stone-900 focus:outline-none disabled:opacity-50 pointer-coarse:text-base"
					/>
				</div>
			</div>
		</div>
		<div class="flex flex-wrap items-center gap-3 border-t border-stone-100 pt-4">
			<button
				type="submit"
				disabled={profileBusy || !nameDirty}
				class="inline-flex items-center gap-2 rounded-full bg-stone-900 px-6 py-2.5 text-[13px] font-bold text-white shadow-md transition-all hover:bg-stone-800 disabled:opacity-50"
			>
				{profileBusy ? 'Saving…' : 'Save'}
			</button>
			{#if profileSaved}
				<span class="text-xs font-bold text-emerald-700" role="status">{profileSaved}</span>
			{/if}
		</div>
	</form>
</SettingsCard>

<ConfirmDialog
	open={isPictureDialogOpen}
	idPrefix="picture-dialog"
	title="Profile picture"
	confirmLabel="Save"
	cancelLabel="Cancel"
	tone="primary"
	busy={pictureBusy}
	onConfirm={savePicture}
	onCancel={() => {
		pictureTouched = false;
		pictureServerError = null;
		isPictureDialogOpen = false;
	}}
>
	{#snippet details()}
		<div class="flex flex-col items-stretch gap-3">
			{#key pictureDialogUrl.trim()}
				{#if pictureDialogUrl.trim()}
					<div class="flex justify-center">
						<img
							src={pictureDialogUrl.trim()}
							alt=""
							class="h-16 w-16 rounded-full border border-stone-200 object-cover shadow-sm"
							onerror={(e) => {
								(e.currentTarget as HTMLImageElement).style.display = 'none';
							}}
						/>
					</div>
				{/if}
			{/key}
			<label class="block text-sm">
				<span class="mb-1 block text-[11px] font-bold tracking-widest text-stone-500 uppercase"
					>Image URL</span
				>
				<input
					id="profile-picture-url"
					type="url"
					bind:value={pictureDialogUrl}
					placeholder="https://example.com/avatar.jpg"
					aria-invalid={pictureMessage !== null}
					aria-describedby={pictureMessage ? 'profile-picture-error' : undefined}
					onkeydown={(e) => {
						// The dialog's Save button sits outside this snippet, so Enter
						// has to reach the same handler explicitly.
						if (e.key !== 'Enter') return;
						e.preventDefault();
						savePicture();
					}}
					class="w-full rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-2.5 text-[13px] font-bold text-stone-900 shadow-sm transition-all focus:border-stone-900 focus:bg-white focus:ring-2 focus:ring-stone-900 focus:outline-none pointer-coarse:text-base"
				/>
			</label>
			{#if pictureMessage}
				<p id="profile-picture-error" class="text-[12px] font-medium text-red-600" role="alert">
					{pictureMessage}
				</p>
			{/if}
			{#if profilePictureUrl.trim()}
				<button
					type="button"
					onclick={removePicture}
					disabled={pictureBusy}
					class="self-start text-[12px] font-bold text-red-600 underline underline-offset-2 hover:text-red-700 disabled:opacity-50"
				>
					Remove picture
				</button>
			{/if}
		</div>
	{/snippet}
</ConfirmDialog>

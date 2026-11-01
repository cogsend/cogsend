<script lang="ts">
	import { onMount } from 'svelte';
	import { formatRelativeTime } from '#lib/domain/relative-time.js';
	import CopyButton from '#lib/components/CopyButton.svelte';
	import { showToast } from '#lib/components/toast.svelte.js';

	let { data } = $props();

	type User = {
		id: string;
		email: string;
		displayName: string | null;
		role: 'admin' | 'member';
		status: 'active' | 'pending' | 'unverified' | 'suspended';
		totpEnabled: boolean;
		createdAt: number;
		lastLoginAt: number | null;
		lastSeenAt: number | null;
		drafts: number;
		connections: number;
	};
	type Invite = {
		id: string;
		note: string | null;
		createdAt: number;
		expiresAt: number;
		usedAt: number | null;
		state: 'open' | 'used' | 'expired';
	};
	type Registration = {
		mode: 'off' | 'waitlist' | 'open';
		enabled: boolean;
		cap: number;
		modeSource: 'env' | 'admin';
		capSource: 'env' | 'admin' | 'default';
		activeCount: number;
		pendingCount: number;
		verifyEmail: boolean;
	};

	let users = $state<User[]>([]);
	let invites = $state<Invite[]>([]);
	let registration = $state<Registration | null>(null);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let busyId = $state<string | null>(null);

	let modeDraft = $state<'off' | 'waitlist' | 'open'>('off');
	let capDraft = $state('');
	let savingRegistration = $state(false);

	let inviteNote = $state('');
	let inviteDays = $state(7);
	let inviteLink = $state<string | null>(null);

	let deleting = $state<User | null>(null);
	let deletePassword = $state('');
	let deleteError = $state<string | null>(null);

	const statusLabel: Record<User['status'], string> = {
		active: 'Active',
		pending: 'Waiting for approval',
		unverified: 'Email not confirmed',
		suspended: 'Suspended'
	};

	async function load() {
		loadError = null;
		try {
			const res = await fetch('/api/admin/users');
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || 'Could not load the users');
			users = body.users;
			invites = body.invites;
			registration = body.registration;
			modeDraft = body.registration.mode;
			capDraft = String(body.registration.cap);
		} catch (err) {
			loadError = err instanceof Error ? err.message : 'Could not load the users';
		} finally {
			loading = false;
		}
	}

	onMount(load);

	async function send(url: string, method: string, body?: unknown) {
		const res = await fetch(url, {
			method,
			headers: { 'Content-Type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		const payload = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(payload.error || `Request failed (${res.status})`);
		return { status: res.status, payload };
	}

	async function update(user: User, change: { status?: string; role?: string }, done: string) {
		busyId = user.id;
		try {
			await send(`/api/admin/users/${user.id}`, 'PATCH', change);
			showToast(done);
			await load();
		} catch (err) {
			showToast(err instanceof Error ? err.message : 'Could not update the account', 'error');
		} finally {
			busyId = null;
		}
	}

	async function confirmDelete(e: Event) {
		e.preventDefault();
		if (!deleting) return;
		deleteError = null;
		busyId = deleting.id;
		try {
			// Large media libraries are removed over several calls.
			for (let attempt = 0; attempt < 20; attempt++) {
				const { status } = await send(`/api/admin/users/${deleting.id}`, 'DELETE', {
					password: deletePassword
				});
				if (status !== 202) break;
			}
			showToast(`Deleted ${deleting.email} and all of its data`);
			deleting = null;
			deletePassword = '';
			await load();
		} catch (err) {
			deleteError = err instanceof Error ? err.message : 'Could not delete the account';
		} finally {
			busyId = null;
		}
	}

	async function saveRegistration(e: Event) {
		e.preventDefault();
		savingRegistration = true;
		try {
			await send('/api/admin/registration', 'PATCH', { mode: modeDraft, cap: capDraft });
			showToast('Sign-up settings saved');
			await load();
		} catch (err) {
			showToast(err instanceof Error ? err.message : 'Could not save', 'error');
		} finally {
			savingRegistration = false;
		}
	}

	async function createInvite(e: Event) {
		e.preventDefault();
		try {
			const { payload } = await send('/api/admin/invites', 'POST', {
				note: inviteNote,
				ttlDays: Number(inviteDays)
			});
			inviteLink = payload.link;
			inviteNote = '';
			await load();
		} catch (err) {
			showToast(err instanceof Error ? err.message : 'Could not create the invite', 'error');
		}
	}

	async function revokeInvite(invite: Invite) {
		try {
			await send(`/api/admin/invites/${invite.id}`, 'DELETE');
			await load();
		} catch (err) {
			showToast(err instanceof Error ? err.message : 'Could not revoke the invite', 'error');
		}
	}

	const card =
		'rounded-[2rem] border border-stone-200/80 bg-white p-6 shadow-[0_8px_30px_-12px_rgb(28_25_23/0.06)] sm:p-8';
	const smallButton =
		'rounded-full border border-stone-200 px-3 py-1 text-[12px] font-bold text-stone-700 transition-colors hover:bg-stone-50 disabled:opacity-50';
</script>

<svelte:head>
	<title>Users · {data.appName}</title>
</svelte:head>

<div class="grid gap-6" data-testid="admin-users">
	<div>
		<h1 class="text-[22px] font-extrabold tracking-tight text-stone-900">Users</h1>
		<p class="mt-1 text-[13px] font-medium text-stone-500">
			Who can use this instance. Members see only their own posts, accounts and keys; instance
			settings, platform apps and updates stay with admins.
		</p>
	</div>

	{#if loading}
		<p class="text-[13px] font-medium text-stone-500">Loading…</p>
	{:else if loadError}
		<p class="text-[13px] font-bold text-red-600" role="alert">{loadError}</p>
	{:else if registration}
		<section class={card} data-testid="registration-settings">
			<h2 class="mb-2 text-[17px] font-extrabold tracking-tight text-stone-900">Sign-up</h2>
			{#if !registration.enabled}
				<p class="text-[13px] font-medium text-stone-600">
					Public sign-up is off for this instance. Set the <code>REGISTRATION</code> Worker variable
					to
					<code>waitlist</code> or <code>open</code> to turn it on; until then nobody can create an account.
				</p>
			{:else}
				<p class="mb-4 text-[13px] font-medium text-stone-600" data-testid="cap-usage">
					{registration.activeCount} of {registration.cap} active accounts used{registration.pendingCount
						? `, ${registration.pendingCount} waiting for approval`
						: ''}.
					{registration.verifyEmail
						? 'New addresses are confirmed by email first.'
						: 'Email addresses are not confirmed (no NOTIFY_FROM sender), so approve by hand with care.'}
				</p>
				<form class="flex flex-wrap items-end gap-4" onsubmit={saveRegistration}>
					<label class="block text-sm">
						<span class="text-[11px] font-bold tracking-widest text-stone-500 uppercase">Mode</span>
						<select
							bind:value={modeDraft}
							class="mt-1.5 block rounded-xl border border-stone-200/80 bg-stone-50 px-3 py-2 text-sm font-bold text-stone-900"
						>
							<option value="off">Closed (invites only)</option>
							<option value="waitlist">Waitlist (approve each account)</option>
							<option value="open">Open until the cap</option>
						</select>
					</label>
					<label class="block text-sm">
						<span class="text-[11px] font-bold tracking-widest text-stone-500 uppercase"
							>Active-account cap</span
						>
						<input
							type="number"
							min="1"
							bind:value={capDraft}
							class="mt-1.5 block w-28 rounded-xl border border-stone-200/80 bg-stone-50 px-3 py-2 text-sm font-bold text-stone-900"
						/>
					</label>
					<button
						type="submit"
						disabled={savingRegistration}
						class="rounded-full bg-stone-900 px-5 py-2 text-[13px] font-bold text-white hover:bg-stone-800 disabled:opacity-50"
						>Save</button
					>
				</form>
			{/if}
		</section>

		<section class={card} data-testid="user-list">
			<h2 class="mb-4 text-[17px] font-extrabold tracking-tight text-stone-900">
				Accounts ({users.length})
			</h2>
			<ul class="divide-y divide-stone-100">
				{#each users as user (user.id)}
					<li class="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between">
						<div class="min-w-0">
							<p class="truncate text-[14px] font-extrabold text-stone-900">
								{user.displayName || user.email}
								{#if user.id === data.selfId}<span class="text-stone-400"> (you)</span>{/if}
							</p>
							<p class="truncate text-[12px] font-medium text-stone-500">
								{user.email} · {user.role === 'admin' ? 'Admin' : 'Member'} · {statusLabel[
									user.status
								]}
							</p>
							<p class="text-[11px] font-medium text-stone-400">
								Joined {formatRelativeTime(new Date(user.createdAt))} · last seen {user.lastSeenAt
									? formatRelativeTime(new Date(user.lastSeenAt))
									: user.lastLoginAt
										? formatRelativeTime(new Date(user.lastLoginAt))
										: 'never'} · {user.drafts} posts · {user.connections} accounts{user.totpEnabled
									? ''
									: ' · no authenticator yet'}
							</p>
						</div>
						{#if user.id !== data.selfId}
							<div class="flex flex-wrap gap-2">
								{#if user.status === 'pending' || user.status === 'unverified'}
									<button
										type="button"
										class={smallButton}
										disabled={busyId === user.id}
										onclick={() => update(user, { status: 'active' }, `Approved ${user.email}`)}
										>Approve</button
									>
								{/if}
								{#if user.status === 'active'}
									<button
										type="button"
										class={smallButton}
										disabled={busyId === user.id}
										onclick={() => update(user, { status: 'suspended' }, `Suspended ${user.email}`)}
										>Suspend</button
									>
								{:else if user.status === 'suspended'}
									<button
										type="button"
										class={smallButton}
										disabled={busyId === user.id}
										onclick={() => update(user, { status: 'active' }, `Reinstated ${user.email}`)}
										>Reinstate</button
									>
								{/if}
								<button
									type="button"
									class={smallButton}
									disabled={busyId === user.id}
									onclick={() =>
										update(
											user,
											{ role: user.role === 'admin' ? 'member' : 'admin' },
											user.role === 'admin'
												? `${user.email} is a member now`
												: `${user.email} is an admin now`
										)}>{user.role === 'admin' ? 'Make member' : 'Make admin'}</button
								>
								<button
									type="button"
									class="{smallButton} text-red-700"
									disabled={busyId === user.id}
									onclick={() => {
										deleting = user;
										deletePassword = '';
										deleteError = null;
									}}>Delete</button
								>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		</section>

		{#if registration.enabled}
			<section class={card} data-testid="invites">
				<h2 class="mb-2 text-[17px] font-extrabold tracking-tight text-stone-900">Invite links</h2>
				<p class="mb-4 text-[13px] font-medium text-stone-600">
					Each link creates one account, skips the waitlist and the cap, and expires unused.
				</p>
				<form class="mb-4 flex flex-wrap items-end gap-4" onsubmit={createInvite}>
					<label class="block text-sm">
						<span class="text-[11px] font-bold tracking-widest text-stone-500 uppercase"
							>Note (optional)</span
						>
						<input
							type="text"
							maxlength="120"
							bind:value={inviteNote}
							placeholder="Who it is for"
							class="mt-1.5 block rounded-xl border border-stone-200/80 bg-stone-50 px-3 py-2 text-sm font-bold text-stone-900"
						/>
					</label>
					<label class="block text-sm">
						<span class="text-[11px] font-bold tracking-widest text-stone-500 uppercase"
							>Valid for (days)</span
						>
						<input
							type="number"
							min="1"
							max="90"
							bind:value={inviteDays}
							class="mt-1.5 block w-24 rounded-xl border border-stone-200/80 bg-stone-50 px-3 py-2 text-sm font-bold text-stone-900"
						/>
					</label>
					<button
						type="submit"
						class="rounded-full bg-stone-900 px-5 py-2 text-[13px] font-bold text-white hover:bg-stone-800"
						>Create link</button
					>
				</form>
				{#if inviteLink}
					<div class="mb-4 rounded-xl bg-stone-50 p-3" data-testid="invite-link">
						<p class="mb-2 text-[12px] font-bold text-amber-800">
							Copy it now: the link is not shown again.
						</p>
						<div class="flex items-center gap-2">
							<code class="min-w-0 flex-1 truncate text-[12px] text-stone-800">{inviteLink}</code>
							<CopyButton value={inviteLink} ariaLabel="Copy invite link" />
						</div>
					</div>
				{/if}
				{#if invites.length}
					<ul class="divide-y divide-stone-100">
						{#each invites as invite (invite.id)}
							<li class="flex items-center justify-between gap-3 py-2 text-[12px]">
								<span class="min-w-0 truncate font-medium text-stone-700">
									{invite.note || 'Invite'} ·
									{invite.state === 'open'
										? `expires ${formatRelativeTime(new Date(invite.expiresAt))}`
										: invite.state === 'used'
											? 'used'
											: 'expired'}
								</span>
								{#if invite.state === 'open'}
									<button type="button" class={smallButton} onclick={() => revokeInvite(invite)}
										>Revoke</button
									>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/if}
	{/if}
</div>

{#if deleting}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 px-4"
		role="dialog"
		aria-modal="true"
		aria-labelledby="delete-user-title"
	>
		<form class="{card} w-full max-w-md space-y-4" onsubmit={confirmDelete}>
			<h2 id="delete-user-title" class="text-[17px] font-extrabold text-stone-900">
				Delete {deleting.email}?
			</h2>
			<p class="text-[13px] font-medium text-stone-600">
				This removes the account with every post, schedule, media file, connected account, preview
				link and API key it owns. It cannot be undone.
			</p>
			<label class="block text-sm">
				<span class="text-[11px] font-bold tracking-widest text-stone-500 uppercase"
					>Your password</span
				>
				<input
					type="password"
					autocomplete="current-password"
					bind:value={deletePassword}
					required
					class="mt-1.5 w-full rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-2.5 text-sm font-bold text-stone-900"
				/>
			</label>
			{#if deleteError}
				<p class="text-[13px] font-bold text-red-600" role="alert">{deleteError}</p>
			{/if}
			<div class="flex justify-end gap-2">
				<button type="button" class={smallButton} onclick={() => (deleting = null)}>Keep</button>
				<button
					type="submit"
					disabled={busyId === deleting.id}
					class="rounded-full bg-red-600 px-4 py-1.5 text-[12px] font-bold text-white hover:bg-red-700 disabled:opacity-50"
					>Delete account</button
				>
			</div>
		</form>
	</div>
{/if}

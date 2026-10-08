<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { ChevronDown, Plug, Plus, X } from '@lucide/svelte';
	import { fade, fly } from 'svelte/transition';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import CopyButton from '$lib/components/CopyButton.svelte';
	import AccountAvatar from '$lib/components/AccountAvatar.svelte';
	import SocialIcon from '$lib/components/SocialIcon.svelte';
	import { accountLabel, displayHost, platformName, platformRank } from '$lib/domain/platforms';
	import { humanizeError } from '$lib/domain/human-error';
	import {
		PLATFORM_SETUP,
		callbackUri,
		emptyStateSentence,
		isOAuthPlatform,
		missingSecrets,
		needsSetup,
		platformSecretNames,
		secretsPutCommandFor,
		secretLabel,
		setupGuideUrl,
		type OAuthPlatformId
	} from '$lib/domain/platform-setup';
	import { buildAgentPrompt } from '$lib/domain/agent-prompt';
	import { sessionExpiredIfUnauthorized } from '$lib/components/session-expired';
	import { dialogFocus } from '$lib/components/dialog-focus';
	import { ZERNIO_API_KEYS_URL } from '$lib/domain/zernio';
	import { zernioLink } from '$lib/domain/zernio-links';

	let { data } = $props();

	type Connection = {
		id: string;
		platform: string;
		handle: string | null;
		displayName: string | null;
		avatarUrl?: string | null;
		instanceUrl: string | null;
		status: string;
		metaJson?: { provider?: string; zernioProfileId?: string } | null;
	};
	type ZernioAccount = {
		id: string;
		platform: string;
		profileId: string;
		handle: string | null;
		displayName: string | null;
		avatarUrl: string | null;
		needsReconnection: boolean;
		imported: boolean;
	};
	// Bluesky is imported, never connected from here: Zernio's hosted Bluesky
	// page cannot bring the visitor back with a usable result yet.
	const ZERNIO_PLATFORMS = ['x', 'threads', 'linkedin'] as const;
	const isZernioPlatform = (p: string): p is (typeof ZERNIO_PLATFORMS)[number] =>
		(ZERNIO_PLATFORMS as readonly string[]).includes(p);
	const viaZernio = (account: Connection) => account.metaJson?.provider === 'zernio';

	// Same order load() applies after a refresh, so the first paint matches it.
	// svelte-ignore state_referenced_locally
	let connections = $state<Connection[]>(
		[...(data.connections ?? [])].sort(
			(a: Connection, b: Connection) => platformRank(a.platform) - platformRank(b.platform)
		)
	);
	// svelte-ignore state_referenced_locally
	let configured = $state<{ linkedin: boolean; threads: boolean; x: boolean }>(
		data.configured ?? {
			linkedin: true,
			threads: true,
			x: true
		}
	);
	// Per-secret presence from the API. The panel names the missing half of a
	// half-configured platform instead of repeating "no credentials yet" for a
	// client id that is already uploaded.
	// svelte-ignore state_referenced_locally
	let secretPresence = $state<Record<string, boolean>>(data.secrets ?? {});
	// Where each platform's app credentials come from: Worker secrets, or the
	// form in the setup panel. Only the form's own can be changed from here.
	// svelte-ignore state_referenced_locally
	let credentialSources = $state<Record<OAuthPlatformId, 'env' | 'app' | null>>(
		data.sources ?? { linkedin: null, threads: null, x: null }
	);
	// svelte-ignore state_referenced_locally
	let savedClientIds = $state<Record<OAuthPlatformId, string | null>>(
		data.savedClientIds ?? { linkedin: null, threads: null, x: null }
	);
	let appForm = $state<Record<string, string>>({});
	let appFormBusy = $state(false);
	let appFormError = $state<string | null>(null);
	let handle = $state('');
	let appPassword = $state('');
	let instanceUrl = $state('');
	let msg = $state<string | null>(null);
	// svelte-ignore state_referenced_locally
	let err = $state<string | null>(data.loadFailed ? 'Could not load accounts' : null);
	let loading = $state(false);
	// First-load flag: while true show skeleton rows instead of the
	// "No accounts yet" empty state (avoids flash on every visit).
	let initialLoading = $state(false);
	// Distinguishes "the list is empty" from "the list never arrived": the
	// former gets the connect prompt, the latter must not.
	// svelte-ignore state_referenced_locally
	let loadFailed = $state(Boolean(data.loadFailed));
	let verifying = $state<string | null>(null);
	let pendingDisconnect = $state<{ id: string; label: string } | null>(null);
	let disconnectBusy = $state(false);
	let showConnectDialog = $state(false);
	let modalForm = $state<'none' | 'bluesky' | 'mastodon' | 'zernio'>('none');
	// Set when the picked platform has no credentials on this deployment: the
	// dialog shows its setup steps instead of a request that can only fail.
	let setupPanel = $state<OAuthPlatformId | null>(null);
	// The deployment's own APP_URL, for the redirect URI the provider needs.
	// svelte-ignore state_referenced_locally
	let appUrl = $state(data.appUrl ?? '');
	let connectCloseBtn: HTMLButtonElement | null = $state(null);
	let zernioApiKey = $state('');
	let zernioProfiles = $state<Array<{ id: string; name: string }>>([]);
	let zernioAccounts = $state<ZernioAccount[] | null>(null);
	let zernioSelected = $state<string[]>([]);
	// svelte-ignore state_referenced_locally
	let zernioHasStoredKey = $state(connections.some(viaZernio));
	let zernioConnectPlatform = $state<(typeof ZERNIO_PLATFORMS)[number]>('x');
	let zernioConnectProfile = $state('');

	const availablePlatforms = [
		{
			id: 'x',
			name: 'X',
			description: 'Post with the X API (uses pay-per-use credits)',
			form: null
		},
		{
			id: 'threads',
			name: 'Threads',
			description: 'Connect your Threads account',
			form: null
		},
		{
			id: 'linkedin',
			name: 'LinkedIn',
			description: 'Connect your personal or company page',
			form: null
		},
		{
			id: 'mastodon',
			name: 'Mastodon',
			description: 'Connect via your instance',
			form: 'mastodon' as const
		},
		{
			id: 'bluesky',
			name: 'Bluesky',
			description: 'Connect with handle + app password',
			form: 'bluesky' as const
		}
	];

	async function load() {
		if (connections.length === 0) initialLoading = true;
		loadFailed = false;
		err = null;
		try {
			const res = await fetch('/api/connections');
			if (sessionExpiredIfUnauthorized(res)) {
				loadFailed = true;
				return;
			}
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) {
				loadFailed = true;
				err = humanizeError(payload.error || 'Could not load accounts');
				return;
			}
			connections = [...(payload.connections || [])].sort(
				(a: Connection, b: Connection) => platformRank(a.platform) - platformRank(b.platform)
			);
			zernioHasStoredKey = connections.some(viaZernio);
			if (typeof payload.appUrl === 'string') appUrl = payload.appUrl;
			if (payload.configured && typeof payload.configured === 'object') {
				configured = {
					linkedin: payload.configured.linkedin !== false,
					threads: payload.configured.threads !== false,
					x: payload.configured.x !== false
				};
			}
			if (payload.secrets && typeof payload.secrets === 'object') {
				secretPresence = payload.secrets as Record<string, boolean>;
			}
			if (payload.sources && typeof payload.sources === 'object') {
				credentialSources = payload.sources;
			}
			if (payload.savedClientIds && typeof payload.savedClientIds === 'object') {
				savedClientIds = payload.savedClientIds;
			}
		} catch (e) {
			loadFailed = true;
			err = humanizeError(e instanceof Error ? e.message : 'Could not load accounts');
		} finally {
			initialLoading = false;
		}
	}

	async function connectBluesky(e: Event) {
		e.preventDefault();
		loading = true;
		err = null;
		msg = null;
		try {
			const res = await fetch('/api/connections/bluesky', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ handle, appPassword })
			});
			const payload = await res.json();
			if (!res.ok) throw new Error(payload.error || 'Failed');
			msg = `Connected Bluesky as ${payload.connection.handle}`;
			appPassword = '';
			closeConnectDialog();
			await load();
		} catch (e) {
			err = humanizeError(e instanceof Error ? e.message : 'Failed');
		} finally {
			loading = false;
		}
	}

	async function connectOAuth(
		platform: 'mastodon' | 'linkedin' | 'threads' | 'x',
		body: Record<string, string>
	) {
		loading = true;
		err = null;
		try {
			const res = await fetch(`/api/connections/${platform}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) {
				// The secrets can be missing even when `configured` said otherwise
				// (a deployment that lost them, or this page still loading). The
				// route answers with a code, so this opens the setup steps instead
				// of a red banner naming environment variables.
				if (payload.code === 'platform_not_configured' && isOAuthPlatform(platform)) {
					showSetupPanel(platform);
					loading = false;
					return;
				}
				throw new Error(payload.error || 'Failed');
			}
			window.location.href = payload.authorizeUrl;
		} catch (e) {
			err = humanizeError(e instanceof Error ? e.message : 'Failed');
			loading = false;
		}
	}

	async function connectMastodon(e: Event) {
		e.preventDefault();
		loading = true;
		err = null;
		await connectOAuth('mastodon', { instanceUrl });
	}

	async function loadZernioAccounts(e?: Event) {
		e?.preventDefault();
		loading = true;
		err = null;
		try {
			const res = await fetch('/api/connections/zernio/accounts', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(zernioApiKey ? { apiKey: zernioApiKey } : {})
			});
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(payload.error || 'Could not reach Zernio');
			zernioProfiles = payload.profiles ?? [];
			zernioAccounts = payload.accounts ?? [];
			zernioHasStoredKey = payload.hasStoredKey === true || Boolean(zernioApiKey);
			zernioSelected = (zernioAccounts ?? []).filter((a) => !a.imported).map((a) => a.id);
			if (!zernioConnectProfile) zernioConnectProfile = zernioProfiles[0]?.id ?? '';
		} catch (e) {
			err = humanizeError(e instanceof Error ? e.message : 'Could not reach Zernio');
		} finally {
			loading = false;
		}
	}

	async function importZernioAccounts() {
		loading = true;
		err = null;
		try {
			const res = await fetch('/api/connections/zernio/import', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					...(zernioApiKey ? { apiKey: zernioApiKey } : {}),
					accountIds: zernioSelected
				})
			});
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(payload.error || 'Could not import');
			const n = (payload.connections ?? []).length;
			msg = `Imported ${n} account${n === 1 ? '' : 's'} from Zernio`;
			zernioApiKey = '';
			closeConnectDialog();
			await load();
		} catch (e) {
			err = humanizeError(e instanceof Error ? e.message : 'Could not import');
		} finally {
			loading = false;
		}
	}

	async function connectThroughZernio(platform: string, profileId: string) {
		loading = true;
		err = null;
		try {
			const res = await fetch('/api/connections/zernio/connect', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					...(zernioApiKey ? { apiKey: zernioApiKey } : {}),
					platform,
					profileId
				})
			});
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(payload.error || 'Could not start the connection');
			window.location.href = payload.authorizeUrl;
		} catch (e) {
			err = humanizeError(e instanceof Error ? e.message : 'Could not start the connection');
			loading = false;
		}
	}

	function openZernioForm(platform?: OAuthPlatformId) {
		openConnectDialog();
		modalForm = 'zernio';
		zernioAccounts = null;
		if (platform) zernioConnectPlatform = platform;
		if (zernioHasStoredKey) void loadZernioAccounts();
	}

	function toggleZernioAccount(id: string) {
		zernioSelected = zernioSelected.includes(id)
			? zernioSelected.filter((x) => x !== id)
			: [...zernioSelected, id];
	}

	function pickPlatform(id: string) {
		const found = availablePlatforms.find((p) => p.id === id);
		if (!found) return;
		if (found.form) {
			modalForm = found.form;
			return;
		}
		// A platform this deployment has no credentials for cannot be connected,
		// so say what it needs instead of requesting an authorize URL.
		if (needsSetup(id, configured)) {
			showSetupPanel(id as OAuthPlatformId);
			return;
		}
		if (isOAuthPlatform(id)) void connectOAuth(id, {});
	}

	function openConnectDialog() {
		// A new attempt supersedes whatever the last one reported.
		err = null;
		modalForm = 'none';
		setupPanel = null;
		showConnectDialog = true;
	}

	function showSetupPanel(platform: OAuthPlatformId) {
		err = null;
		appForm = {};
		appFormError = null;
		modalForm = 'none';
		setupPanel = platform;
		showConnectDialog = true;
	}

	/** The presence map and sources the platform-apps route answers with. */
	function applyCredentialStatus(payload: {
		configured?: typeof configured;
		secrets?: Record<string, boolean>;
		sources?: typeof credentialSources;
		savedClientIds?: typeof savedClientIds;
	}) {
		if (payload.configured) configured = payload.configured;
		if (payload.secrets) secretPresence = payload.secrets;
		if (payload.sources) credentialSources = payload.sources;
		if (payload.savedClientIds) savedClientIds = payload.savedClientIds;
	}

	async function saveAppCredentials(platform: OAuthPlatformId, e: Event) {
		e.preventDefault();
		appFormBusy = true;
		appFormError = null;
		try {
			const values: Record<string, string> = {};
			for (const name of platformSecretNames(platform)) {
				const value = (appForm[name] ?? '').trim();
				if (value) values[name] = value;
			}
			const res = await fetch(`/api/settings/platform-apps/${platform}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(values)
			});
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(payload.error || 'Could not save the credentials');
			appForm = {};
			applyCredentialStatus(payload);
			setupPanel = null;
			await connectOAuth(platform, {});
		} catch (e) {
			appFormError = humanizeError(e instanceof Error ? e.message : 'Failed');
		} finally {
			appFormBusy = false;
		}
	}

	async function removeAppCredentials(platform: OAuthPlatformId) {
		appFormBusy = true;
		appFormError = null;
		try {
			const res = await fetch(`/api/settings/platform-apps/${platform}`, { method: 'DELETE' });
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(payload.error || 'Could not remove the credentials');
			applyCredentialStatus(payload);
		} catch (e) {
			appFormError = humanizeError(e instanceof Error ? e.message : 'Failed');
		} finally {
			appFormBusy = false;
		}
	}

	function closeConnectDialog() {
		showConnectDialog = false;
		modalForm = 'none';
		setupPanel = null;
	}

	function backToPlatforms() {
		modalForm = 'none';
		setupPanel = null;
	}

	async function confirmDisconnect() {
		if (!pendingDisconnect) return;
		disconnectBusy = true;
		err = null;
		try {
			const res = await fetch(`/api/connections/${pendingDisconnect.id}`, {
				method: 'DELETE'
			});
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) {
				throw new Error(payload.error || 'Could not disconnect');
			}
			const removed = Number(payload.removed ?? 0);
			const archived = Number(payload.archived ?? 0);
			const details = [
				removed ? `${removed} scheduled post${removed === 1 ? '' : 's'} removed` : '',
				archived ? `${archived} published post${archived === 1 ? '' : 's'} kept` : ''
			].filter(Boolean);
			msg = `Disconnected ${pendingDisconnect.label}${details.length ? ` — ${details.join(' · ')}` : ''}`;
			await load();
		} catch (e) {
			err = humanizeError(e instanceof Error ? e.message : 'Could not disconnect');
		} finally {
			disconnectBusy = false;
			pendingDisconnect = null;
		}
	}

	// Re-enter the OAuth flow for a dead connection. Server callbacks upsert
	// by (user, platform, handle) and flip status back to active, so targets
	// stay attached to the same connection row. Bluesky is credential-based:
	// open its dialog prefilled instead.
	function reconnectAccount(account: Connection) {
		err = null;
		if (viaZernio(account)) {
			const profileId = account.metaJson?.zernioProfileId ?? '';
			if (account.platform === 'bluesky') {
				err = 'Reconnect Bluesky in Zernio, then press Check';
				return;
			}
			if (!isZernioPlatform(account.platform) || !profileId) {
				err = 'This account has no Zernio profile recorded — import it again';
				return;
			}
			void connectThroughZernio(account.platform, profileId);
			return;
		}
		if (account.platform === 'bluesky') {
			handle = account.handle ?? '';
			appPassword = '';
			openConnectDialog();
			modalForm = 'bluesky';
			return;
		}
		if (account.platform === 'mastodon') {
			if (!account.instanceUrl) {
				err = 'Missing instance URL — disconnect and connect again';
				return;
			}
			void connectOAuth('mastodon', { instanceUrl: account.instanceUrl });
			return;
		}
		if (
			account.platform === 'linkedin' ||
			account.platform === 'threads' ||
			account.platform === 'x'
		) {
			if (needsSetup(account.platform, configured)) {
				showSetupPanel(account.platform);
				return;
			}
			void connectOAuth(account.platform, {});
			return;
		}
		void verify(account.id);
	}

	async function verify(id: string) {
		verifying = id;
		err = null;
		try {
			const res = await fetch(`/api/connections/${id}/verify`, { method: 'POST' });
			const payload = await res.json();
			if (!res.ok) throw new Error(payload.error || 'Could not verify');
			msg = 'Account is active again';
			await load();
		} catch (e) {
			err = humanizeError(e instanceof Error ? e.message : 'Could not verify');
		} finally {
			verifying = null;
		}
	}

	onMount(() => {
		const params = page.url.searchParams;
		const connected = params.get('connected');
		const failure = params.get('error');
		if (connected) msg = `Connected ${connected}`;
		if (failure) err = humanizeError(failure);
		// Read once, then drop them from the address bar. The callback redirect
		// is a full page load, so a stale `?error=` used to be replayed on every
		// reload — an old failure sitting above a connection that has since
		// succeeded, which reads as "still broken" and cannot be dismissed.
		if (connected || failure) {
			const url = new URL(page.url);
			url.search = '';
			history.replaceState(history.state, '', url);
		}
	});
</script>

<div class="mx-auto flex w-full max-w-2xl flex-1 flex-col">
	<div class="mb-8 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
		<div>
			<p class="text-[11px] font-bold tracking-widest text-stone-500 uppercase">Integrations</p>
			<h1 class="mt-2 text-3xl font-extrabold tracking-tight text-stone-900">Connected Accounts</h1>
		</div>
		<button
			type="button"
			onclick={openConnectDialog}
			class="inline-flex items-center gap-2 rounded-full bg-stone-900 px-5 py-2.5 text-[13px] font-bold text-white shadow-md transition-all hover:bg-stone-800"
		>
			<Plus class="h-4 w-4" />
			<span>Connect new</span>
		</button>
	</div>

	{#if msg || err}
		<div
			class="mb-4 rounded-xl px-3 py-2 text-sm {err
				? 'bg-red-50 text-red-700'
				: 'bg-emerald-50 text-emerald-800'}"
			role="alert"
		>
			{err || msg}
		</div>
	{/if}

	<div
		class="overflow-hidden rounded-[2rem] border border-stone-200/80 bg-white shadow-[0_8px_30px_-12px_rgb(28_25_23/0.06)]"
	>
		{#if initialLoading && connections.length === 0}
			<div class="animate-pulse" aria-hidden="true">
				{#each [0, 1, 2] as i (i)}
					<div class="flex items-center gap-4 p-4 sm:px-6 sm:py-4">
						<div class="h-11 w-11 shrink-0 rounded-full bg-stone-100"></div>
						<div class="flex-1">
							<div class="h-4 w-32 rounded bg-stone-100"></div>
							<div class="mt-2 h-3 w-48 rounded bg-stone-100"></div>
						</div>
						<div class="h-5 w-16 rounded bg-stone-100"></div>
					</div>
				{/each}
			</div>
		{:else if loadFailed && connections.length === 0}
			<div class="flex flex-wrap items-center gap-3 p-6">
				<p class="min-w-0 flex-1 text-sm font-medium text-stone-500">
					Accounts could not be loaded. The message above says why — retry in a moment.
				</p>
				<button
					type="button"
					onclick={() => void load()}
					class="rounded-full border border-stone-300 bg-white px-4 py-1.5 text-[12px] font-bold text-stone-900 transition-colors hover:bg-stone-100"
				>
					Retry
				</button>
			</div>
		{:else if connections.length === 0}
			<p class="p-6 text-sm font-medium text-stone-500">{emptyStateSentence(configured)}</p>
		{:else}
			{#each connections as account, index (account.id)}
				{@const needsReconnect = account.status !== 'active'}
				<div
					class="group flex flex-col justify-between gap-4 p-4 transition-colors hover:bg-stone-50/50 sm:flex-row sm:items-center sm:px-6 sm:py-4 {index !==
					connections.length - 1
						? 'border-b border-stone-100'
						: ''}"
				>
					<div class="flex items-center gap-4">
						<AccountAvatar
							platform={account.platform}
							handle={account.handle}
							displayName={account.displayName}
							avatarUrl={account.avatarUrl}
							size={44}
							title={accountLabel(account.displayName, account.handle, account.instanceUrl) ||
								undefined}
						/>
						<div>
							<h3 class="text-[15px] leading-tight font-extrabold tracking-tight text-stone-900">
								{platformName(account.platform)}
								{#if viaZernio(account)}
									<span
										class="ml-1 rounded bg-stone-100 px-1.5 py-0.5 align-middle text-[10px] font-bold tracking-widest text-stone-500 uppercase"
										>via Zernio</span
									>
								{/if}
							</h3>
							<p
								class="mt-0.5 text-[13px] font-medium text-stone-500"
								title={accountLabel(account.displayName, account.handle, account.instanceUrl) ||
									undefined}
							>
								{#if account.platform === 'linkedin' && account.displayName}
									{account.displayName}
								{:else}
									{accountLabel(account.displayName, account.handle)}
								{/if}
								{account.instanceUrl ? ` · ${displayHost(account.instanceUrl)}` : ''}
							</p>
						</div>
					</div>
					<div class="mt-2 flex items-center justify-between gap-3 sm:mt-0 sm:justify-end">
						{#if needsReconnect}
							<span
								class="rounded bg-amber-50 px-2 py-0.5 text-[10px] font-bold tracking-widest text-amber-700 uppercase"
							>
								{account.status}
							</span>
							<button
								type="button"
								onclick={() => reconnectAccount(account)}
								disabled={verifying === account.id || loading}
								class="text-xs font-bold text-stone-900 underline">Reconnect</button
							>
							<button
								type="button"
								onclick={() => verify(account.id)}
								disabled={verifying === account.id}
								class="text-xs font-bold text-stone-500 underline"
								>{verifying === account.id ? 'Checking…' : 'Check'}</button
							>
						{:else}
							<span
								class="rounded bg-emerald-50 px-2 py-0.5 text-[10px] font-bold tracking-widest text-emerald-700 uppercase shadow-sm"
							>
								Connected
							</span>
						{/if}
						<button
							type="button"
							onclick={() =>
								(pendingDisconnect = {
									id: account.id,
									label:
										accountLabel(account.displayName, account.handle, account.instanceUrl) ||
										account.platform
								})}
							class="flex h-8 w-8 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-red-50 hover:text-red-600"
							aria-label={`Disconnect ${accountLabel(account.displayName, account.handle, account.instanceUrl) || platformName(account.platform)}`}
							title={`Disconnect ${accountLabel(account.displayName, account.handle, account.instanceUrl) || platformName(account.platform)}`}
						>
							<X class="h-4 w-4" />
						</button>
					</div>
				</div>
			{/each}
		{/if}
	</div>
</div>

{#if showConnectDialog}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
		transition:fade={{ duration: 150 }}
		role="presentation"
	>
		<div
			class="absolute inset-0 bg-stone-900/20 backdrop-blur-sm"
			onclick={closeConnectDialog}
			aria-hidden="true"
		></div>

		<div
			role="dialog"
			aria-modal="true"
			aria-labelledby="connect-dialog-title"
			class="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-[2rem] border border-stone-200/80 bg-white p-6 shadow-[0_16px_40px_-12px_rgb(28_25_23/0.15)] sm:p-8"
			transition:fly={{ y: 20, duration: 250, opacity: 0 }}
			use:dialogFocus={{
				onEscape: () => {
					if (!loading) closeConnectDialog();
				}
			}}
		>
			<div class="mb-8 flex items-start justify-between">
				<div>
					<h2
						id="connect-dialog-title"
						class="text-2xl font-extrabold tracking-tight text-stone-900"
					>
						Add Integration
					</h2>
					<p class="mt-1.5 text-[13px] font-medium text-stone-500">
						Select a platform to connect to your workspace.
					</p>
				</div>
				<button
					type="button"
					bind:this={connectCloseBtn}
					onclick={closeConnectDialog}
					class="ml-4 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-stone-50 text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-900"
					aria-label="Close add integration dialog"
				>
					<X class="h-5 w-5" />
				</button>
			</div>

			{#if setupPanel}
				{#key setupPanel}
					{@const setup = PLATFORM_SETUP[setupPanel]}
					{@const secretNames = platformSecretNames(setupPanel)}
					{@const missing = missingSecrets(setupPanel, secretPresence)}
					{@const alreadySet = secretNames.filter((name) => secretPresence[name])}
					{@const redirectUri = callbackUri(setupPanel, appUrl || page.url.origin)}
					{@const command = secretsPutCommandFor(missing)}
					{@const savedHere = credentialSources[setupPanel] === 'app'}
					{@const agentPrompt = buildAgentPrompt(
						setupPanel,
						appUrl || page.url.origin,
						page.data.appName ?? 'CogSend'
					)}
					<div class="space-y-4" data-testid="platform-setup-panel">
						<button
							type="button"
							onclick={backToPlatforms}
							class="text-[13px] font-bold text-stone-500 hover:text-stone-900"
							>← All platforms</button
						>
						<h3 class="text-[17px] font-extrabold tracking-tight text-stone-900">
							{savedHere
								? `${platformName(setupPanel)} app credentials`
								: `${platformName(setupPanel)} isn't enabled yet`}
						</h3>
						<p class="text-xs font-medium text-stone-500">
							{#if savedHere}
								Saved on this instance{savedClientIds[setupPanel]
									? ` (client ID ending ${savedClientIds[setupPanel]})`
									: ''}. Enter new ones to replace them, or remove them.
							{:else}
								{platformName(setupPanel)} needs an app of your own. Create it, then enter its credentials
								here.
							{/if}
						</p>
						<div
							class="divide-y divide-stone-200/80 overflow-hidden rounded-xl border border-stone-200/80"
						>
							<details class="group">
								<summary
									data-testid="setup-step-1"
									class="flex cursor-pointer list-none items-center gap-2.5 p-3 text-xs font-bold text-stone-900 hover:bg-stone-50 [&::-webkit-details-marker]:hidden"
								>
									<span
										class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-stone-900 text-[10px] text-white"
										>1</span
									>
									Create the app
									<ChevronDown
										class="ml-auto h-4 w-4 shrink-0 text-stone-400 transition-transform group-open:rotate-180"
									/>
								</summary>
								<div class="space-y-2 px-3 pb-3 text-xs font-medium text-stone-600">
									<p>
										In the <a
											href={setup.consoleUrl}
											target="_blank"
											rel="noreferrer"
											class="font-bold text-stone-900 underline">{setup.consoleName}</a
										>. {setup.consoleRequirement}
									</p>
									<p>Register this redirect URI in {setup.redirectField}:</p>
									<div
										class="flex items-center gap-1 rounded-xl border border-stone-200/80 bg-stone-50 py-1 pr-1 pl-3"
									>
										<code
											class="min-w-0 flex-1 overflow-x-auto font-mono text-[11px] whitespace-nowrap text-stone-900 select-all"
											data-testid="setup-callback-uri">{redirectUri}</code
										>
										<CopyButton value={redirectUri} ariaLabel="Copy the redirect URI" />
									</div>
									<p class="pt-1">
										Or let a browser agent such as Claude in Chrome do it: copy this prompt and
										paste it into the agent. It stops whenever a step needs you.
									</p>
									<div
										class="flex items-center gap-1 rounded-xl border border-stone-200/80 bg-stone-50 py-1 pr-1 pl-3"
									>
										<span class="min-w-0 flex-1 truncate text-[11px] font-bold text-stone-900"
											>Agent prompt for {platformName(setupPanel)}</span
										>
										<CopyButton value={agentPrompt} ariaLabel="Copy the agent prompt" />
									</div>
								</div>
							</details>
							<details class="group" open={savedHere}>
								<summary
									data-testid="setup-step-2"
									class="flex cursor-pointer list-none items-center gap-2.5 p-3 text-xs font-bold text-stone-900 hover:bg-stone-50 [&::-webkit-details-marker]:hidden"
								>
									<span
										class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-stone-900 text-[10px] text-white"
										>2</span
									>
									Enter the app's credentials
									<ChevronDown
										class="ml-auto h-4 w-4 shrink-0 text-stone-400 transition-transform group-open:rotate-180"
									/>
								</summary>
								<form
									class="space-y-2 px-3 pb-3"
									data-testid="setup-app-form"
									onsubmit={(e) => saveAppCredentials(setupPanel!, e)}
								>
									{#each secretNames as secret (secret)}
										{@const optional = setup.optionalSecrets?.includes(secret)}
										<label class="block">
											<span class="text-[11px] font-bold text-stone-600"
												>{secretLabel(secret)}{optional ? ' (optional)' : ''}</span
											>
											<input
												type={secret.endsWith('_ID') ? 'text' : 'password'}
												autocomplete="off"
												spellcheck="false"
												required={!optional}
												bind:value={appForm[secret]}
												class="mt-1 w-full rounded-xl border border-stone-200/80 bg-stone-50 px-3 py-2 font-mono text-xs text-stone-900 focus:border-stone-400 focus:bg-white focus:outline-none pointer-coarse:text-base"
											/>
										</label>
									{/each}
									<p class="text-[11px] font-medium text-stone-500">
										Stored encrypted on this instance, and never shown again.
									</p>
									{#if appFormError}
										<p class="text-xs font-bold text-red-600" role="alert">{appFormError}</p>
									{/if}
									<div class="flex items-center gap-3">
										<button
											type="submit"
											disabled={appFormBusy}
											class="rounded-full bg-stone-900 px-4 py-2 text-xs font-bold text-white hover:bg-stone-800 disabled:opacity-50"
											>{appFormBusy ? 'Saving…' : 'Save and connect'}</button
										>
										{#if savedHere}
											<button
												type="button"
												disabled={appFormBusy}
												onclick={() => removeAppCredentials(setupPanel!)}
												class="text-xs font-bold text-stone-500 underline-offset-2 hover:text-red-700 hover:underline"
												>Remove</button
											>
										{/if}
									</div>
								</form>
							</details>
							<details class="group">
								<summary
									data-testid="setup-step-3"
									class="flex cursor-pointer list-none items-center gap-2.5 p-3 text-xs font-bold text-stone-900 hover:bg-stone-50 [&::-webkit-details-marker]:hidden"
								>
									<span
										class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-stone-900 text-[10px] text-white"
										>3</span
									>
									Or set them as Worker secrets
									<ChevronDown
										class="ml-auto h-4 w-4 shrink-0 text-stone-400 transition-transform group-open:rotate-180"
									/>
								</summary>
								<div class="space-y-2 px-3 pb-3 text-xs font-medium text-stone-600">
									<p>
										Put {#each missing as secret, index (secret)}{index > 0 ? ' and ' : ''}<code
												class="font-mono text-[11px] text-stone-900">{secret}</code
											>{/each} in
										<code class="font-mono text-[11px] text-stone-900">.dev.vars</code> — uncomment the
										line if it is already there, otherwise add it — then run
									</p>
									{#if alreadySet.length}
										<p>
											Already set on the Worker:
											{#each alreadySet as secret, index (secret)}{index > 0 ? ', ' : ''}<code
													class="font-mono text-[11px] text-stone-900">{secret}</code
												>{/each}.
										</p>
									{/if}
									<div
										class="flex items-center gap-1 rounded-xl border border-stone-200/80 bg-stone-50 py-1 pr-1 pl-3"
									>
										<code
											class="min-w-0 flex-1 overflow-x-auto font-mono text-[11px] whitespace-nowrap text-stone-900 select-all"
											data-testid="setup-command">{command}</code
										>
										<CopyButton value={command} ariaLabel="Copy the secrets command" />
									</div>
									<p class="text-[11px] text-stone-500">
										No checkout on this machine? Add them in the Cloudflare dashboard instead:
										Workers → your Worker → Settings → Variables and Secrets, then press Deploy.
									</p>
									<p class="text-[11px] text-stone-500">
										Then reload this page: secrets go live as soon as the command finishes, with no
										redeploy step. Worker secrets take precedence over credentials entered above.
									</p>
								</div>
							</details>
						</div>
						{#if setup.note}
							<p class="text-xs font-medium text-stone-500">{setup.note}</p>
						{/if}
						<a
							href={setupGuideUrl(setupPanel)}
							target="_blank"
							rel="noreferrer"
							class="inline-block text-[13px] font-bold text-stone-900 underline"
							>Full {platformName(setupPanel)} steps</a
						>
						<p
							class="rounded-xl border border-dashed border-stone-300 px-3 py-2.5 text-xs font-medium text-stone-600"
							data-testid="setup-zernio-callout"
						>
							Don't want to set up an app?
							<button
								type="button"
								onclick={() => openZernioForm(setupPanel ?? undefined)}
								class="font-bold text-stone-900 underline"
								>Connect {platformName(setupPanel)} through Zernio</button
							>
							instead.{setupPanel === 'x' ? '' : ' Free plan available.'}
						</p>
					</div>
				{/key}
			{:else if modalForm === 'none'}
				<div class="grid gap-3">
					{#each availablePlatforms as platform (platform.id)}
						<button
							type="button"
							class="group flex items-center justify-between rounded-[1.5rem] border border-stone-200/80 bg-white p-4 text-left shadow-sm transition-all hover:border-stone-300 hover:shadow-md"
							onclick={() => pickPlatform(platform.id)}
						>
							<div class="flex items-center gap-4">
								<span
									class="flex h-12 w-12 items-center justify-center rounded-[1rem] bg-stone-100 font-bold text-stone-600 shadow-sm transition-colors group-hover:bg-stone-200/50 group-hover:text-stone-900"
								>
									{#if platform.id === 'zernio'}
										<Plug class="h-5 w-5" />
									{:else}
										<SocialIcon platform={platform.id} className="h-5 w-5" />
									{/if}
								</span>
								<div>
									<h3 class="text-[15px] font-extrabold tracking-tight text-stone-900">
										{platform.name}
									</h3>
									<p class="mt-0.5 text-[13px] font-medium text-stone-500">
										{platform.description}
									</p>
								</div>
							</div>
							{#if needsSetup(platform.id, configured)}
								<span
									class="shrink-0 rounded-full border border-stone-200 bg-stone-50 px-3 py-1 text-[11px] font-bold tracking-tight text-stone-500"
									data-testid="needs-setup-{platform.id}">Needs setup</span
								>
							{:else}
								<div
									class="flex h-8 w-8 items-center justify-center rounded-full border border-stone-200 bg-stone-50 text-stone-500 transition-all group-hover:border-stone-900 group-hover:bg-stone-900 group-hover:text-white"
								>
									<Plus class="h-4 w-4" />
								</div>
							{/if}
						</button>
					{/each}
				</div>
				{#if (Object.keys(credentialSources) as OAuthPlatformId[]).some((id) => credentialSources[id] === 'app')}
					<p class="mt-3 text-xs font-medium text-stone-500" data-testid="saved-app-credentials">
						App credentials saved here:
						{#each (Object.keys(credentialSources) as OAuthPlatformId[]).filter((id) => credentialSources[id] === 'app') as id, index (id)}{index >
							0
								? ', '
								: ' '}<button
								type="button"
								onclick={() => showSetupPanel(id)}
								class="font-bold text-stone-900 underline">{platformName(id)}</button
							>{/each}
					</p>
				{/if}
				<div class="my-5 flex items-center gap-3" aria-hidden="true">
					<span class="h-px flex-1 bg-stone-200"></span>
					<span class="text-[11px] font-bold tracking-widest text-stone-400 uppercase">or</span>
					<span class="h-px flex-1 bg-stone-200"></span>
				</div>
				<button
					type="button"
					class="group flex w-full items-center justify-between gap-3 rounded-[1.5rem] border border-dashed border-stone-300 bg-stone-50/60 p-4 text-left transition-all hover:border-stone-400 hover:bg-white"
					onclick={() => openZernioForm()}
					data-testid="zernio-card"
				>
					<div class="flex items-center gap-4">
						<span
							class="flex h-12 w-12 items-center justify-center rounded-[1rem] bg-white text-stone-600 shadow-sm transition-colors group-hover:text-stone-900"
						>
							<Plug class="h-5 w-5" />
						</span>
						<div>
							<h3 class="text-[15px] font-extrabold tracking-tight text-stone-900">
								Connect through Zernio
							</h3>
							<p class="mt-0.5 text-[13px] font-medium text-stone-500">No developer apps needed</p>
						</div>
					</div>
					<span
						class="shrink-0 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[11px] font-bold tracking-tight text-emerald-700"
						>Free plan</span
					>
				</button>
			{:else if modalForm === 'bluesky'}
				<form onsubmit={connectBluesky} class="space-y-3">
					<button
						type="button"
						onclick={backToPlatforms}
						class="text-[13px] font-bold text-stone-500 hover:text-stone-900"
						>← All platforms</button
					>
					<h3 class="text-[17px] font-extrabold tracking-tight text-stone-900">Bluesky</h3>
					<ol class="list-decimal space-y-1 pl-4 text-xs font-medium text-stone-500">
						<li>
							Open
							<a
								href="https://bsky.app/settings/app-passwords"
								target="_blank"
								rel="noreferrer"
								class="underline">bsky.app → Settings → App passwords</a
							>
						</li>
						<li>Create an app password. Never use your main password.</li>
						<li>Paste handle + the xxxx-xxxx-xxxx-xxxx code below.</li>
					</ol>
					<input
						type="text"
						placeholder="handle.bsky.social"
						aria-label="Bluesky handle"
						bind:value={handle}
						class="w-full rounded-xl border border-stone-200/80 bg-stone-50 px-3 py-2.5 text-sm font-bold text-stone-900 focus:border-stone-400 focus:bg-white focus:outline-none pointer-coarse:text-base"
						required
					/>
					<input
						type="password"
						placeholder="App password (xxxx-xxxx-xxxx-xxxx)"
						aria-label="Bluesky app password"
						bind:value={appPassword}
						class="w-full rounded-xl border border-stone-200/80 bg-stone-50 px-3 py-2.5 text-sm font-bold text-stone-900 focus:border-stone-400 focus:bg-white focus:outline-none pointer-coarse:text-base"
						required
						autocomplete="off"
					/>
					{#if err}
						<p class="text-sm text-red-600">{err}</p>
					{/if}
					<button
						type="submit"
						disabled={loading}
						class="w-full rounded-full bg-stone-900 py-2.5 text-[13px] font-bold text-white transition-all hover:bg-stone-800 disabled:opacity-50"
						>{loading ? 'Connecting…' : 'Connect Bluesky'}</button
					>
				</form>
			{:else if modalForm === 'zernio'}
				<div class="space-y-4">
					<button
						type="button"
						onclick={backToPlatforms}
						class="text-[13px] font-bold text-stone-500 hover:text-stone-900"
						>← All platforms</button
					>
					<h3 class="text-[17px] font-extrabold tracking-tight text-stone-900">Zernio</h3>
					<p class="text-xs font-medium text-stone-500">
						Zernio publishes with its own approved apps, so X, Threads, LinkedIn and Bluesky connect
						without a developer app of your own. It has a free plan (X needs a card), and posts
						still live and schedule here.
						<a
							href={zernioLink({ placement: 'accounts-dialog' })}
							target="_blank"
							rel="noreferrer"
							class="underline">About Zernio</a
						>
					</p>
					<form onsubmit={loadZernioAccounts} class="space-y-3">
						<input
							type="password"
							placeholder={zernioHasStoredKey
								? 'API key (saved — leave blank to reuse)'
								: 'Zernio API key'}
							aria-label="Zernio API key"
							bind:value={zernioApiKey}
							class="w-full rounded-xl border border-stone-200/80 bg-stone-50 px-3 py-2.5 text-sm font-bold text-stone-900 focus:border-stone-400 focus:bg-white focus:outline-none pointer-coarse:text-base"
							required={!zernioHasStoredKey}
							autocomplete="off"
						/>
						<p class="text-[11px] font-medium text-stone-500">
							Create one at <a
								href={ZERNIO_API_KEYS_URL}
								target="_blank"
								rel="noreferrer"
								class="underline">zernio.com → API keys</a
							>. It needs the publishing and accounts groups; a read-only key cannot post.
						</p>
						{#if zernioAccounts === null}
							<button
								type="submit"
								disabled={loading}
								class="w-full rounded-full bg-stone-900 py-2.5 text-[13px] font-bold text-white transition-all hover:bg-stone-800 disabled:opacity-50"
								>{loading ? 'Loading…' : 'Show my Zernio accounts'}</button
							>
						{/if}
					</form>
					{#if zernioAccounts !== null}
						{#if zernioAccounts.length === 0}
							<p class="text-xs font-medium text-stone-500">
								No X, Threads, LinkedIn or Bluesky accounts on this key yet. Connect one below.
							</p>
						{:else}
							<ul
								class="divide-y divide-stone-200/80 overflow-hidden rounded-xl border border-stone-200/80"
							>
								{#each zernioAccounts as account (account.id)}
									<li class="flex items-center gap-3 p-3 text-sm">
										<input
											type="checkbox"
											id={`zernio-${account.id}`}
											checked={account.imported || zernioSelected.includes(account.id)}
											disabled={account.imported}
											onchange={() => toggleZernioAccount(account.id)}
											class="h-4 w-4"
										/>
										<label for={`zernio-${account.id}`} class="min-w-0 flex-1 cursor-pointer">
											<span class="font-bold text-stone-900">{platformName(account.platform)}</span>
											<span class="ml-2 text-stone-500"
												>{accountLabel(account.displayName, account.handle)}</span
											>
										</label>
										{#if account.imported}
											<span class="text-[10px] font-bold tracking-widest text-emerald-700 uppercase"
												>Imported</span
											>
										{:else if account.needsReconnection}
											<span class="text-[10px] font-bold tracking-widest text-amber-700 uppercase"
												>Needs reconnect</span
											>
										{/if}
									</li>
								{/each}
							</ul>
							<button
								type="button"
								onclick={importZernioAccounts}
								disabled={loading || zernioSelected.length === 0}
								class="w-full rounded-full bg-stone-900 py-2.5 text-[13px] font-bold text-white transition-all hover:bg-stone-800 disabled:opacity-50"
								>{loading
									? 'Importing…'
									: `Import ${zernioSelected.length} account${zernioSelected.length === 1 ? '' : 's'}`}</button
							>
						{/if}
						<div class="space-y-2 rounded-xl border border-stone-200/80 bg-stone-50 p-3">
							<p class="text-xs font-bold text-stone-900">Connect a new account through Zernio</p>
							<div class="flex flex-wrap gap-2">
								<select
									aria-label="Platform"
									bind:value={zernioConnectPlatform}
									class="rounded-lg border border-stone-200/80 bg-white px-2 py-1.5 text-xs font-bold text-stone-900 pointer-coarse:text-base"
								>
									{#each ZERNIO_PLATFORMS as id (id)}
										<option value={id}>{platformName(id)}</option>
									{/each}
								</select>
								<select
									aria-label="Zernio profile"
									bind:value={zernioConnectProfile}
									class="rounded-lg border border-stone-200/80 bg-white px-2 py-1.5 text-xs font-bold text-stone-900 pointer-coarse:text-base"
								>
									{#each zernioProfiles as profile (profile.id)}
										<option value={profile.id}>{profile.name}</option>
									{/each}
								</select>
								<button
									type="button"
									disabled={loading || !zernioConnectProfile}
									onclick={() => connectThroughZernio(zernioConnectPlatform, zernioConnectProfile)}
									class="rounded-full border border-stone-300 bg-white px-4 py-1.5 text-[12px] font-bold text-stone-900 transition-colors hover:bg-stone-100 disabled:opacity-50"
									>{loading ? 'Redirecting…' : 'Connect'}</button
								>
							</div>
							<p class="text-[11px] font-medium text-stone-500">
								You authorize on the platform, come back here, and the account is imported.
							</p>
						</div>
					{/if}
					{#if err}
						<p class="text-sm text-red-600">{err}</p>
					{/if}
				</div>
			{:else}
				<form onsubmit={connectMastodon} class="space-y-3">
					<button
						type="button"
						onclick={backToPlatforms}
						class="text-[13px] font-bold text-stone-500 hover:text-stone-900"
						>← All platforms</button
					>
					<h3 class="text-[17px] font-extrabold tracking-tight text-stone-900">Mastodon</h3>
					<p class="text-xs font-medium text-stone-500">
						Enter your instance (mastodon.social, hachyderm.io, …). You'll authorize on that site.
					</p>
					<input
						type="text"
						placeholder="https://mastodon.social"
						aria-label="Mastodon instance URL"
						bind:value={instanceUrl}
						class="w-full rounded-xl border border-stone-200/80 bg-stone-50 px-3 py-2.5 text-sm font-bold text-stone-900 focus:border-stone-400 focus:bg-white focus:outline-none pointer-coarse:text-base"
						required
					/>
					{#if err}
						<p class="text-sm text-red-600">{err}</p>
					{/if}
					<button
						type="submit"
						disabled={loading}
						class="w-full rounded-full bg-stone-900 py-2.5 text-[13px] font-bold text-white transition-all hover:bg-stone-800 disabled:opacity-50"
						>{loading ? 'Redirecting…' : 'Connect Mastodon'}</button
					>
				</form>
			{/if}
		</div>
	</div>
{/if}

<ConfirmDialog
	open={pendingDisconnect !== null}
	idPrefix="disconnect-dialog"
	title={`Disconnect ${pendingDisconnect?.label ?? 'account'}?`}
	body="Scheduled posts are removed — any drafts still waiting come back to your Drafts tab. Published history stays in Posts, and reconnecting restores the same account."
	confirmLabel="Disconnect"
	busy={disconnectBusy}
	onConfirm={() => void confirmDisconnect()}
	onCancel={() => (pendingDisconnect = null)}
/>

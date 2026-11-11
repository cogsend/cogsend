<script lang="ts">
	import { onMount } from 'svelte';
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import { docsLinks } from '#lib/domain/docs-links.js';
	import { humanizeError } from '#lib/domain/human-error.js';
	import { timeAgo } from '#lib/domain/relative-time.js';
	import SettingsCard from './SettingsCard.svelte';
	import { settingsGet, useSettingsNotice } from './settings-notice.svelte.js';

	const notice = useSettingsNotice();
	type KeyMeta = {
		prefix: string;
		createdAt: string;
		lastUsedAt: string | null;
		scopes?: string[] | null;
	};
	let keyActive = $state<KeyMeta | null>(null);
	let keyScopes = $state<'read' | 'read-write'>('read-write');
	let keyLoading = $state(true);
	// The stored key status actually arrived: without it a failed fetch would
	// render "No active key" and invite a rotation that was never needed.
	let keyLoaded = $state(false);
	let keyBusy = $state(false);
	let keyRevealed = $state<string | null>(null);
	let keyCopied = $state(false);
	let keyConfirm: 'rotate' | 'revoke' | null = $state(null);
	let keyJustRotated = $state(false);
	let loadGen = 0;

	async function load() {
		const gen = ++loadGen;
		if (!keyLoaded) keyLoading = true;
		try {
			const res = await settingsGet('/api/key', notice);
			if (gen !== loadGen || !res?.ok) return;
			const k = await res.json();
			if (gen !== loadGen) return;
			keyActive = k.active;
			keyLoaded = true;
		} finally {
			if (gen === loadGen) keyLoading = false;
		}
	}

	async function rotateKey() {
		keyBusy = true;
		notice.clearError();
		try {
			const res = await fetch('/api/key', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ scopes: keyScopes === 'read' ? ['read'] : ['read', 'write'] })
			});
			const payload = await res.json();
			if (!res.ok) throw new Error(payload.error || 'Could not create key');
			// The raw key exists only in this response — show it once.
			keyRevealed = payload.key;
			keyCopied = false;
			keyJustRotated = Boolean(keyActive);
			keyConfirm = null;
			await load();
		} catch (e) {
			notice.fail(humanizeError(e instanceof Error ? e.message : 'Could not create key'));
		} finally {
			keyBusy = false;
		}
	}

	async function revokeKey() {
		keyBusy = true;
		notice.clearError();
		try {
			const res = await fetch('/api/key', { method: 'DELETE' });
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(payload.error || 'Could not revoke key');
			keyConfirm = null;
			keyRevealed = null;
			notice.ok('API key revoked');
			await load();
		} catch (e) {
			notice.fail(humanizeError(e instanceof Error ? e.message : 'Could not revoke key'));
		} finally {
			keyBusy = false;
		}
	}

	async function copyKey() {
		if (!keyRevealed) return;
		try {
			await navigator.clipboard.writeText(keyRevealed);
			keyCopied = true;
		} catch {
			notice.fail('Copy failed — select the key manually');
		}
	}

	function dismissRevealed() {
		// Deliberately one-way: once dismissed the raw key is unrecoverable.
		keyRevealed = null;
		keyCopied = false;
		keyJustRotated = false;
	}

	onMount(() => {
		void load();
	});
</script>

{#snippet intro()}
	Use this personal API key for scripts, Shortcuts, and cron jobs. Choose whether it can only read
	or also change and publish drafts. For security, it cannot manage social accounts, change
	credentials, or generate new API keys. See the
	<a
		href={docsLinks.api}
		target="_blank"
		rel="noopener"
		class="font-bold text-stone-900 underline underline-offset-2 hover:text-stone-700"
		>API reference</a
	> for full details.
{/snippet}

<SettingsCard title="API key" description={intro} label="API key" testid="api-key-section">
	<fieldset class="mb-5 space-y-2" data-testid="api-key-scopes">
		<legend class="mb-2 text-[12px] font-bold text-stone-700">New key permissions</legend>
		<label class="flex cursor-pointer items-start gap-2 text-[13px] text-stone-700">
			<input type="radio" name="api-key-scopes" value="read" bind:group={keyScopes} />
			<span><strong>Read-only</strong> — view connections, drafts, and queue.</span>
		</label>
		<label class="flex cursor-pointer items-start gap-2 text-[13px] text-stone-700">
			<input type="radio" name="api-key-scopes" value="read-write" bind:group={keyScopes} />
			<span
				><strong>Read + write</strong> — manage drafts and publish; includes read. (Default)</span
			>
		</label>
	</fieldset>
	{#if keyLoading}
		<p class="text-sm font-medium text-stone-500">Loading…</p>
	{:else if keyRevealed}
		<div class="space-y-4" data-testid="api-key-reveal">
			<div class="rounded-xl border border-amber-200/50 bg-amber-50/50 p-4">
				<p class="text-[13px] font-bold text-amber-900">
					{#if keyJustRotated}New key — the old one stopped working.{:else}New key generated.{/if}
				</p>
				<p class="mt-1 text-[13px] font-medium text-amber-700">
					Copy it now: it is never shown again.
				</p>
			</div>
			<code
				class="block rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-3 font-mono text-[13px] break-all text-stone-900 shadow-sm select-all"
				data-testid="api-key-value">{keyRevealed}</code
			>
			<div class="flex flex-wrap items-center gap-2 pt-2">
				<button
					type="button"
					onclick={copyKey}
					class="rounded-full bg-stone-900 px-6 py-2.5 text-[13px] font-bold text-white shadow-md transition-all hover:bg-stone-800"
				>
					{keyCopied ? 'Copied' : 'Copy key'}
				</button>
				<button
					type="button"
					onclick={dismissRevealed}
					class="rounded-full bg-stone-100 px-6 py-2.5 text-[13px] font-bold text-stone-700 transition-all hover:bg-stone-200"
				>
					I have saved it
				</button>
			</div>
		</div>
	{:else if keyActive}
		<div
			class="mb-5 flex flex-col justify-between gap-4 rounded-xl border border-stone-200/80 bg-stone-50/50 p-4 sm:flex-row sm:items-center"
			data-testid="api-key-status"
		>
			<div>
				<p class="flex items-center gap-2 text-[13px] font-extrabold text-stone-900">
					Active key
					<code
						class="rounded bg-emerald-100/50 px-1.5 py-0.5 font-mono text-[12px] text-emerald-700"
					>
						{keyActive.prefix}…
					</code>
				</p>
				<p class="mt-1 text-[11px] font-medium text-stone-500">
					Created {timeAgo(keyActive.createdAt)} · Last used {timeAgo(keyActive.lastUsedAt)}
				</p>
				<p class="mt-1 text-[11px] font-medium text-stone-500">
					Scope: {(keyActive.scopes ?? ['read', 'write']).includes('write')
						? 'Read + write'
						: 'Read-only'}
				</p>
			</div>
		</div>
		<div class="flex flex-wrap gap-2">
			<button
				type="button"
				onclick={() => (keyConfirm = 'rotate')}
				disabled={keyBusy}
				class="rounded-full bg-stone-100 px-6 py-2.5 text-[13px] font-bold text-stone-700 transition-all hover:bg-stone-200 disabled:opacity-50"
			>
				Generate replacement
			</button>
			<button
				type="button"
				onclick={() => (keyConfirm = 'revoke')}
				disabled={keyBusy}
				class="rounded-full bg-red-50 px-6 py-2.5 text-[13px] font-bold text-red-600 transition-all hover:bg-red-100 disabled:opacity-50"
			>
				Revoke
			</button>
		</div>
	{:else if !keyLoaded}
		<div class="mb-5 rounded-xl border border-stone-200/80 bg-stone-50/50 p-4">
			<p class="text-[13px] font-medium text-stone-500">Could not load your API key status.</p>
		</div>
		<button
			type="button"
			onclick={() => void load()}
			class="rounded-full border border-stone-300 px-6 py-2.5 text-[13px] font-bold text-stone-700 transition-colors hover:bg-stone-100"
			>Retry</button
		>
	{:else}
		<div
			class="mb-5 rounded-xl border border-stone-200/80 bg-stone-50/50 p-4"
			data-testid="api-key-status"
		>
			<p class="text-[13px] font-medium text-stone-500">
				No active key. Generate one to call the API without logging in.
			</p>
		</div>
		<button
			type="button"
			onclick={() => (keyConfirm = 'rotate')}
			disabled={keyBusy}
			class="rounded-full bg-stone-900 px-6 py-2.5 text-[13px] font-bold text-white shadow-md transition-all hover:bg-stone-800 disabled:opacity-50"
		>
			Generate API key
		</button>
	{/if}
</SettingsCard>

<ConfirmDialog
	open={keyConfirm !== null}
	idPrefix="api-key-dialog"
	title={keyConfirm === 'revoke' ? 'Revoke API key?' : 'Generate API key?'}
	body={keyConfirm === 'revoke'
		? 'Scripts and automations using the current key stop working immediately.'
		: keyActive
			? 'Generating a replacement revokes the previous key immediately. The new key is shown once.'
			: 'The new key is shown once. Copy it before closing.'}
	confirmLabel={keyConfirm === 'revoke' ? 'Revoke' : 'Generate'}
	cancelLabel="Keep"
	tone={keyConfirm === 'revoke' ? 'danger' : 'primary'}
	busy={keyBusy}
	onConfirm={() => void (keyConfirm === 'revoke' ? revokeKey() : rotateKey())}
	onCancel={() => (keyConfirm = null)}
/>

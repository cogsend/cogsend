<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import { humanizeError } from '#lib/domain/human-error.js';
	import { timeAgo } from '#lib/domain/relative-time.js';
	import { tickAdvice, type TickAdvice } from '#lib/domain/scheduler-status.js';
	import SettingsCard from './SettingsCard.svelte';
	import { settingsGet, useSettingsNotice } from './settings-notice.svelte.js';

	const notice = useSettingsNotice();
	// What the last deploy did with the cron trigger, when the scheduler last
	// ticked, and the token an external cron can use.
	type TickHealth = {
		ok: boolean;
		lastTickAt: string | null;
		neverTicked: boolean;
		overdue: number;
		stuckPublishing: number;
		deployCron: { status: 'attached' | 'disabled' | 'unavailable'; code: string | null } | null;
	};
	let tickHealth = $state<TickHealth | null>(null);
	let schedulerMessage = $state<string | null>(null);
	type TickTokenMeta = { configured: boolean; prefix: string | null; createdAt: string | null };
	let tickToken = $state<TickTokenMeta | null>(null);
	let tickTokenRevealed = $state<string | null>(null);
	let tickTokenCopied = $state(false);
	let tickTokenBusy = $state(false);
	let tickConfirm: 'rotate' | 'revoke' | null = $state(null);
	let tickTestBusy = $state(false);
	let tickTestMessage = $state<string | null>(null);
	let loadGen = 0;
	// Rendered with the address the Worker saw, then the browser's own: behind a
	// proxy the two can differ, and a client has to call the one in the browser.
	let origin = $state(page.url.origin);
	const tickUrl = $derived(`${origin}/api/internal/tick`);
	const tickStatusLine = $derived.by(() => {
		const h = tickHealth;
		if (!h) return 'Checking…';
		if (h.stuckPublishing) {
			return `${h.stuckPublishing} post${h.stuckPublishing === 1 ? '' : 's'} stuck publishing`;
		}
		const detail = h.overdue > 0 ? ` · ${h.overdue} post${h.overdue === 1 ? '' : 's'} due now` : '';
		if (!h.lastTickAt) return `No tick yet${detail}`;
		return `Last tick ${timeAgo(h.lastTickAt)}${detail}`;
	});
	const tickState = $derived<TickAdvice>(
		tickAdvice(
			{
				ok: tickHealth?.ok ?? false,
				lastTickAt: tickHealth?.lastTickAt ? new Date(tickHealth.lastTickAt) : null,
				stuckPublishing: tickHealth?.stuckPublishing ?? 0
			},
			tickHealth?.deployCron ? { ...tickHealth.deployCron, updatedAt: null } : null
		)
	);

	async function load() {
		const gen = ++loadGen;
		const [health, token] = await Promise.all([
			settingsGet('/api/scheduler/health', notice),
			settingsGet('/api/scheduler/tick-token', notice)
		]);
		if (gen !== loadGen) return;
		if (health?.ok) {
			const h = await health.json();
			if (gen !== loadGen) return;
			schedulerMessage = h.message ?? null;
			tickHealth = {
				ok: Boolean(h.ok),
				lastTickAt: h.lastTickAt ?? null,
				neverTicked: Boolean(h.neverTicked),
				overdue: h.overdue ?? 0,
				stuckPublishing: h.stuckPublishing ?? 0,
				deployCron: h.deployCron ?? null
			};
		}
		if (token?.ok) {
			const t = await token.json();
			if (gen !== loadGen) return;
			tickToken = t;
		}
	}

	async function generateTickToken() {
		tickTokenBusy = true;
		notice.clearError();
		try {
			const res = await fetch('/api/scheduler/tick-token', { method: 'POST' });
			const payload = await res.json();
			if (!res.ok) throw new Error(payload.error || 'Could not create a tick token');
			tickTokenRevealed = payload.token;
			tickTokenCopied = false;
			tickConfirm = null;
			await load();
		} catch (e) {
			notice.fail(humanizeError(e instanceof Error ? e.message : 'Could not create a tick token'));
		} finally {
			tickTokenBusy = false;
		}
	}

	async function revokeTickToken() {
		tickTokenBusy = true;
		notice.clearError();
		try {
			const res = await fetch('/api/scheduler/tick-token', { method: 'DELETE' });
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(payload.error || 'Could not revoke the tick token');
			tickConfirm = null;
			tickTokenRevealed = null;
			notice.ok('Tick token revoked');
			await load();
		} catch (e) {
			notice.fail(
				humanizeError(e instanceof Error ? e.message : 'Could not revoke the tick token')
			);
		} finally {
			tickTokenBusy = false;
		}
	}

	async function copyTickValue(value: string, which: 'token' | 'url') {
		try {
			await navigator.clipboard.writeText(value);
			if (which === 'token') tickTokenCopied = true;
			else notice.ok('Tick URL copied');
		} catch {
			notice.fail('Copy failed — select the text manually');
		}
	}

	async function testTick() {
		tickTestBusy = true;
		tickTestMessage = null;
		notice.clearError();
		try {
			const res = await fetch('/api/scheduler/test', { method: 'POST' });
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(payload.error || 'The tick failed');
			// The tick stops at the first post that might not fit this request's
			// Cloudflare call limit; the rest stay due.
			const later = payload.deferred > 0 ? ' The rest go out on the next tick.' : '';
			tickTestMessage =
				payload.processed === 0 && !later
					? 'Tick ran: nothing was due.'
					: `Tick ran: ${payload.processed} post${payload.processed === 1 ? '' : 's'} handled.${later}`;
			await load();
		} catch (e) {
			notice.fail(humanizeError(e instanceof Error ? e.message : 'The tick failed'));
		} finally {
			tickTestBusy = false;
		}
	}

	onMount(() => {
		origin = window.location.origin;
		void load();
	});
</script>

<SettingsCard
	title="Scheduled publishing"
	description="A post goes out when a tick finds it due. The Worker's own cron trigger ticks every minute and needs nothing from you."
	label="Scheduled publishing"
	testid="scheduler-section"
>
	<div
		class="rounded-xl border p-4 {tickState.level === 'warn'
			? 'border-amber-200/60 bg-amber-50/60'
			: 'border-stone-200/80 bg-stone-50/50'}"
		data-testid="scheduler-status"
	>
		<div class="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
			<div class="min-w-0">
				<p class="text-[13px] font-extrabold text-stone-900" data-testid="scheduler-status-line">
					{tickStatusLine}
				</p>
				{#if tickState.level !== 'ok'}
					<p
						class="mt-1 text-[12px] leading-relaxed font-medium {tickState.level === 'warn'
							? 'text-amber-900'
							: 'text-stone-600'}"
						data-testid="scheduler-advice"
					>
						{tickState.message}
					</p>
				{:else if schedulerMessage}
					<p class="mt-1 text-[12px] font-medium text-stone-500">{schedulerMessage}</p>
				{/if}
			</div>
			<button
				type="button"
				onclick={() => void testTick()}
				disabled={tickTestBusy}
				class="shrink-0 self-start rounded-full bg-white px-5 py-2 text-[13px] font-bold text-stone-700 shadow-sm ring-1 ring-stone-200 transition-all hover:bg-stone-100 disabled:opacity-50"
			>
				{tickTestBusy ? 'Ticking…' : 'Tick now'}
			</button>
		</div>
		{#if tickTestMessage}
			<p class="mt-3 text-[12px] font-medium text-emerald-700" role="status">{tickTestMessage}</p>
		{/if}
	</div>

	<h3 class="mt-8 text-[15px] font-extrabold tracking-tight text-stone-900">External cron</h3>
	<p class="mt-1 mb-4 max-w-md text-[13px] leading-relaxed font-medium text-stone-500">
		Any service that can send one POST a minute can tick instead, for when the account has no cron
		trigger left (the free plan allows five per account).
	</p>

	{#if tickTokenRevealed}
		<div class="space-y-4" data-testid="tick-token-reveal">
			<div class="rounded-xl border border-amber-200/50 bg-amber-50/50 p-4">
				<p class="text-[13px] font-bold text-amber-900">New tick token</p>
				<p class="mt-1 text-[13px] font-medium text-amber-700">
					Paste it into your cron service now: it is never shown again.
				</p>
			</div>
			<code
				class="block rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-3 font-mono text-[13px] break-all text-stone-900 shadow-sm select-all"
				data-testid="tick-token-value">{tickTokenRevealed}</code
			>
			<div class="flex flex-wrap items-center gap-2">
				<button
					type="button"
					onclick={() => void copyTickValue(tickTokenRevealed ?? '', 'token')}
					class="rounded-full bg-stone-900 px-6 py-2.5 text-[13px] font-bold text-white shadow-md transition-all hover:bg-stone-800"
					>{tickTokenCopied ? 'Copied' : 'Copy token'}</button
				>
				<button
					type="button"
					onclick={() => {
						tickTokenRevealed = null;
						tickTokenCopied = false;
					}}
					class="rounded-full bg-stone-100 px-6 py-2.5 text-[13px] font-bold text-stone-700 transition-all hover:bg-stone-200"
					>I have saved it</button
				>
			</div>
		</div>
	{:else}
		<div
			class="mb-5 rounded-xl border border-stone-200/80 bg-stone-50/50 p-4"
			data-testid="tick-token-status"
		>
			{#if tickToken?.configured}
				<p class="flex flex-wrap items-center gap-2 text-[13px] font-extrabold text-stone-900">
					Tick token
					<code
						class="rounded bg-emerald-100/50 px-1.5 py-0.5 font-mono text-[12px] text-emerald-700"
					>
						{tickToken.prefix}…
					</code>
				</p>
				<p class="mt-1 text-[11px] font-medium text-stone-500">
					Created {timeAgo(tickToken.createdAt)} · shown once when generated
				</p>
			{:else}
				<p class="text-[13px] font-medium text-stone-500">
					No tick token. Generate one to let an external cron publish scheduled posts.
				</p>
			{/if}
		</div>
		<div class="flex flex-wrap gap-2">
			{#if tickToken?.configured}
				<button
					type="button"
					onclick={() => (tickConfirm = 'rotate')}
					disabled={tickTokenBusy}
					class="rounded-full bg-stone-100 px-6 py-2.5 text-[13px] font-bold text-stone-700 transition-all hover:bg-stone-200 disabled:opacity-50"
				>
					Generate replacement
				</button>
				<button
					type="button"
					onclick={() => (tickConfirm = 'revoke')}
					disabled={tickTokenBusy}
					class="rounded-full bg-red-50 px-6 py-2.5 text-[13px] font-bold text-red-600 transition-all hover:bg-red-100 disabled:opacity-50"
				>
					Revoke
				</button>
			{:else}
				<button
					type="button"
					onclick={() => (tickConfirm = 'rotate')}
					disabled={tickTokenBusy}
					class="rounded-full bg-stone-900 px-6 py-2.5 text-[13px] font-bold text-white shadow-md transition-all hover:bg-stone-800 disabled:opacity-50"
					data-testid="tick-token-generate"
				>
					Generate tick token
				</button>
			{/if}
		</div>
	{/if}

	<details class="mt-6">
		<summary class="cursor-pointer text-[13px] font-bold text-stone-900">
			How to call the tick from another service
		</summary>
		<div class="mt-3 space-y-3 text-[13px] leading-relaxed font-medium text-stone-600">
			<p>Send a POST with the token as a bearer credential:</p>
			<div class="flex flex-col gap-2 sm:flex-row sm:items-center">
				<code
					class="min-w-0 flex-1 rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-2.5 font-mono text-[12px] break-all text-stone-900 select-all"
					data-testid="tick-url">{tickUrl}</code
				>
				<button
					type="button"
					onclick={() => void copyTickValue(tickUrl, 'url')}
					class="shrink-0 rounded-full bg-stone-100 px-5 py-2 text-[13px] font-bold text-stone-700 transition-all hover:bg-stone-200"
				>
					Copy URL
				</button>
			</div>
			<pre
				class="overflow-x-auto rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-3 font-mono text-[12px] text-stone-900">curl -X POST {tickUrl} \
  -H "Authorization: Bearer &lt;tick token&gt;"</pre>
			<p>
				In cron-job.org: create a job, method <strong>POST</strong>, schedule every minute, and add
				the header <code>Authorization: Bearer &lt;tick token&gt;</code>. UptimeRobot's free plan
				can do the same every five minutes; the repository also ships a GitHub Actions workflow for
				it. Ticks are idempotent, so a slow or duplicated caller is harmless.
			</p>
		</div>
	</details>
</SettingsCard>

<ConfirmDialog
	open={tickConfirm !== null}
	idPrefix="tick-token-dialog"
	title={tickConfirm === 'revoke' ? 'Revoke tick token?' : 'New tick token?'}
	body={tickConfirm === 'revoke'
		? 'An external cron using the current token stops publishing immediately.'
		: tickToken?.configured
			? 'The current token stops working immediately. The new one is shown once.'
			: 'The token is shown once. Copy it into your cron service before closing.'}
	confirmLabel={tickConfirm === 'revoke' ? 'Revoke' : 'Generate'}
	cancelLabel="Keep"
	tone={tickConfirm === 'revoke' ? 'danger' : 'primary'}
	busy={tickTokenBusy}
	onConfirm={() => void (tickConfirm === 'revoke' ? revokeTickToken() : generateTickToken())}
	onCancel={() => (tickConfirm = null)}
/>

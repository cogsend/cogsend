<script lang="ts">
	import { Link2, LoaderCircle } from '@lucide/svelte';
	import { slide } from 'svelte/transition';
	import CopyButton from './CopyButton.svelte';
	import { showToast } from './toast.svelte.js';
	import { SHARE_DEFAULT_DAYS } from '#lib/domain/draft-share.js';
	import { humanizeError } from '#lib/domain/human-error.js';
	import { formatRelativeTime } from '#lib/domain/relative-time.js';

	/**
	 * The composer's preview link: one per draft, readable without signing in.
	 * The link shows whatever is saved, so making one saves first.
	 */
	let {
		draftId,
		ensureSaved
	}: {
		draftId: string | null;
		/** Saves pending edits and returns the draft's id, or null when it could not. */
		ensureSaved: () => Promise<string | null>;
	} = $props();

	type Share = { url: string; expiresAt: string };

	let open = $state(false);
	let busy = $state<'load' | 'create' | 'revoke' | null>(null);
	let share = $state<Share | null>(null);
	// Which draft `share` belongs to: the editor swaps posts without remounting.
	let loadedFor = $state<string | null>(null);

	// Another post opened: what the panel showed was about the previous one. A
	// new post getting its first id is not that; create() fills the panel in.
	let previousId: string | null = null;
	$effect(() => {
		const id = draftId;
		if (previousId !== null && id !== previousId) {
			share = null;
			loadedFor = null;
			open = false;
		}
		previousId = id;
	});

	async function request(id: string, method: 'GET' | 'POST' | 'DELETE'): Promise<Share | null> {
		const res = await fetch(`/api/drafts/${encodeURIComponent(id)}/share`, { method });
		const payload = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(payload.error || 'Could not update the preview link');
		return payload.share ?? null;
	}

	async function load(id: string) {
		busy = 'load';
		try {
			const found = await request(id, 'GET');
			if (draftId !== id) return;
			share = found;
			loadedFor = id;
		} catch (e) {
			showToast(humanizeError(e instanceof Error ? e.message : 'Could not load'), 'error');
		} finally {
			busy = null;
		}
	}

	async function create() {
		busy = 'create';
		try {
			const id = await ensureSaved();
			if (!id) return;
			const made = await request(id, 'POST');
			if (draftId !== id) return;
			share = made;
			loadedFor = id;
		} catch (e) {
			showToast(humanizeError(e instanceof Error ? e.message : 'Could not share'), 'error');
		} finally {
			busy = null;
		}
	}

	async function revoke() {
		const id = draftId;
		if (!id) return;
		busy = 'revoke';
		try {
			await request(id, 'DELETE');
			if (draftId !== id) return;
			share = null;
			showToast('Preview link turned off', 'success');
		} catch (e) {
			showToast(humanizeError(e instanceof Error ? e.message : 'Could not turn off'), 'error');
		} finally {
			busy = null;
		}
	}

	function toggle(e: MouseEvent) {
		e.stopPropagation();
		open = !open;
		if (open && draftId && loadedFor !== draftId) void load(draftId);
	}

	function onWindowClick(e: MouseEvent) {
		if (!(e.target as HTMLElement).closest('.share-preview-container')) open = false;
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && open) open = false;
	}
</script>

<svelte:window onclick={onWindowClick} onkeydown={onKeydown} />

<div class="share-preview-container relative">
	<button
		type="button"
		data-testid="share-toggle"
		aria-expanded={open}
		aria-haspopup="dialog"
		onclick={toggle}
		class="flex items-center gap-1.5 rounded-full border border-stone-200 px-3 py-1.5 text-[12px] font-bold whitespace-nowrap text-stone-500 transition-colors hover:border-stone-300 hover:bg-stone-100 hover:text-stone-900"
	>
		<Link2 class="h-3 w-3" /> Share
	</button>

	{#if open}
		<div
			role="dialog"
			aria-label="Preview link"
			data-testid="share-panel"
			class="absolute top-full right-0 z-40 mt-2 w-72 rounded-[1rem] border border-stone-200/80 bg-white p-3 shadow-[0_16px_40px_-12px_rgb(28_25_23/0.15)]"
			transition:slide={{ duration: 150 }}
		>
			<p class="mb-1 text-[10px] font-bold tracking-widest text-stone-500 uppercase">
				Preview link
			</p>
			{#if busy === 'load'}
				<p class="flex items-center gap-2 py-2 text-[12px] font-medium text-stone-500">
					<LoaderCircle class="h-3.5 w-3.5 animate-spin" /> Loading…
				</p>
			{:else if share}
				<div class="flex items-center gap-1 rounded-lg border border-stone-200 bg-stone-50 pl-2">
					<input
						readonly
						value={share.url}
						data-testid="share-url"
						aria-label="Preview link"
						onfocus={(e) => e.currentTarget.select()}
						class="min-w-0 flex-1 bg-transparent py-1.5 text-[12px] font-medium text-stone-700 focus:outline-none"
					/>
					<CopyButton value={share.url} ariaLabel="Copy preview link" />
				</div>
				<p class="mt-2 text-[12px] font-medium text-stone-500">
					Anyone with it sees the latest save. Stops working {formatRelativeTime(share.expiresAt)},
					or once the post goes out.
				</p>
				<div class="mt-3 flex items-center justify-end gap-2">
					<button
						type="button"
						data-testid="share-renew"
						disabled={busy !== null}
						onclick={() => void create()}
						title="Replace this link with a new one; the current one stops working"
						class="rounded-full border border-stone-200 px-3 py-1 text-[12px] font-bold text-stone-600 transition-colors hover:bg-stone-100 disabled:opacity-50"
					>
						{busy === 'create' ? 'Making…' : 'New link'}
					</button>
					<button
						type="button"
						data-testid="share-revoke"
						disabled={busy !== null}
						onclick={() => void revoke()}
						class="rounded-full border border-red-200 px-3 py-1 text-[12px] font-bold text-red-700 transition-colors hover:bg-red-50 disabled:opacity-50"
					>
						{busy === 'revoke' ? 'Turning off…' : 'Turn off'}
					</button>
				</div>
			{:else}
				<p class="text-[12px] font-medium text-stone-500">
					A read-only link to this draft that works without signing in. It shows the latest save,
					not the accounts it goes to, and stops working after {SHARE_DEFAULT_DAYS} days or once the post
					goes out.
				</p>
				<button
					type="button"
					data-testid="share-create"
					disabled={busy !== null}
					onclick={() => void create()}
					class="mt-3 w-full rounded-full bg-stone-900 px-4 py-2 text-[12px] font-bold text-white transition-colors hover:bg-stone-800 disabled:opacity-60"
				>
					{busy === 'create' ? 'Making link…' : 'Create link'}
				</button>
			{/if}
		</div>
	{/if}
</div>

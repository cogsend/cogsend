<script lang="ts">
	import { Calendar, CircleAlert, LoaderCircle, TriangleAlert } from '@lucide/svelte';
	import type { PostState } from '#lib/domain/post-state.js';
	import { formatRelativeTime } from '#lib/domain/relative-time.js';
	import { scheduleWhenText } from '#lib/domain/schedule-helpers.js';

	let {
		post,
		now,
		nameOf,
		drift,
		sending,
		dirty,
		unscheduling,
		busy,
		onChangeTime,
		onUnschedule,
		onApplyAccounts
	}: {
		post: PostState;
		now: Date;
		nameOf: (connectionId: string) => string;
		drift: { added: string[]; removed: string[] };
		/** The editor is paused for a send, including one only a refused save revealed. */
		sending: boolean;
		dirty: boolean;
		unscheduling: boolean;
		/** A publish, schedule or unschedule is running: no second action. */
		busy: boolean;
		onChangeTime: () => void;
		onUnschedule: () => void;
		onApplyAccounts: () => void;
	} = $props();

	const SOON_MS = 5 * 60_000;

	const names = (ids: string[]) => ids.map(nameOf).join(', ');

	type Group = { kind: 'at' | 'due' | 'untimed'; at: Date | null; ids: string[] };

	// Accounts due at the same minute read as one line; the scheduler sends
	// them in the same run anyway.
	const groups = $derived.by(() => {
		const out: Group[] = [];
		for (const w of post.waiting.filter((w) => !w.retrying)) {
			const due = w.queued || (w.at !== null && w.at.getTime() <= now.getTime());
			const kind: Group['kind'] = due ? 'due' : w.at ? 'at' : 'untimed';
			const minute = kind === 'at' && w.at ? Math.floor(w.at.getTime() / 60_000) : null;
			const same = out.find(
				(g) =>
					g.kind === kind &&
					(minute === null || (g.at && Math.floor(g.at.getTime() / 60_000) === minute))
			);
			if (same) same.ids.push(w.connectionId);
			else out.push({ kind, at: kind === 'at' ? w.at : null, ids: [w.connectionId] });
		}
		return out.sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));
	});

	const retrying = $derived(post.waiting.filter((w) => w.retrying).map((w) => w.connectionId));
	// How it went on each account is for Posts to show; the composer only says
	// where to look, so the post being edited is not buried under its history.
	const summary = $derived.by(() => {
		const parts: string[] = [];
		if (post.published.length) parts.push(`Published on ${names(post.published)}.`);
		if (retrying.length) parts.push(`Retrying on ${names(retrying)}.`);
		const failed = post.failed.map((f) => f.connectionId);
		if (failed.length) parts.push(`Failed on ${names(failed)}.`);
		return parts.join(' ');
	});
	const summaryHref = $derived(
		post.failed.length ? '/posts?tab=failed' : retrying.length ? '/posts' : '/posts?tab=published'
	);
	const soon = $derived(
		!sending &&
			post.nextAt !== null &&
			post.nextAt.getTime() > now.getTime() &&
			post.nextAt.getTime() - now.getTime() <= SOON_MS
	);
	// Only a post waiting for its time can be re-timed or unscheduled here; a
	// retry or a video being processed is handled from Posts.
	const canAct = $derived(groups.length > 0 && !sending);

	const linkClass = 'font-bold whitespace-nowrap underline underline-offset-2 hover:text-stone-950';

	const actionClass =
		'rounded-full border border-stone-300 bg-white px-4 py-1.5 text-[12px] font-bold text-stone-800 transition-colors hover:bg-stone-100 disabled:opacity-50';
</script>

<section
	aria-label="Post status"
	data-testid="post-status"
	class="mb-6 rounded-xl border border-stone-200/80 bg-stone-50/70 px-4 py-3"
>
	<ul class="space-y-1.5 text-[13px] font-medium text-stone-800">
		{#if sending}
			<li class="flex items-start gap-2" data-testid="post-status-sending">
				<LoaderCircle class="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-stone-500" />
				<span>
					Sending now. Editing is paused until it's done.{dirty
						? " Your last change isn't saved yet."
						: ''}
					<a href="/posts" class={linkClass}>View in Posts</a>
				</span>
			</li>
		{/if}
		{#if post.processing.length}
			<li class="flex items-start gap-2" data-testid="post-status-processing">
				<LoaderCircle class="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-stone-500" />
				<span>
					{names(post.processing)}
					{post.processing.length === 1 ? 'is' : 'are'} processing the video — it publishes on its own.
					<a href="/posts" class={linkClass}>View in Posts</a>
				</span>
			</li>
		{/if}
		{#each groups as group (group.kind + (group.at?.getTime() ?? '') + group.ids.join())}
			<li class="flex items-start gap-2" data-testid="post-status-scheduled">
				<Calendar class="mt-0.5 h-3.5 w-3.5 shrink-0 text-stone-500" />
				<span>
					{#if group.kind === 'at' && group.at}
						Scheduled for <strong class="font-bold">{scheduleWhenText(group.at, now)}</strong> on {names(
							group.ids
						)}.
					{:else if group.kind === 'due'}
						Due on {names(group.ids)} — it goes out with the next scheduler run.
					{:else}
						Scheduled on {names(group.ids)}.
					{/if}
				</span>
			</li>
		{/each}
		{#if summary}
			<li
				class="flex items-start gap-2 {post.failed.length ? 'text-red-700' : ''}"
				data-testid="post-status-summary"
			>
				<CircleAlert class="mt-0.5 h-3.5 w-3.5 shrink-0 text-stone-500" />
				<span>
					{summary}
					<a href={summaryHref} class={linkClass}>Details in Posts</a>
				</span>
			</li>
		{/if}
	</ul>

	{#if canAct}
		<p class="mt-2 text-[12px] font-medium text-stone-500">
			{soon && post.nextAt
				? `It goes out ${formatRelativeTime(post.nextAt, now)}; editing pauses while it sends.`
				: 'Edits save as you type and go out at that time.'}
		</p>
	{/if}

	{#if canAct && (drift.added.length || drift.removed.length)}
		<div
			data-testid="schedule-drift"
			class="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-amber-200/70 bg-amber-50/70 px-3 py-2"
		>
			<TriangleAlert class="h-3.5 w-3.5 shrink-0 text-amber-600" />
			<p class="min-w-48 flex-1 text-[12px] font-medium text-amber-900">
				{#if drift.removed.length}
					{names(drift.removed)}
					{drift.removed.length === 1 ? 'is' : 'are'} still scheduled even though
					{drift.removed.length === 1 ? "it's" : "they're"} unchecked.
				{/if}
				{#if drift.added.length}
					{names(drift.added)}
					{drift.added.length === 1 ? 'is' : 'are'} checked but
					{drift.added.length === 1 ? "isn't" : "aren't"} scheduled.
				{/if}
				Update the schedule to apply your changes.
			</p>
			<button
				type="button"
				data-testid="schedule-drift-apply"
				data-schedule-opener
				class="rounded-full border border-amber-300 bg-white px-4 py-1.5 text-[12px] font-bold text-amber-900 transition-colors hover:bg-amber-100"
				onclick={onApplyAccounts}
			>
				Update schedule
			</button>
		</div>
	{/if}

	{#if canAct}
		<div class="mt-3 flex flex-wrap gap-2">
			<button
				type="button"
				data-testid="post-status-change-time"
				data-schedule-opener
				class={actionClass}
				onclick={onChangeTime}
			>
				Change time
			</button>
			<button
				type="button"
				data-testid="unschedule-post"
				class={actionClass}
				disabled={busy}
				onclick={onUnschedule}
			>
				{unscheduling ? 'Unscheduling…' : 'Unschedule'}
			</button>
		</div>
	{/if}
</section>

<script lang="ts">
	import { PenSquare, XCircle } from '@lucide/svelte';

	let { data } = $props();

	const firstName = $derived.by(() => {
		if (data.displayName?.trim()) return data.displayName.trim();
		const email = data.user?.email ?? '';
		const local = email.split('@')[0] ?? '';
		if (!local) return 'there';
		return local.charAt(0).toUpperCase() + local.slice(1);
	});

	const health = $derived.by(() => {
		if (data.stuckPublishing > 0) {
			const n = data.stuckPublishing;
			return {
				tone: 'bad' as const,
				label: `${n} post${n === 1 ? '' : 's'} stuck publishing`
			};
		}
		if (data.overdue > 0) {
			const n = data.overdue;
			return {
				tone: 'warn' as const,
				label: `${n} scheduled post${n === 1 ? '' : 's'} waiting to send`
			};
		}
		if (!data.schedulerOk) {
			// "Never ticked" is a different problem from "stopped ticking": nothing
			// has published a scheduled post yet, usually because the account had
			// no cron trigger left and nothing else calls the tick.
			return {
				tone: 'warn' as const,
				label: data.schedulerNeverTicked
					? 'Scheduled posts are not published yet'
					: 'Scheduler delayed'
			};
		}
		return { tone: 'ok' as const, label: 'All systems operational' };
	});
</script>

<div
	class="-mt-10 flex min-h-[60vh] w-full flex-1 flex-col items-center justify-center text-center"
>
	<div
		class="mb-6 inline-flex items-center gap-2 rounded-full border border-stone-200/50 bg-stone-100/80 px-3 py-1.5 shadow-sm"
	>
		<span
			aria-hidden="true"
			class="flex h-2 w-2 rounded-full {health.tone === 'ok'
				? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]'
				: health.tone === 'bad'
					? 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]'
					: 'bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]'}"
		></span>
		<span
			class="text-[11px] font-bold tracking-widest uppercase {health.tone === 'ok'
				? 'text-stone-500'
				: health.tone === 'bad'
					? 'text-red-600'
					: 'text-amber-700'}"
			title={data.schedulerError ?? undefined}>{health.label}</span
		>
	</div>

	<h1 class="mb-4 text-5xl leading-[1.05] font-extrabold tracking-tight text-stone-900 sm:text-6xl">
		Welcome back, <br /><span class="text-stone-500">{firstName}</span>
	</h1>
	<p class="mt-2 max-w-sm text-[15px] leading-relaxed font-medium text-stone-500">
		You currently have <strong class="font-bold text-stone-900">{data.scheduledCount}</strong>
		scheduled posts and <strong class="font-bold text-stone-900">{data.draftCount}</strong> drafts.
	</p>

	{#if data.failedCount > 0}
		<a
			href="/posts?tab=failed"
			class="mt-6 flex w-full max-w-sm items-center justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-left transition-colors hover:bg-red-100"
		>
			<span class="flex items-center gap-3">
				<XCircle class="h-5 w-5 shrink-0 text-red-600" />
				<span class="text-[13px] font-bold text-red-700"
					>{data.failedCount} post{data.failedCount === 1 ? '' : 's'} failed to publish</span
				>
			</span>
			<span class="text-[12px] font-bold text-red-700 underline">Review</span>
		</a>
	{/if}

	<div class="mt-12 w-full max-w-xs">
		<a
			href="/compose"
			class="group relative flex w-full cursor-pointer flex-col items-center justify-center overflow-hidden rounded-[2rem] border border-stone-200/80 bg-white p-8 shadow-[0_8px_30px_-12px_rgb(28_25_23/0.06)] transition-all duration-300 hover:border-stone-300 hover:shadow-[0_20px_40px_-12px_rgb(28_25_23/0.12)]"
		>
			<div
				class="absolute inset-0 bg-gradient-to-b from-stone-50/50 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100"
			></div>
			<div
				class="relative mb-5 flex h-14 w-14 items-center justify-center rounded-[1rem] bg-stone-900 text-white shadow-md transition-all duration-300 group-hover:-translate-y-1 group-hover:shadow-lg"
			>
				<PenSquare class="ml-0.5 h-5 w-5" />
			</div>
			<h2 class="relative mb-1 text-[15px] font-extrabold tracking-tight text-stone-900">
				Start writing
			</h2>
			<p class="relative text-center text-[13px] font-medium text-stone-500">Draft a new post.</p>
		</a>
	</div>
</div>

<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import {
		CalendarClock,
		Send,
		Search,
		X,
		XCircle,
		Pencil,
		RefreshCw,
		ChevronDown,
		Check,
		Users,
		LoaderCircle,
		TriangleAlert
	} from '@lucide/svelte';
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import MediaPreview from '#lib/components/MediaPreview.svelte';
	import LinkedText from '#lib/components/LinkedText.svelte';
	import { markPublishSeen, publishActivity } from '#lib/components/publish-tracker.svelte.js';
	import { platformColorClass } from '#lib/components/platform-color.js';
	import SocialIcon from '#lib/components/SocialIcon.svelte';
	import { displayHandle, platformName, platformRank } from '#lib/domain/platforms.js';
	import { draftExcerpt } from '#lib/domain/excerpt.js';
	import { cardParts } from '#lib/domain/linkify.js';
	import { safeHttpUrl } from '#lib/domain/links.js';
	import { parseXPostUrl } from '#lib/domain/x-quote.js';
	import { humanizeError } from '#lib/domain/human-error.js';
	import { cardOutcome, isTargetSending, type CardOutcome } from '#lib/domain/post-state.js';
	import {
		afterHistoryPage,
		afterWaitingPage,
		firstQueueCursors,
		type QueueCursors
	} from '#lib/domain/queue-cursor.js';
	import { PROCESSING_MARK } from '#lib/domain/video-rules.js';
	import { sessionExpiredIfUnauthorized } from '#lib/components/session-expired.js';
	import { takePostsNotice } from '#lib/components/posts-notice.js';
	import { showToast } from '#lib/components/toast.svelte.js';
	import { menuNav } from '#lib/components/menu-nav.js';
	import {
		formatDayTime,
		formatFullLocalWithZone,
		formatLocalDateTimeWithZone,
		formatRelativeTime,
		localTimezoneShort
	} from '#lib/domain/relative-time.js';
	import {
		cancelTargetIds,
		emptyPostsBody,
		emptyPostsHeading,
		needsReconnect,
		rescheduleTargetIds,
		retryTargetIds,
		type PostsTab
	} from '#lib/domain/post-actions.js';
	import {
		DEFAULT_SCHEDULE_OFFSET,
		isFutureScheduleValue,
		minScheduleDatetime,
		offsetToDHM,
		scheduleFromDHM,
		scheduleValueToIso
	} from '#lib/domain/schedule-helpers.js';
	import { threadPosts, type ThreadPost } from '#lib/domain/thread-segments.js';
	import type { Snapshot } from './$types';

	type PostMedia = {
		id: string;
		storageKey: string;
		mime: string;
		altText: string | null;
		segmentIndex?: number | null;
		sortOrder?: number | null;
		width?: number | null;
		height?: number | null;
		meta?: { cover?: { v?: number } | null; durationMs?: number | null } | null;
	};

	type DraftTarget = {
		status: string;
		remoteUrl: string | null;
		connection?: {
			id?: string;
			platform?: string;
			handle?: string | null;
			displayName?: string | null;
		};
	};

	type Draft = {
		id: string;
		title: string | null;
		baseBody: string;
		status: string;
		updatedAt: string | Date;
		targets?: DraftTarget[];
		media?: PostMedia[];
	};

	type QueueTarget = {
		id: string;
		status: string;
		scheduledFor: string | Date | null;
		updatedAt?: string | Date | null;
		jobId?: string | null;
		remoteUrl: string | null;
		errorMessage: string | null;
		draft: {
			id: string;
			title: string | null;
			baseBody: string;
			status: string;
			media?: PostMedia[];
		};
		connection: {
			id: string;
			platform: string;
			handle: string | null;
			displayName: string | null;
			avatarUrl?: string | null;
			status?: string;
		};
	};

	type Card = {
		key: string;
		kind: 'draft' | 'target';
		status: string;
		body: string;
		when: string | Date | null;
		/** Epoch ms used for newest-first ordering. */
		sortKey: number;
		whenLabel: 'scheduled' | 'published' | 'updated';
		/** How a finished post went; null while nothing has finished. */
		outcome: CardOutcome | null;
		platforms: {
			name: string;
			connectionId?: string;
			displayName?: string | null;
			remoteUrl?: string | null;
			error?: string | null;
			status?: string;
			targetId?: string;
			connectionStatus?: string | null;
			scheduledFor?: string | Date | null;
			handle?: string | null;
		}[];
		remoteUrl: string | null;
		error: string | null;
		draftId: string;
		targetId: string | null;
		/** All attachments flattened across thread segments, display-sorted. */
		media: PostMedia[];
		/** What publishing sends, one entry per thread post; one entry for a single post. */
		posts: ThreadPost<PostMedia>[];
	};

	const TAB_VALUES: PostsTab[] = ['all', 'scheduled', 'published', 'failed', 'drafts'];
	// The tab and account live in the URL so Back, reload and shared links keep
	// them, and the browser's scroll restore lands in the right list.
	const activeTab = $derived.by((): PostsTab => {
		const tab = page.url.searchParams.get('tab');
		return TAB_VALUES.includes(tab as PostsTab) ? (tab as PostsTab) : 'all';
	});
	const accountFilter = $derived(page.url.searchParams.get('account'));

	function postsHref(changes: { tab?: PostsTab; account?: string | null }): string {
		const url = new URL(page.url.href);
		if (changes.tab === 'all') url.searchParams.delete('tab');
		else if (changes.tab) url.searchParams.set('tab', changes.tab);
		if (changes.account === null) url.searchParams.delete('account');
		else if (changes.account) url.searchParams.set('account', changes.account);
		return url.pathname + url.search;
	}

	// Replacing the entry keeps Back leaving Posts rather than stepping through filters.
	function setAccountFilter(id: string | null) {
		void goto(postsHref({ account: id }), { replace: true, reset: false });
	}

	let tabStrip = $state<HTMLDivElement | null>(null);
	let fadeLeft = $state(false);
	let fadeRight = $state(false);
	let duplicating = $state<string | null>(null);
	let quoting = $state<string | null>(null);
	let accountMenuOpen = $state(false);
	let accountFilterTrigger: HTMLButtonElement | null = $state(null);
	let accountMenuEl = $state<HTMLDivElement | null>(null);
	let query = $state('');
	let searchInput = $state<HTMLInputElement | null>(null);
	// Debounced for filtering: typing filters O(N) cards (excerpt + lowercase
	// per card), so wait 150ms after the last keystroke before recomputing.
	let debouncedQuery = $state('');
	// First-load flag: shows skeleton cards instead of flashing the empty
	// state while /api/drafts + /api/queue are in flight.
	let { data } = $props();
	// The list arrives with the document. A later refresh keeps it on screen.
	let loading = $state(false);
	// Distinguishes "there is nothing here" from "the list never arrived".
	// svelte-ignore state_referenced_locally
	let loadFailed = $state(Boolean(data.loadFailed));
	// svelte-ignore state_referenced_locally
	let drafts = $state<Draft[]>(data.drafts);
	// svelte-ignore state_referenced_locally
	let targets = $state<QueueTarget[]>(data.targets);
	// Older pages and server search results live apart from the first page, so
	// a refresh, which replaces `targets` and `drafts`, never drops them.
	let olderTargets = $state<QueueTarget[]>([]);
	let olderDrafts = $state<Draft[]>([]);
	// svelte-ignore state_referenced_locally
	let queueNext = $state<QueueCursors>(firstQueueCursors(data.queueNext));
	// svelte-ignore state_referenced_locally
	let draftsNext = $state<string | null>(data.draftsNext ?? null);
	// Once a page past the first is in, the cursor is where that page ended,
	// not where a refreshed first page ends.
	let waitingPaged = false;
	let historyPaged = false;
	let draftsPaged = false;
	// How many accounts a post waits on in all, for posts whose accounts a
	// page edge split: until the rest is read, the card is only part of it.
	// svelte-ignore state_referenced_locally
	let firstWaitingTotals = $state<Record<string, number>>(data.waitingTotals ?? {});
	let laterWaitingTotals = $state<Record<string, number>>({});
	let loadingOlder = $state(false);
	let olderError = $state<string | null>(null);
	let searchTargets = $state<QueueTarget[]>([]);
	let searchDrafts = $state<Draft[]>([]);
	let searchedFor = $state('');
	let searching = $state(false);
	// svelte-ignore state_referenced_locally
	let error = $state<string | null>(data.loadFailed ? 'Could not load posts' : null);
	// What the composer just did with the post that sent you here.
	let notice = $state(takePostsNotice());
	let busy = $state<string | null>(null);
	// What went wrong with an action on one card, shown on that card. Keyed by
	// draft: the card's own key follows its newest target, which a retry or a
	// refresh can change.
	let cardErrors = $state<Record<string, string>>({});
	function setCardError(draftId: string, message: string | null) {
		const { [draftId]: _dropped, ...rest } = cardErrors;
		cardErrors = message ? { ...rest, [draftId]: message } : rest;
	}
	// Relative times ("in 5m") move on without rebuilding the cards.
	let now = $state(Date.now());
	let pendingCancel = $state<{
		ids: string[];
		label: string;
		cardKey: string;
		draftId: string;
		/** Every account still waiting, not one of them. */
		whole: boolean;
		title?: string;
		confirmLabel?: string;
	} | null>(null);
	let pendingRemove = $state<Draft | null>(null);
	let removeBusy = $state(false);
	let pendingDelete: Draft | null = $state(null);
	let pendingTimer: number | null = null;
	let rescheduleId = $state<string | null>(null);
	let rescheduleAt = $state(minScheduleDatetime(new Date()));
	let rescheduleMode = $state<'relative' | 'absolute'>('relative');
	let rescheduleRelativeValue = $state('1');
	let rescheduleRelativeUnit = $state<'hours' | 'days' | 'mins'>('hours');

	function applyRelativeReschedule() {
		const { days, hours, minutes } = offsetToDHM(rescheduleRelativeValue, rescheduleRelativeUnit);
		rescheduleAt = scheduleFromDHM(days, hours, minutes, new Date());
	}

	async function load(opts: { keepError?: boolean } = {}) {
		const bare = drafts.length === 0 && targets.length === 0;
		if (bare) loading = true;
		// A fresh attempt supersedes the previous failure banner — except when
		// this reload was triggered by an action that just reported a failure,
		// where clearing it would hide the only message the user gets.
		if (!opts.keepError) error = null;
		try {
			const [draftsRes, queueRes] = await Promise.all([
				fetch('/api/drafts?view=summary'),
				fetch('/api/queue')
			]);
			// An expired session is not a broken social account: sign in again
			// rather than showing the reconnect copy.
			if (sessionExpiredIfUnauthorized(draftsRes) || sessionExpiredIfUnauthorized(queueRes)) {
				loadFailed = true;
				return;
			}
			loadFailed = false;
			const failed: string[] = [];
			if (draftsRes.ok) {
				const payload = await draftsRes.json().catch(() => ({}));
				drafts = payload.drafts || [];
				if (!draftsPaged) draftsNext = payload.next ?? null;
			} else {
				failed.push('drafts');
			}
			if (queueRes.ok) {
				const payload = await queueRes.json().catch(() => ({}));
				targets = payload.targets || [];
				firstWaitingTotals = payload.waitingTotals ?? {};
				const fresh = firstQueueCursors(payload.next);
				queueNext = {
					waiting: waitingPaged ? queueNext.waiting : fresh.waiting,
					history: historyPaged ? queueNext.history : fresh.history
				};
			} else {
				failed.push('queue');
			}
			if (failed.length) {
				loadFailed = true;
				error = humanizeError('Could not load posts');
			}
		} catch (e) {
			// fetch() rejects (offline, DNS) without a status, so the per-response
			// checks above never ran: without this the page would show nothing at
			// all rather than an error.
			loadFailed = true;
			error = humanizeError(e instanceof Error ? e.message : 'Could not load posts');
		} finally {
			loading = false;
		}
	}

	// Debounce the search input outside onMount ($effect is init-only).
	$effect(() => {
		const q = query;
		const timer = setTimeout(() => {
			debouncedQuery = q;
		}, 150);
		return () => clearTimeout(timer);
	});

	export const snapshot: Snapshot<{ query: string; y: number }> = {
		capture: () => ({ query, y: window.scrollY }),
		async restore(value) {
			query = debouncedQuery = value.query;
			if (!value.query) return;
			// SvelteKit restores scroll before snapshots, against the unfiltered
			// list; scroll again once the filtered one has rendered.
			await tick();
			window.scrollTo(window.scrollX, value.y);
		}
	};

	function updateFades() {
		if (!tabStrip) return;
		const { scrollLeft, clientWidth, scrollWidth } = tabStrip;
		fadeLeft = scrollLeft > 1;
		fadeRight = scrollLeft + clientWidth < scrollWidth - 1;
	}

	// Counts arriving or changing resize the pills as well as the window.
	$effect(() => {
		const strip = tabStrip;
		if (!strip) return;
		const observer = new ResizeObserver(updateFades);
		observer.observe(strip);
		if (strip.firstElementChild) observer.observe(strip.firstElementChild);
		return () => observer.disconnect();
	});

	const FADE_PX = 32;

	// A deep link such as ?tab=failed must not leave its pill cut off or under
	// a fade. This moves the strip only: scrollIntoView would also scroll the
	// page and undo the browser's scroll restore on Back.
	$effect(() => {
		const strip = tabStrip;
		const pill = strip?.querySelector<HTMLElement>(`[data-tab="${activeTab}"]`);
		if (!strip || !pill) return;
		const bounds = strip.getBoundingClientRect();
		const left = bounds.left + FADE_PX;
		const right = bounds.right - FADE_PX;
		const rect = pill.getBoundingClientRect();
		if (rect.left < left) strip.scrollLeft -= left - rect.left;
		else if (rect.right > right) strip.scrollLeft += rect.right - right;
	});

	function fadeMask(left: boolean, right: boolean): string | undefined {
		if (!left && !right) return undefined;
		return `linear-gradient(to right, ${left ? 'transparent' : 'black'}, black ${FADE_PX}px, black calc(100% - ${FADE_PX}px), ${right ? 'transparent' : 'black'})`;
	}

	onMount(() => {
		return () => {
			if (pendingTimer) window.clearTimeout(pendingTimer);
			if (pendingDelete) void commitDelete(pendingDelete.id).catch(() => {});
		};
	});

	function toTime(value: string | Date | null | undefined): number {
		if (!value) return Number.NEGATIVE_INFINITY;
		const t = new Date(value).getTime();
		return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
	}

	/**
	 * Display order for a card gallery: thread order first, then upload order.
	 * Missing indexes (old rows / defensive payloads) sort as segment 0.
	 */
	function sortPostMedia(list: PostMedia[] | undefined | null): PostMedia[] {
		return [...(list ?? [])].sort(
			(a, b) =>
				(a.segmentIndex ?? 0) - (b.segmentIndex ?? 0) || (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
		);
	}

	function cardMedia(body: string, list: PostMedia[] | undefined | null) {
		const media = sortPostMedia(list);
		return { media, posts: threadPosts(body, media) };
	}

	/** Waiting on the platform to finish a video, which is not a failure. */
	function isProcessing(error: string | null | undefined): boolean {
		return (error ?? '').includes(PROCESSING_MARK);
	}

	function whenDisplay(
		when: string | Date | null | undefined,
		at: number
	): {
		text: string;
		title: string;
	} {
		if (!when) return { text: '', title: '' };
		const d = new Date(when);
		if (Number.isNaN(d.getTime())) return { text: '', title: '' };
		// The zone is named once under the list, so a card stays one short line
		// on a phone; the tooltip keeps the full timestamp with it.
		return {
			text: `${formatRelativeTime(d, new Date(at))} · ${formatDayTime(d)}`,
			title: formatFullLocalWithZone(d)
		};
	}

	function draftCards(): Card[] {
		return allDrafts
			.filter((d) => d.status === 'draft')
			.map((d) => {
				const body = d.baseBody || d.title || '';
				return {
					key: `draft-${d.id}`,
					kind: 'draft' as const,
					status: 'draft',
					body,
					when: d.updatedAt,
					sortKey: toTime(d.updatedAt),
					whenLabel: 'updated' as const,
					outcome: null,
					platforms: (() => {
						const seen = new Map<
							string,
							{
								name: string;
								connectionId?: string;
								handle: string | null;
								displayName: string | null;
							}
						>();
						for (const t of d.targets || []) {
							const c = t.connection;
							const key = c?.id ?? c?.platform;
							if (!c?.platform || !key || seen.has(key)) continue;
							seen.set(key, {
								name: c.platform,
								connectionId: c.id,
								handle: c.handle ?? null,
								displayName: c.displayName ?? null
							});
						}
						return [...seen.values()].sort((a, b) => platformRank(a.name) - platformRank(b.name));
					})(),
					remoteUrl: null,
					error: null,
					draftId: d.id,
					targetId: null,
					...cardMedia(body, d.media)
				};
			});
	}

	function targetCards(list: QueueTarget[]): Card[] {
		const groups = new Map<string, QueueTarget[]>();
		for (const t of list) {
			const key = t.draft.id;
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key)!.push(t);
		}

		return Array.from(groups.values()).map((group) => {
			// Sort group by updatedAt descending so we pick the latest
			group.sort((a, b) => toTime(b.updatedAt) - toTime(a.updatedAt));
			const primary = group[0];

			const hasFailed = group.some((t) => t.status === 'failed');
			// Scheduled rows keep their errorMessage when a transient failure
			// backs off: they are auto-retrying, not terminally failed.
			const waiting = group.filter((t) => t.status === 'scheduled' && t.errorMessage);
			// Being sent right now outranks the rest: it settles in moments, and
			// nothing on the card can be changed until it has.
			const sending = group.some(
				(t) =>
					t.status !== 'published' &&
					t.status !== 'failed' &&
					isTargetSending({ status: t.status, jobId: t.jobId, updatedAt: t.updatedAt })
			);
			const cardStatus = sending
				? 'sending'
				: hasFailed
					? 'failed'
					: waiting.length
						? waiting.every((t) => isProcessing(t.errorMessage))
							? 'processing'
							: 'retrying'
						: primary.status;

			// Cancelled (discarded) platforms leave the card entirely: the
			// error rows key off failed rows and the icon row off this list.
			// Whole-card cancel/reschedule/retry helpers only consume
			// pending/scheduled/failed rows, so excluding cancelled is inert.
			const platforms = group
				.filter((t) => t.status !== 'cancelled')
				.map((t) => ({
					name: t.connection.platform,
					connectionId: t.connection.id,
					displayName: t.connection.displayName,
					// Rows stored before the scheme check could still carry any value.
					remoteUrl: safeHttpUrl(t.remoteUrl),
					error: t.errorMessage,
					status: t.status,
					targetId: t.id,
					connectionStatus: t.connection.status ?? null,
					scheduledFor: t.scheduledFor,
					handle: t.connection.handle
				}))
				.sort((a, b) => platformRank(a.name) - platformRank(b.name));

			const body = primary.draft.baseBody || primary.draft.title || '';
			const when = primary.scheduledFor ?? primary.updatedAt ?? null;
			return {
				key: `target-${primary.id}`,
				kind: 'target' as const,
				status: cardStatus,
				body,
				when,
				sortKey: ['scheduled', 'pending', 'publishing'].includes(primary.status)
					? toTime(primary.scheduledFor ?? primary.updatedAt)
					: toTime(primary.updatedAt ?? primary.scheduledFor),
				whenLabel: ['scheduled', 'pending', 'publishing'].includes(primary.status)
					? ('scheduled' as const)
					: ('published' as const),
				outcome: cardOutcome(group),
				platforms,
				// Fallbacks in case we need a general error
				remoteUrl: safeHttpUrl(primary.remoteUrl),
				error: hasFailed
					? group.find((t) => t.status === 'failed')?.errorMessage || 'Failed on some platforms'
					: null,
				draftId: primary.draft.id,
				targetId: primary.id,
				...cardMedia(body, primary.draft.media)
			};
		});
	}

	/** The first list wins: it is the freshest copy of a row that is in several. */
	function mergeById<T extends { id: string }>(...lists: T[][]): T[] {
		const seen = new Set<string>();
		const out: T[] = [];
		for (const list of lists) {
			for (const item of list) {
				if (seen.has(item.id)) continue;
				seen.add(item.id);
				out.push(item);
			}
		}
		return out;
	}

	const searchShown = $derived(searchedFor !== '' && searchedFor === debouncedQuery.trim());
	const allTargets = $derived(mergeById(targets, olderTargets, searchShown ? searchTargets : []));
	const allDrafts = $derived(mergeById(drafts, olderDrafts, searchShown ? searchDrafts : []));

	const upcoming = $derived(
		allTargets.filter((t) => ['scheduled', 'pending', 'publishing'].includes(t.status))
	);
	const history = $derived(
		allTargets.filter((t) => ['published', 'failed', 'cancelled'].includes(t.status))
	);

	// Grouped cards (one card per draft). Counts must use these lengths, not the
	// raw target rows: a single draft scheduled to N platforms is N targets but
	// renders as 1 card.
	const upcomingCards = $derived(targetCards(upcoming));
	const historyCards = $derived(targetCards(history));
	const draftsOnlyCards = $derived(draftCards());

	// Failed is a slice of history, not a separate source: a card with any
	// failed platform carries status 'failed' even when a sibling is retrying.
	const failedCards = $derived(historyCards.filter((c) => c.status === 'failed'));
	// Published is what went out: a post that failed everywhere belongs to
	// Failed only, and one that went out somewhere belongs to both.
	const publishedCards = $derived(
		historyCards.filter((c) => c.outcome?.kind === 'published' || c.outcome?.kind === 'partial')
	);

	// While anything is on its way out, Posts follows it without a reload:
	// quickly while a send is in flight, slowly while a platform processes a
	// video, which only moves on with the scheduler's next run.
	// A post about to go out, or just due, is watched until it has gone. Past
	// ten minutes overdue the scheduler is the problem, and the health line on
	// the home page says so, so Posts stops asking.
	const dueSoon = $derived(
		upcomingCards.some((c) => {
			if (c.status !== 'scheduled' || !c.when) return false;
			const left = toTime(c.when) - now;
			return left < 120_000 && left > -600_000;
		})
	);
	const refreshEvery = $derived.by((): number | null => {
		if (publishActivity.inFlight > 0 || upcomingCards.some((c) => c.status === 'sending')) {
			return 5_000;
		}
		return upcomingCards.some((c) => c.status === 'processing') || dueSoon ? 30_000 : null;
	});
	$effect(() => {
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible') now = Date.now();
		}, 30_000);
		const onVisible = () => {
			if (document.visibilityState === 'visible') now = Date.now();
		};
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			clearInterval(timer);
			document.removeEventListener('visibilitychange', onVisible);
		};
	});
	$effect(() => {
		const every = refreshEvery;
		if (every === null) return;
		// One read at a time: a slow answer must not land after a newer one.
		let reading = false;
		const timer = setInterval(() => {
			if (reading || document.visibilityState !== 'visible') return;
			reading = true;
			void load({ keepError: true }).finally(() => (reading = false));
		}, every);
		return () => clearInterval(timer);
	});
	// A handed-off publish just settled: show how it went straight away.
	let settledSeen = publishActivity.version;
	$effect(() => {
		const version = publishActivity.version;
		if (version === settledSeen) return;
		settledSeen = version;
		void load({ keepError: true });
	});
	// Posts is where a failure is read, so being here is seeing it.
	$effect(() => {
		if (publishActivity.unseenFailure) markPublishSeen();
	});

	type AccountOption = {
		id: string;
		platform: string;
		handle: string | null;
		displayName: string | null;
	};

	// Accounts present in the loaded cards, for the per-account filter.
	const accounts = $derived.by(() => {
		const seen = new Map<string, AccountOption>();
		for (const card of [...upcomingCards, ...historyCards, ...draftsOnlyCards]) {
			for (const p of card.platforms) {
				if (!p.connectionId || seen.has(p.connectionId)) continue;
				seen.set(p.connectionId, {
					id: p.connectionId,
					platform: p.name,
					handle: p.handle ?? null,
					displayName: p.displayName ?? null
				});
			}
		}
		return [...seen.values()].sort(
			(a, b) =>
				platformRank(a.platform) - platformRank(b.platform) ||
				accountFilterLabel(a).localeCompare(accountFilterLabel(b))
		);
	});

	const selectedAccount = $derived(accounts.find((a) => a.id === accountFilter) ?? null);

	// LinkedIn stores the email as its handle at connect time; prefer the
	// profile name there so the filter never shows an address.
	function accountFilterLabel(account: AccountOption): string {
		if (account.platform === 'linkedin') return account.displayName?.trim() || 'LinkedIn';
		return account.handle ? displayHandle(account.handle) : platformName(account.platform);
	}

	function cardsFor(tab: PostsTab): Card[] {
		if (tab === 'scheduled') return upcomingCards;
		if (tab === 'published') return publishedCards;
		if (tab === 'failed') return failedCards;
		if (tab === 'drafts') return draftsOnlyCards;
		return [...upcomingCards, ...historyCards, ...draftsOnlyCards];
	}

	/** The account filter and the search, which the tab counts follow too. */
	function filtered(list: Card[]): Card[] {
		const q = debouncedQuery.trim().toLowerCase();
		return list.filter((c) => {
			if (accountFilter && !c.platforms.some((p) => p.connectionId === accountFilter)) return false;
			return !q || c.body.toLowerCase().includes(q);
		});
	}

	// A filter whose account no longer has any loaded posts (e.g. its last
	// card was cancelled, or an old link names it) would strand the list on an
	// empty state with no chip left to clear. Its posts may only be further
	// back, though, as with an Insights link to an account's failures, so a
	// few older pages are read first; the filter goes only when none has them.
	const FILTER_PAGES = 5;
	let filterPagesFor: string | null = null;
	let filterPagesRead = 0;
	$effect(() => {
		if (!accountFilter || accounts.some((a) => a.id === accountFilter)) return;
		if (loading || loadingOlder || loadFailed) return;
		if (filterPagesFor !== accountFilter) {
			filterPagesFor = accountFilter;
			filterPagesRead = 0;
		}
		if (moreFor(activeTab) && filterPagesRead < FILTER_PAGES) {
			filterPagesRead++;
			void loadOlder();
			return;
		}
		setAccountFilter(null);
	});

	const visible = $derived.by(() => {
		const list = filtered(cardsFor(activeTab));
		// Newest first on every tab.
		list.sort((a, b) => b.sortKey - a.sortKey);
		return list;
	});

	// A tap's choice, kept while the list refreshes. Without one, a thread opens
	// while the search matches only a later post, so the match is on screen; a
	// new search drops the taps, so an earlier close can't hide its match.
	const threadOpen = new SvelteMap<string, boolean>();
	$effect.pre(() => {
		void debouncedQuery;
		untrack(() => threadOpen.clear());
	});

	function isThreadOpen(card: Card): boolean {
		const chosen = threadOpen.get(card.key);
		if (chosen !== undefined) return chosen;
		const q = debouncedQuery.trim().toLowerCase();
		if (!q) return false;
		const [lead, ...rest] = card.posts;
		return (
			!lead.text.toLowerCase().includes(q) && rest.some((p) => p.text.toLowerCase().includes(q))
		);
	}

	async function toggleThread(card: Card, toggle: HTMLElement) {
		const open = !isThreadOpen(card);
		threadOpen.set(card.key, open);
		if (open) return;
		await tick();
		// Closing a long thread can leave its toggle above the screen.
		toggle.scrollIntoView({ block: 'nearest' });
	}

	const tabCounts = $derived(
		Object.fromEntries(TAB_VALUES.map((tab) => [tab, filtered(cardsFor(tab)).length])) as Record<
			PostsTab,
			number
		>
	);
	function countFor(tab: PostsTab): number {
		return tabCounts[tab];
	}

	function moreFor(tab: PostsTab): boolean {
		if (tab === 'scheduled') return queueNext.waiting !== null;
		if (tab === 'published' || tab === 'failed') return queueNext.history !== null;
		if (tab === 'drafts') return draftsNext !== null;
		return queueNext.waiting !== null || queueNext.history !== null || draftsNext !== null;
	}
	const anyMore = $derived(
		queueNext.waiting !== null || queueNext.history !== null || draftsNext !== null
	);

	async function readQueuePage(cursor: string) {
		const res = await fetch(`/api/queue?before=${encodeURIComponent(cursor)}`);
		if (sessionExpiredIfUnauthorized(res)) return null;
		if (!res.ok) throw new Error('Could not load older posts');
		const payload = await res.json();
		olderTargets = [...olderTargets, ...(payload.targets || [])];
		laterWaitingTotals = { ...laterWaitingTotals, ...(payload.waitingTotals ?? {}) };
		return payload.next ?? null;
	}

	/**
	 * Scheduled reads on through what is still waiting, Published and Failed
	 * back through history, and All the waiting posts first, as it lists them.
	 */
	async function loadOlder() {
		if (loadingOlder) return;
		const tab = activeTab;
		const wantWaiting = (tab === 'scheduled' || tab === 'all') && queueNext.waiting !== null;
		const wantHistory =
			!wantWaiting && tab !== 'scheduled' && tab !== 'drafts' && queueNext.history !== null;
		const wantDrafts = (tab === 'all' || tab === 'drafts') && draftsNext !== null;
		if (!wantWaiting && !wantHistory && !wantDrafts) return;
		loadingOlder = true;
		olderError = null;
		try {
			const [queuePage, draftsRes] = await Promise.all([
				wantWaiting
					? readQueuePage(queueNext.waiting!).then((next) => ({ waiting: true, next }))
					: wantHistory
						? readQueuePage(queueNext.history!).then((next) => ({ waiting: false, next }))
						: null,
				wantDrafts
					? fetch(`/api/drafts?view=summary&before=${encodeURIComponent(draftsNext!)}`)
					: null
			]);
			if (draftsRes && sessionExpiredIfUnauthorized(draftsRes)) return;
			if (queuePage) {
				if (queuePage.waiting) {
					queueNext = afterWaitingPage(queueNext, queuePage.next);
					waitingPaged = true;
					if (queueNext.waiting === null) historyPaged = true;
				} else {
					queueNext = afterHistoryPage(queueNext, queuePage.next);
					historyPaged = true;
				}
			}
			if (draftsRes) {
				if (!draftsRes.ok) throw new Error('Could not load older posts');
				const payload = await draftsRes.json();
				olderDrafts = [...olderDrafts, ...(payload.drafts || [])];
				draftsNext = payload.next ?? null;
				draftsPaged = true;
			}
		} catch (e) {
			olderError = humanizeError(e instanceof Error ? e.message : 'Could not load older posts');
		} finally {
			loadingOlder = false;
		}
	}

	const waitingTotals = $derived({ ...laterWaitingTotals, ...firstWaitingTotals });
	/** Accounts a post waits on that no loaded page has shown yet. */
	function unloadedAccounts(draftId: string): number {
		const total = waitingTotals[draftId];
		if (!total || queueNext.waiting === null) return 0;
		const loaded = upcoming.filter((t) => t.draft.id === draftId).length;
		return Math.max(0, total - loaded);
	}
	/** Reads on until the card holds every account its post waits on. */
	async function loadRestOf(draftId: string) {
		if (loadingOlder) return;
		loadingOlder = true;
		olderError = null;
		try {
			for (let pages = 0; pages < 10 && unloadedAccounts(draftId) > 0; pages++) {
				const next = await readQueuePage(queueNext.waiting!);
				queueNext = afterWaitingPage(queueNext, next);
				waitingPaged = true;
				if (queueNext.waiting === null) historyPaged = true;
			}
		} catch (e) {
			setCardError(
				draftId,
				humanizeError(e instanceof Error ? e.message : 'Could not load older posts')
			);
		} finally {
			loadingOlder = false;
		}
	}

	// While part of the history is not loaded, a search asks the server too, so
	// an old post is found without paging back to it.
	let searchSeq = 0;
	let searchCut = $state(false);
	$effect(() => {
		const q = debouncedQuery.trim().slice(0, 200);
		const ask = q !== '' && anyMore;
		const seq = ++searchSeq;
		if (!ask) {
			searching = false;
			return;
		}
		searching = true;
		const timer = setTimeout(async () => {
			try {
				const enc = encodeURIComponent(q);
				const queueMore = untrack(() => queueNext.waiting !== null || queueNext.history !== null);
				const [queueRes, draftsRes] = await Promise.all([
					queueMore ? fetch(`/api/queue?q=${enc}`) : null,
					untrack(() => draftsNext) !== null ? fetch(`/api/drafts?view=summary&q=${enc}`) : null
				]);
				if (seq !== searchSeq) return;
				const queueBody = queueRes?.ok ? await queueRes.json() : null;
				const draftsBody = draftsRes?.ok ? await draftsRes.json() : null;
				if (seq !== searchSeq) return;
				searchTargets = queueBody?.targets ?? [];
				searchDrafts = draftsBody?.drafts ?? [];
				searchCut = Boolean(queueBody?.hasMore || draftsBody?.hasMore);
				searchedFor = q;
			} catch {
				// The cards already loaded are still searched; the rest just stays unfound.
			} finally {
				if (seq === searchSeq) searching = false;
			}
		}, 150);
		return () => clearTimeout(timer);
	});

	type DeleteOutcome = 'ok' | 'missing' | 'failed';

	async function commitDelete(id: string): Promise<DeleteOutcome> {
		try {
			const res = await fetch(`/api/drafts/${id}`, { method: 'DELETE' });
			if (res.ok) return 'ok';
			// Already gone (deleted from another tab, stale card): the desired
			// end state, so never resurrect the card for it.
			return res.status === 404 ? 'missing' : 'failed';
		} catch {
			return 'failed';
		}
	}

	/** Put a card back when the server refused the delete: the draft still exists. */
	function restoreDeleted(draft: Draft) {
		if (allDrafts.some((d) => d.id === draft.id)) return;
		drafts = [...drafts, draft].sort(
			(a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
		);
	}

	async function finalizeDelete(draft: Draft) {
		if ((await commitDelete(draft.id)) !== 'failed') return;
		// The optimistic removal already hid the card; a rejected delete (409
		// while publishing, expired session, offline) must not read as success.
		restoreDeleted(draft);
		error = 'Couldn’t delete the draft — try again';
	}

	function remove(draft: Draft) {
		if (pendingDelete && pendingDelete.id !== draft.id) void finalizeDelete(pendingDelete);
		drafts = drafts.filter((d) => d.id !== draft.id);
		olderDrafts = olderDrafts.filter((d) => d.id !== draft.id);
		searchDrafts = searchDrafts.filter((d) => d.id !== draft.id);
		pendingDelete = draft;
		if (pendingTimer) window.clearTimeout(pendingTimer);
		pendingTimer = window.setTimeout(() => {
			pendingDelete = null;
			void finalizeDelete(draft);
		}, 6000);
	}

	function undoDelete() {
		if (!pendingDelete) return;
		if (pendingTimer) window.clearTimeout(pendingTimer);
		drafts = [...drafts, pendingDelete].sort(
			(a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
		);
		pendingDelete = null;
	}

	async function confirmRemove() {
		if (!pendingRemove) return;
		const draft = pendingRemove;
		pendingRemove = null;
		removeBusy = true;
		try {
			remove(draft);
		} finally {
			removeBusy = false;
		}
	}

	/** Clone a draft (with media bytes) and open the copy in the composer. */
	async function duplicateDraft(draftId: string) {
		if (duplicating) return;
		duplicating = draftId;
		error = null;
		try {
			const res = await fetch(`/api/drafts/${draftId}/duplicate`, { method: 'POST' });
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(payload.error || 'Could not duplicate');
			const id = payload.draft?.id;
			if (!id) throw new Error('Could not duplicate');
			await goto(`/compose?id=${id}`);
		} catch (e) {
			error = humanizeError(e instanceof Error ? e.message : 'Could not duplicate');
		} finally {
			duplicating = null;
		}
	}

	/** The X post a published card can be quoted from: its link and the account that posted it. */
	function quotableX(card: Card): { url: string; connectionId: string } | null {
		for (const p of card.platforms) {
			if (p.name !== 'x' || p.status !== 'published' || !p.connectionId) continue;
			if (p.remoteUrl && parseXPostUrl(p.remoteUrl)) {
				return { url: p.remoteUrl, connectionId: p.connectionId };
			}
		}
		return null;
	}

	/**
	 * A new draft whose text is just the post's link: X shows a post ending in a
	 * link to another post as a quote, and the composer draws it as one.
	 */
	async function quoteOnX(card: Card) {
		const source = quotableX(card);
		if (!source || quoting) return;
		quoting = card.key;
		error = null;
		try {
			const res = await fetch('/api/drafts', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					baseBody: source.url,
					selectedConnectionIds: [source.connectionId]
				})
			});
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(payload.error || 'Could not start a quote');
			const id = payload.draft?.id;
			if (!id) throw new Error('Could not start a quote');
			await goto(`/compose?id=${id}`);
		} catch (e) {
			error = humanizeError(e instanceof Error ? e.message : 'Could not start a quote');
		} finally {
			quoting = null;
		}
	}

	function pickAccount(id: string | null) {
		setAccountFilter(id);
		accountMenuOpen = false;
		accountFilterTrigger?.focus();
	}

	function clearSearch() {
		query = '';
		debouncedQuery = '';
		searchInput?.focus();
	}

	function onWindowClick(event: MouseEvent) {
		if (accountMenuEl && !accountMenuEl.contains(event.target as Node)) accountMenuOpen = false;
	}

	function onWindowKeydown(event: KeyboardEvent) {
		// The action handles Escape while focus is inside the menu (and restores
		// focus); this covers the case where focus has moved elsewhere on the
		// page, so the menu never becomes undismissable.
		if (event.key === 'Escape' && accountMenuOpen) {
			accountMenuOpen = false;
			accountFilterTrigger?.focus();
		}
	}

	/** Single bulk call for a whole card. The server returns per-id results; the
	first failure surfaces exactly like the old serial loop did. */
	async function bulkTargets(
		op: 'cancel' | 'retry' | 'reschedule',
		ids: string[],
		fallback: string,
		draftId: string,
		extra?: Record<string, string>
	): Promise<boolean> {
		setCardError(draftId, null);
		// A rejected fetch (offline, DNS blip) must surface as a banner instead of
		// escaping into the callers, where it skipped the busy reset and left the
		// card's button disabled forever.
		let res: Response;
		try {
			res = await fetch('/api/targets/bulk', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ op, ids, ...extra })
			});
		} catch {
			setCardError(draftId, humanizeError('fetch failed'));
			return false;
		}
		if (sessionExpiredIfUnauthorized(res)) return false;
		const payload = await res.json().catch(() => ({}));
		if (!res.ok) {
			setCardError(draftId, humanizeError(payload.error || fallback));
			return false;
		}
		const failed = (payload.results ?? []).filter((r: { ok: boolean }) => !r.ok) as {
			error?: string;
		}[];
		if (failed.length) {
			setCardError(draftId, humanizeError(failed[0]?.error || fallback));
			return false;
		}
		// A refresh replaces only the first page, and a cancelled row leaves the
		// queue, so a copy kept from an older page or a search would linger.
		if (op === 'cancel') {
			const gone = new Set(ids);
			olderTargets = olderTargets.filter((t) => !gone.has(t.id));
			searchTargets = searchTargets.filter((t) => !gone.has(t.id));
		}
		return true;
	}

	async function confirmCancel() {
		if (!pendingCancel) return;
		const { ids, cardKey, draftId, whole, label } = pendingCancel;
		pendingCancel = null;
		busy = cardKey;
		// finally: the button always comes back, even if the call itself blows up.
		const done = await bulkTargets('cancel', ids, 'Could not cancel', draftId).finally(() => {
			busy = null;
		});
		if (!done) return;
		await load({ keepError: true });
		if (!whole) {
			showToast(`Removed ${label} from this post`);
		} else if (allDrafts.some((d) => d.id === draftId && d.status === 'draft')) {
			showToast('Unscheduled — moved to Drafts', 'success', {
				label: 'Open drafts',
				href: '/posts?tab=drafts'
			});
		} else {
			showToast('Unscheduled');
		}
	}

	// Per-platform retry reuses the same bulk endpoint with a single id, so
	// only that platform's target is reset + republished — published siblings
	// are never touched (server skips rows with remotePostId).
	let busyTarget = $state<string | null>(null);

	async function retryAll(cardKey: string, draftId: string, ids: string[]) {
		if (!ids.length) return;
		busy = cardKey;
		const done = await bulkTargets('retry', ids, 'Retry failed', draftId).finally(() => {
			busy = null;
		});
		await load({ keepError: true });
		if (done) showToast('Sent again');
	}

	async function retryOne(draftId: string, targetId: string) {
		if (!targetId) return;
		busyTarget = targetId;
		const done = await bulkTargets('retry', [targetId], 'Retry failed', draftId).finally(() => {
			busyTarget = null;
		});
		await load({ keepError: true });
		if (done) showToast('Sent again');
	}

	// Per-platform discard reuses the whole-card cancel confirm + bulk
	// endpoint with a single id: cancelling one target never touches its
	// published siblings (server skips rows with remotePostId), and
	// refreshDraftStatus recomputes the card right after.
	function discardOne(card: Card, platform: CardPlatform) {
		if (!platform.targetId) return;
		const name = platform.handle
			? `${platformName(platform.name)} · ${displayHandle(platform.handle)}`
			: platformName(platform.name);
		pendingCancel = {
			ids: [platform.targetId],
			label: name,
			cardKey: card.key,
			draftId: card.draftId,
			whole: false,
			title: `Remove ${platformName(platform.name)} from this post?`,
			confirmLabel: 'Remove'
		};
	}

	async function rescheduleAll(cardKey: string, draftId: string, ids: string[]) {
		if (!ids.length) return;
		// Confirm is disabled for a past time; this catches one that turned past
		// while the panel stood open.
		const runAt = isFutureScheduleValue(rescheduleAt, new Date())
			? scheduleValueToIso(rescheduleAt, new Date())
			: null;
		if (!runAt) {
			setCardError(draftId, 'Pick a time in the future');
			return;
		}
		busy = cardKey;
		const done = await bulkTargets('reschedule', ids, 'Could not reschedule', draftId, {
			runAt
		}).finally(() => {
			busy = null;
		});
		if (done) closeReschedule();
		await load({ keepError: true });
		if (done) showToast(`Rescheduled for ${formatLocalDateTimeWithZone(rescheduleAt)}`);
	}

	let rescheduleTrigger: HTMLElement | null = null;
	function closeReschedule() {
		rescheduleId = null;
		const trigger = rescheduleTrigger;
		rescheduleTrigger = null;
		// The trigger is gone when the card moved; then focus stays where it is.
		if (trigger?.isConnected) trigger.focus();
	}
	/** Focus lands inside the panel, so a keyboard user is where they asked to be. */
	function rescheduleFocus(node: HTMLElement) {
		node.querySelector<HTMLElement>('button, input, select')?.focus();
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			event.stopPropagation();
			closeReschedule();
		};
		node.addEventListener('keydown', onKey);
		return { destroy: () => node.removeEventListener('keydown', onKey) };
	}

	const minRescheduleAt = $derived.by(() => {
		void rescheduleId;
		return minScheduleDatetime(new Date());
	});

	// On a phone the actions sit in their own row under the time, as
	// equal-width pills; from sm up they are text links beside it, where -my-3
	// keeps the 44px target from padding the footer.
	const cardAction =
		'inline-flex min-h-11 flex-1 items-center justify-center rounded-full bg-stone-100 px-3 text-[12px] font-bold whitespace-nowrap transition-colors disabled:opacity-50 sm:-my-3 sm:flex-none sm:bg-transparent sm:px-0';

	function statusBadge(status: string) {
		if (['scheduled', 'pending', 'publishing'].includes(status)) return 'scheduled';
		if (status === 'sending') return 'sending';
		if (status === 'retrying') return 'retrying';
		if (status === 'processing') return 'processing';
		if (status === 'published') return 'published';
		if (status === 'failed') return 'failed';
		return 'draft';
	}

	type CardPlatform = Card['platforms'][number];

	function failedOf(card: Card): CardPlatform[] {
		return card.platforms.filter((p) => p.status === 'failed');
	}

	function retryingOf(card: Card): CardPlatform[] {
		return card.platforms.filter((p) => p.status === 'scheduled' && p.error);
	}
</script>

<svelte:window onclick={onWindowClick} onkeydown={onWindowKeydown} />

<div class="mx-auto flex w-full max-w-2xl flex-1 flex-col">
	<!-- Header -->
	<div class="mb-8 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
		<div>
			<h1 class="text-3xl font-extrabold tracking-tight text-stone-900">Posts</h1>
		</div>

		<!-- Account filter + search -->
		<div class="flex w-full items-center gap-3 md:w-auto">
			{#if accounts.length > 1}
				<div class="relative" bind:this={accountMenuEl}>
					<button
						type="button"
						bind:this={accountFilterTrigger}
						onclick={() => (accountMenuOpen = !accountMenuOpen)}
						aria-haspopup="menu"
						aria-expanded={accountMenuOpen}
						aria-label="Filter posts by account"
						class="flex items-center gap-2 rounded-full border border-stone-200/80 bg-white py-2 pr-3 pl-3.5 text-[12px] font-bold text-stone-700 shadow-sm transition-colors hover:border-stone-300 hover:text-stone-900"
					>
						{#if selectedAccount}
							<SocialIcon platform={selectedAccount.platform} className="h-3.5 w-3.5" />
						{:else}
							<Users class="h-3.5 w-3.5 text-stone-500" />
						{/if}
						<span class="max-w-32 truncate sm:max-w-40"
							>{selectedAccount ? accountFilterLabel(selectedAccount) : 'All accounts'}</span
						>
						<ChevronDown
							class="h-3.5 w-3.5 text-stone-500 transition-transform {accountMenuOpen
								? 'rotate-180'
								: ''}"
						/>
					</button>

					{#if accountMenuOpen}
						<div
							class="absolute top-full left-0 z-30 mt-2 w-64 max-w-[calc(100vw-3rem)] origin-top-left rounded-[1.25rem] border border-stone-200/80 bg-white p-1.5 shadow-[0_16px_40px_-12px_rgb(28_25_23/0.15)] md:right-0 md:left-auto md:origin-top-right"
							role="menu"
							aria-label="Filter by account"
							use:menuNav={{
								trigger: accountFilterTrigger,
								onEscape: () => (accountMenuOpen = false)
							}}
						>
							<button
								type="button"
								role="menuitemradio"
								aria-checked={accountFilter === null}
								onclick={() => pickAccount(null)}
								class="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[13px] font-bold transition-colors {accountFilter ===
								null
									? 'bg-stone-100 text-stone-900'
									: 'text-stone-600 hover:bg-stone-50 hover:text-stone-900'}"
							>
								<Users class="h-4 w-4 shrink-0 text-stone-500" />
								<span class="flex-1 truncate">All accounts</span>
								{#if accountFilter === null}
									<Check class="h-4 w-4 shrink-0 text-stone-900" />
								{/if}
							</button>
							{#each accounts as account (account.id)}
								<button
									type="button"
									role="menuitemradio"
									aria-checked={accountFilter === account.id}
									onclick={() => pickAccount(account.id)}
									class="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[13px] font-bold transition-colors {accountFilter ===
									account.id
										? 'bg-stone-100 text-stone-900'
										: 'text-stone-600 hover:bg-stone-50 hover:text-stone-900'}"
								>
									<SocialIcon platform={account.platform} className="h-4 w-4 shrink-0" />
									<span class="flex-1 truncate">{accountFilterLabel(account)}</span>
									{#if accountFilter === account.id}
										<Check class="h-4 w-4 shrink-0 text-stone-900" />
									{/if}
								</button>
							{/each}
						</div>
					{/if}
				</div>
			{/if}
			<div class="group relative min-w-0 flex-1 sm:flex-none">
				<Search
					class="absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-stone-500 transition-colors group-focus-within:text-stone-900"
				/>
				<input
					type="text"
					placeholder="Search posts..."
					aria-label="Search posts"
					bind:this={searchInput}
					bind:value={query}
					class="w-full rounded-full border border-stone-200/80 bg-white py-2 pr-9 pl-10 text-[13px] font-bold text-stone-900 shadow-sm transition-all placeholder:font-medium placeholder:text-stone-500 focus:border-stone-300 focus:ring-2 focus:ring-stone-200 focus:outline-none sm:w-48 pointer-coarse:text-base"
				/>
				{#if query}
					<button
						type="button"
						onclick={clearSearch}
						aria-label="Clear search"
						class="absolute top-1/2 right-2.5 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
					>
						<X class="h-3.5 w-3.5" />
					</button>
				{/if}
			</div>
		</div>
	</div>

	{#if error}
		<div
			class="mb-4 flex items-center justify-between gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700"
			role="alert"
		>
			<p class="font-medium">{error}</p>
			<span class="flex shrink-0 items-center gap-1">
				<button
					type="button"
					onclick={() => void load()}
					class="rounded-full px-2 py-0.5 text-xs font-bold text-red-700 transition-colors hover:bg-red-100"
				>
					Reload
				</button>
				<button
					type="button"
					onclick={() => {
						error = null;
						// A dismissed banner must not keep suppressing the empty
						// state: the user asked for the page back.
						loadFailed = false;
					}}
					aria-label="Dismiss error"
					class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-red-500 transition-colors hover:bg-red-100 hover:text-red-700"
				>
					<X class="h-3.5 w-3.5" />
				</button>
			</span>
		</div>
	{/if}

	{#if notice}
		<div
			class="mb-4 flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-sm {notice.tone ===
			'warn'
				? 'bg-amber-50 text-amber-900'
				: 'bg-emerald-50 text-emerald-800'}"
			role="status"
			data-testid="posts-notice"
		>
			<p class="font-medium">{notice.message}</p>
			<button
				type="button"
				onclick={() => (notice = null)}
				aria-label="Dismiss notice"
				class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors {notice.tone ===
				'warn'
					? 'text-amber-700 hover:bg-amber-100'
					: 'text-emerald-700 hover:bg-emerald-100'}"
			>
				<X class="h-3.5 w-3.5" />
			</button>
		</div>
	{/if}

	<!-- Tabs: five pills are wider than a phone, so this row swipes instead of
	     stretching the page, with a fade instead of a scrollbar where it is cut
	     off. -mx-6/px-6 keeps the pills in the page gutter. -->
	<div
		bind:this={tabStrip}
		onscroll={updateFades}
		style:mask-image={fadeMask(fadeLeft, fadeRight)}
		style:-webkit-mask-image={fadeMask(fadeLeft, fadeRight)}
		class="-mx-6 mb-6 [scrollbar-width:none] overflow-x-auto px-6 [&::-webkit-scrollbar]:hidden"
	>
		<div class="w-max rounded-xl bg-stone-200/50 p-1">
			<div class="flex" role="group" aria-label="Filter posts by status">
				{#each TAB_VALUES as tab (tab)}
					<a
						href={postsHref({ tab })}
						data-tab={tab}
						data-sveltekit-replacestate
						data-sveltekit-reset="false"
						aria-current={activeTab === tab ? 'page' : undefined}
						class="rounded-lg px-4 py-1.5 text-[13px] font-bold transition-all pointer-coarse:py-2.5 {activeTab ===
						tab
							? 'bg-white text-stone-900 shadow-sm'
							: 'text-stone-500 hover:text-stone-900'}"
					>
						{tab === 'all' ? 'All posts' : tab.charAt(0).toUpperCase() + tab.slice(1)}
						{#if countFor(tab) > 0}
							<span class="ml-1 opacity-50">{countFor(tab)}{moreFor(tab) ? '+' : ''}</span>
						{/if}
					</a>
				{/each}
			</div>
		</div>
	</div>

	<!-- Post Feed -->
	<div class="flex flex-col gap-4">
		{#if loading && visible.length === 0}
			{#each [0, 1, 2] as i (i)}
				<div
					class="flex animate-pulse flex-col rounded-[2rem] border border-stone-200/80 bg-white p-5 sm:p-6"
					aria-hidden="true"
				>
					<div class="mb-4 flex items-center justify-between">
						<div class="h-8 w-24 rounded-full bg-stone-100"></div>
						<div class="h-5 w-20 rounded bg-stone-100"></div>
					</div>
					<div class="mb-2 h-4 w-full rounded bg-stone-100"></div>
					<div class="mb-5 h-4 w-2/3 rounded bg-stone-100"></div>
					<div class="mt-auto border-t border-stone-100 pt-4">
						<div class="h-3 w-40 rounded bg-stone-100"></div>
					</div>
				</div>
			{/each}
		{/if}
		{#each visible as card (card.key)}
			{@const shown = whenDisplay(card.when, now)}
			{@const overdue = card.when != null && toTime(card.when) <= now}
			{@const badge = statusBadge(card.status)}
			<div
				class="flex flex-col rounded-[2rem] border border-stone-200/80 bg-white p-5 shadow-[0_8px_30px_-12px_rgb(28_25_23/0.06)] transition-all hover:border-stone-300 hover:shadow-[0_8px_30px_-12px_rgb(28_25_23/0.1)] sm:p-6"
				data-testid="post-card"
				data-status={card.status}
				data-outcome={card.outcome?.kind}
			>
				<!-- Post Header -->
				<div class="mb-4 flex items-start justify-between">
					<div class="flex items-center gap-2">
						{#each card.platforms as platform, i (platform.targetId || i)}
							{#if platform.remoteUrl}
								<a
									href={platform.remoteUrl}
									target="_blank"
									rel="noopener noreferrer"
									class="flex h-8 w-8 items-center justify-center rounded-full border border-stone-100 bg-stone-50 transition-colors hover:bg-stone-100 hover:shadow-sm"
									title={`View on ${platformName(platform.name)}${
										platform.connectionStatus === 'disconnected' ? ' (account disconnected)' : ''
									}`}
								>
									<SocialIcon
										platform={platform.name}
										className="h-4 w-4 {platformColorClass(platform.name)}"
									/>
								</a>
							{:else}
								<div
									class="flex h-8 w-8 items-center justify-center rounded-full border border-stone-100 bg-stone-50 {platform.status ===
									'failed'
										? 'border-red-200 bg-red-50'
										: platform.status === 'scheduled' && platform.error
											? 'border-amber-200 bg-amber-50'
											: ''}"
									title={platform.error
										? `${platformName(platform.name)}: ${humanizeError(platform.error)}`
										: platform.status || platformName(platform.name)}
								>
									<SocialIcon
										platform={platform.name}
										className="h-4 w-4 {platformColorClass(platform.name)}"
									/>
								</div>
							{/if}
						{/each}
						{#if card.platforms.length === 0}
							<div
								class="flex h-8 w-8 items-center justify-center rounded-full border border-stone-100 bg-stone-50"
							>
								<Pencil class="h-4 w-4 text-stone-500" />
							</div>
						{/if}
					</div>

					<div class="flex items-center gap-3">
						{#if badge === 'scheduled'}
							<span
								class="inline-flex items-center gap-1.5 rounded bg-sky-50 px-2.5 py-1 text-[10px] font-bold tracking-widest text-sky-700 uppercase"
							>
								<CalendarClock class="h-3 w-3" /> Scheduled
							</span>
						{:else if badge === 'published'}
							<span
								class="inline-flex items-center gap-1.5 rounded bg-emerald-50 px-2.5 py-1 text-[10px] font-bold tracking-widest text-emerald-700 uppercase"
							>
								<Send class="h-3 w-3" /> Published
							</span>
						{:else if badge === 'failed' && card.outcome?.kind === 'partial'}
							<span
								class="inline-flex items-center gap-1.5 rounded bg-amber-50 px-2.5 py-1 text-[10px] font-bold tracking-widest text-amber-700 uppercase"
								data-testid="partial-badge"
							>
								<TriangleAlert class="h-3 w-3" /> Partly published
							</span>
						{:else if badge === 'failed'}
							<span
								class="inline-flex items-center gap-1.5 rounded bg-red-50 px-2.5 py-1 text-[10px] font-bold tracking-widest text-red-700 uppercase"
							>
								<XCircle class="h-3 w-3" /> Failed
							</span>
						{:else if badge === 'sending'}
							<span
								class="inline-flex items-center gap-1.5 rounded bg-sky-50 px-2.5 py-1 text-[10px] font-bold tracking-widest text-sky-700 uppercase"
								data-testid="sending-badge"
							>
								<LoaderCircle class="h-3 w-3 animate-spin" /> Sending
							</span>
						{:else if badge === 'processing'}
							<span
								class="inline-flex items-center gap-1.5 rounded bg-sky-50 px-2.5 py-1 text-[10px] font-bold tracking-widest text-sky-700 uppercase"
								title="The platform is processing the video — it publishes on its own"
								data-testid="processing-badge"
							>
								<LoaderCircle class="h-3 w-3" /> Processing
							</span>
						{:else if badge === 'retrying'}
							<span
								class="inline-flex items-center gap-1.5 rounded bg-amber-50 px-2.5 py-1 text-[10px] font-bold tracking-widest text-amber-700 uppercase"
								title="A transient failure backed off — the scheduler will try again automatically"
							>
								<RefreshCw class="h-3 w-3" /> Retrying
							</span>
						{:else}
							<span
								class="inline-flex items-center gap-1.5 rounded bg-stone-100 px-2.5 py-1 text-[10px] font-bold tracking-widest text-stone-500 uppercase"
							>
								<Pencil class="h-3 w-3" /> Draft
							</span>
						{/if}
					</div>
				</div>

				<!-- Post Content -->
				{#if card.posts.length < 2}
					<p
						class="mb-5 text-[14px] leading-relaxed font-medium break-words whitespace-pre-wrap text-stone-800"
					>
						<LinkedText parts={cardParts(card.posts[0].text)} />
					</p>

					{#if card.media.length > 0}
						{@const allValid = card.media.filter((m) => m.storageKey)}
						{#if allValid.length > 0}
							<div class="mb-5" data-testid="post-media-{card.key}">
								<MediaPreview
									items={allValid}
									maxHeight={280}
									extra={Math.max(0, allValid.length - 4)}
								/>
							</div>
						{/if}
					{/if}
				{:else}
					{@const [lead, ...rest] = card.posts}
					{@const open = isThreadOpen(card)}
					{@const leadMedia = lead.media.filter((m) => m.storageKey)}
					{#if lead.text}
						<p
							class="mb-5 text-[14px] leading-relaxed font-medium break-words whitespace-pre-wrap text-stone-800"
						>
							<LinkedText parts={cardParts(lead.text)} />
						</p>
					{/if}
					{#if leadMedia.length > 0}
						<div class="mb-5" data-testid="post-media-{card.key}">
							<MediaPreview
								items={leadMedia}
								maxHeight={280}
								extra={Math.max(0, leadMedia.length - 4)}
							/>
						</div>
					{/if}
					{#if open}
						<ol
							id="thread-{card.key}"
							class="mb-4 ml-1 flex flex-col gap-4 border-l-2 border-stone-200 pl-4"
							data-testid="thread-posts"
						>
							{#each rest as post, i (post.segmentIndex)}
								{@const postMedia = post.media.filter((m) => m.storageKey)}
								<li data-testid="thread-post">
									<p class="mb-1 text-[11px] font-bold text-stone-400 tabular-nums">
										{i + 2}/{card.posts.length}
									</p>
									{#if post.text}
										<p
											class="text-[14px] leading-relaxed font-medium break-words whitespace-pre-wrap text-stone-800"
										>
											<LinkedText parts={cardParts(post.text)} />
										</p>
									{/if}
									{#if postMedia.length > 0}
										<div class="mt-2">
											<MediaPreview
												items={postMedia}
												maxHeight={160}
												extra={Math.max(0, postMedia.length - 4)}
											/>
										</div>
									{/if}
								</li>
							{/each}
						</ol>
					{/if}
					<button
						type="button"
						class="-mx-1 mb-5 flex items-center gap-1 self-start rounded-lg px-1 py-1 text-xs font-bold text-stone-500 transition-colors hover:text-stone-900 focus-visible:ring-2 focus-visible:ring-stone-900/20 focus-visible:outline-none pointer-coarse:py-2"
						aria-expanded={open}
						aria-controls="thread-{card.key}"
						data-testid="thread-toggle"
						onclick={(e) => toggleThread(card, e.currentTarget)}
					>
						<ChevronDown
							class="h-3.5 w-3.5 transition-transform {open ? 'rotate-180' : ''}"
							aria-hidden="true"
						/>
						{open
							? 'Show less'
							: `${rest.length} more ${rest.length === 1 ? 'post' : 'posts'} in this thread`}
					</button>
				{/if}

				{#if failedOf(card).length > 0}
					<div class="mb-4 flex flex-col gap-2 rounded-2xl border border-red-100 bg-red-50/50 p-3">
						{#each failedOf(card) as platform (platform.targetId)}
							{@const reconnect = needsReconnect(platform)}
							<div class="flex items-start justify-between gap-3">
								<p class="text-xs leading-relaxed text-red-700">
									<span class="font-bold">{platformName(platform.name)}</span>
									{#if platform.handle}
										<span class="font-medium opacity-70"> · {displayHandle(platform.handle)}</span>
									{/if}
									<span class="font-medium"> — {humanizeError(platform.error)}</span>
								</p>
								{#if reconnect}
									<div class="flex shrink-0 items-center gap-3">
										<a
											href="/accounts"
											class="-my-3 inline-flex min-h-11 items-center text-[12px] font-bold text-stone-900 underline-offset-2 hover:underline"
										>
											Reconnect
										</a>
										{#if platform.targetId}
											<button
												type="button"
												disabled={busyTarget === platform.targetId || busy === card.key}
												onclick={() => discardOne(card, platform)}
												class="-my-3 inline-flex min-h-11 items-center text-[12px] font-bold text-red-500 underline-offset-2 transition-colors hover:text-red-700 hover:underline disabled:opacity-50"
											>
												Discard
											</button>
										{/if}
									</div>
								{:else if platform.targetId}
									<div class="flex shrink-0 items-center gap-3">
										<button
											type="button"
											disabled={busyTarget === platform.targetId || busy === card.key}
											onclick={() => void retryOne(card.draftId, platform.targetId!)}
											class="-my-3 inline-flex min-h-11 items-center text-[12px] font-bold text-stone-900 underline-offset-2 transition-colors hover:underline disabled:opacity-50"
										>
											{busyTarget === platform.targetId ? 'Retrying…' : 'Retry'}
										</button>
										<button
											type="button"
											disabled={busyTarget === platform.targetId || busy === card.key}
											onclick={() => discardOne(card, platform)}
											class="-my-3 inline-flex min-h-11 items-center text-[12px] font-bold text-red-500 underline-offset-2 transition-colors hover:text-red-700 hover:underline disabled:opacity-50"
										>
											Discard
										</button>
									</div>
								{/if}
							</div>
						{/each}
					</div>
				{:else if retryingOf(card).length > 0}
					<div
						class="mb-4 flex flex-col gap-2 rounded-2xl border border-amber-100 bg-amber-50/60 p-3"
					>
						<p class="text-xs font-bold text-amber-800">
							{retryingOf(card).every((p) => isProcessing(p.error))
								? 'Processing the video — it publishes on its own.'
								: 'Retrying automatically — no action needed, or retry now.'}
						</p>
						{#each retryingOf(card) as platform (platform.targetId)}
							<div class="flex items-start justify-between gap-3">
								<p class="text-xs leading-relaxed text-amber-800">
									<span class="font-bold">{platformName(platform.name)}</span>
									<span class="font-medium"> — {humanizeError(platform.error)}</span>
								</p>
								{#if platform.targetId && !isProcessing(platform.error)}
									<div class="flex shrink-0 items-center gap-3">
										<button
											type="button"
											disabled={busyTarget === platform.targetId || busy === card.key}
											onclick={() => void retryOne(card.draftId, platform.targetId!)}
											class="-my-3 inline-flex min-h-11 items-center text-[12px] font-bold text-stone-900 underline-offset-2 transition-colors hover:underline disabled:opacity-50"
										>
											{busyTarget === platform.targetId ? 'Retrying…' : 'Retry now'}
										</button>
										<button
											type="button"
											disabled={busyTarget === platform.targetId || busy === card.key}
											onclick={() => discardOne(card, platform)}
											class="-my-3 inline-flex min-h-11 items-center text-[12px] font-bold text-red-500 underline-offset-2 transition-colors hover:text-red-700 hover:underline disabled:opacity-50"
										>
											Discard
										</button>
									</div>
								{/if}
							</div>
						{/each}
					</div>
				{:else if card.error}
					<p class="mb-4 text-xs text-red-600">{humanizeError(card.error)}</p>
				{/if}
				{#if cardErrors[card.draftId]}
					<div
						class="mb-4 flex items-start justify-between gap-3 rounded-xl bg-red-50 px-3 py-2"
						role="alert"
						data-testid="card-error"
					>
						<p class="text-[12px] font-bold text-red-700">{cardErrors[card.draftId]}</p>
						<button
							type="button"
							onclick={() => setCardError(card.draftId, null)}
							aria-label="Dismiss"
							class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-red-500 hover:bg-red-100 hover:text-red-700"
						>
							<X class="h-3 w-3" />
						</button>
					</div>
				{/if}

				<!-- Post Footer -->
				<div
					class="mt-auto flex flex-col gap-3 border-t border-stone-100 pt-4 sm:flex-row sm:items-center sm:justify-between"
				>
					<p class="text-[12px] font-bold text-stone-500">
						{#if card.status === 'sending' && card.when}
							Started
							<span class="text-stone-900" title={shown.title}>{shown.text}</span>
						{:else if card.whenLabel === 'scheduled' && card.when && overdue}
							Due
							<span class="text-stone-900" title={shown.title}>{shown.text}</span>
						{:else if card.whenLabel === 'scheduled' && card.when}
							Will publish
							<span class="text-stone-900" title={shown.title}>{shown.text}</span>
						{:else if card.whenLabel === 'published' && card.when && card.outcome?.kind === 'failed'}
							Failed
							<span class="text-stone-900" title={shown.title}>{shown.text}</span>
						{:else if card.whenLabel === 'published' && card.when && card.outcome?.kind === 'partial'}
							Published to {card.outcome.published} of {card.outcome.total} ·
							<span class="text-stone-900" title={shown.title}>{shown.text}</span>
						{:else if card.whenLabel === 'published' && card.when}
							Published
							<span class="text-stone-900" title={shown.title}>{shown.text}</span>
						{:else if card.when}
							Edited
							<span class="text-stone-900" title={shown.title}>{shown.text}</span>
						{/if}
					</p>

					<div class="flex flex-wrap items-center gap-2 sm:flex-nowrap sm:gap-4">
						{#if card.kind === 'draft'}
							<a
								href="/compose?id={card.draftId}"
								class="{cardAction} text-stone-500 hover:text-stone-900"
							>
								Edit post
							</a>
							<button
								type="button"
								disabled={duplicating === card.draftId}
								onclick={() => void duplicateDraft(card.draftId)}
								class="{cardAction} text-stone-500 hover:text-stone-900"
							>
								{duplicating === card.draftId ? 'Duplicating…' : 'Duplicate'}
							</button>
							<button
								type="button"
								onclick={() =>
									(pendingRemove = allDrafts.find((d) => d.id === card.draftId) ?? null)}
								class="{cardAction} text-red-500 hover:text-red-700"
							>
								Remove
							</button>
						{:else if (badge === 'scheduled' || badge === 'retrying' || badge === 'processing') && card.targetId}
							{@const unloaded = unloadedAccounts(card.draftId)}
							<a
								href="/compose?id={card.draftId}"
								class="{cardAction} text-stone-500 hover:text-stone-900"
							>
								Edit post
							</a>
							<!-- A video the platform is processing publishes on its own: nothing to re-time or cancel. -->
							{#if badge !== 'processing' && unloaded > 0}
								<!-- Rescheduling or cancelling what is loaded would leave the rest as it was. -->
								<button
									type="button"
									data-testid="load-rest"
									disabled={loadingOlder}
									onclick={() => void loadRestOf(card.draftId)}
									class="{cardAction} text-stone-900 underline-offset-2 hover:underline"
								>
									{loadingOlder
										? 'Loading…'
										: `Load ${unloaded} more ${unloaded === 1 ? 'account' : 'accounts'}`}
								</button>
							{:else if badge !== 'processing'}
								<button
									type="button"
									onclick={(event) => {
										rescheduleTrigger = event.currentTarget;
										rescheduleId = card.targetId;
										rescheduleMode = 'relative';

										let defaultUnit: 'hours' | 'days' | 'mins';
										let defaultValue: string;
										if (DEFAULT_SCHEDULE_OFFSET.days > 0) {
											defaultUnit = 'days';
											defaultValue = String(DEFAULT_SCHEDULE_OFFSET.days);
										} else if (DEFAULT_SCHEDULE_OFFSET.hours > 0) {
											defaultUnit = 'hours';
											defaultValue = String(DEFAULT_SCHEDULE_OFFSET.hours);
										} else {
											defaultUnit = 'mins';
											defaultValue = String(DEFAULT_SCHEDULE_OFFSET.mins || 1);
										}
										rescheduleRelativeUnit = defaultUnit;
										rescheduleRelativeValue = defaultValue;

										applyRelativeReschedule();
									}}
									class="{cardAction} text-stone-500 hover:text-stone-900"
								>
									Reschedule
								</button>
								<button
									type="button"
									disabled={busy === card.key}
									onclick={() =>
										(pendingCancel = {
											ids: cancelTargetIds(card.platforms),
											label: draftExcerpt(card.body, 60) || 'post',
											cardKey: card.key,
											draftId: card.draftId,
											whole: true
										})}
									class="{cardAction} text-red-500 hover:text-red-700"
								>
									{busy === card.key ? 'Cancelling…' : 'Cancel'}
								</button>
							{/if}
						{:else if badge === 'failed' && card.targetId}
							{@const failedIds = retryTargetIds(card.platforms)}
							{@const cardBusy =
								busy === card.key || (busyTarget !== null && failedIds.includes(busyTarget))}
							<a
								href="/compose?id={card.draftId}"
								class="{cardAction} text-stone-500 hover:text-stone-900"
							>
								Edit & re-draft
							</a>
							<button
								type="button"
								disabled={duplicating === card.draftId}
								onclick={() => void duplicateDraft(card.draftId)}
								class="{cardAction} text-stone-900 underline-offset-2 hover:underline"
							>
								{duplicating === card.draftId ? 'Duplicating…' : 'Post again'}
							</button>
							<button
								type="button"
								disabled={cardBusy || failedIds.length === 0}
								onclick={() => void retryAll(card.key, card.draftId, failedIds)}
								class="{cardAction} text-stone-900 underline-offset-2 hover:underline"
							>
								{cardBusy
									? 'Retrying…'
									: failedIds.length > 1
										? `Retry ${failedIds.length} failed`
										: 'Retry'}
							</button>
						{:else if badge === 'published'}
							{#if quotableX(card)}
								<button
									type="button"
									data-testid="quote-on-x"
									disabled={quoting === card.key}
									onclick={() => void quoteOnX(card)}
									class="{cardAction} text-stone-500 hover:text-stone-900"
									title="Write a new X post that quotes this one"
								>
									{quoting === card.key ? 'Opening…' : 'Quote on X'}
								</button>
							{/if}
							<button
								type="button"
								disabled={duplicating === card.draftId}
								onclick={() => void duplicateDraft(card.draftId)}
								class="{cardAction} text-stone-500 hover:text-stone-900"
							>
								{duplicating === card.draftId ? 'Duplicating…' : 'Post again'}
							</button>
						{/if}
					</div>
				</div>

				{#if rescheduleId === card.targetId && card.targetId}
					{@const rescheduleValid = isFutureScheduleValue(rescheduleAt, new Date(now))}
					<div
						class="mt-3 flex flex-col gap-2"
						role="group"
						aria-label="Reschedule"
						use:rescheduleFocus
					>
						<div class="flex rounded-lg bg-stone-100 p-1">
							<button
								type="button"
								class="flex-1 rounded-md py-1.5 text-[12px] font-bold transition-colors pointer-coarse:py-2.5 {rescheduleMode ===
								'relative'
									? 'bg-white text-stone-900 shadow-sm'
									: 'text-stone-500 hover:text-stone-900'}"
								onclick={() => {
									rescheduleMode = 'relative';
									applyRelativeReschedule();
								}}
							>
								Relative
							</button>
							<button
								type="button"
								class="flex-1 rounded-md py-1.5 text-[12px] font-bold transition-colors pointer-coarse:py-2.5 {rescheduleMode ===
								'absolute'
									? 'bg-white text-stone-900 shadow-sm'
									: 'text-stone-500 hover:text-stone-900'}"
								onclick={() => {
									rescheduleMode = 'absolute';
								}}
							>
								Specific date
							</button>
						</div>

						{#if rescheduleMode === 'relative'}
							<div class="flex flex-col gap-2">
								<span class="text-[10px] font-bold tracking-widest text-stone-500 uppercase"
									>Publish in</span
								>
								<label class="flex items-center gap-2">
									<input
										type="number"
										min="1"
										data-testid="reschedule-offset-value"
										aria-label="Reschedule in amount"
										bind:value={rescheduleRelativeValue}
										oninput={applyRelativeReschedule}
										class="w-20 rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-center text-[13px] font-bold text-stone-900 transition-colors focus:border-stone-400 focus:bg-white focus:outline-none pointer-coarse:text-base"
									/>
									<select
										data-testid="reschedule-offset-unit"
										aria-label="Reschedule in unit"
										bind:value={rescheduleRelativeUnit}
										onchange={applyRelativeReschedule}
										class="flex-1 appearance-none rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-[13px] font-bold text-stone-900 transition-colors focus:border-stone-400 focus:bg-white focus:outline-none pointer-coarse:text-base"
									>
										<option value="mins">Minutes</option>
										<option value="hours">Hours</option>
										<option value="days">Days</option>
									</select>
								</label>
							</div>
						{:else}
							<div class="flex flex-col gap-2">
								<span class="text-[10px] font-bold tracking-widest text-stone-500 uppercase"
									>Publish at</span
								>
								<div class="flex gap-2">
									<input
										type="datetime-local"
										aria-label="New publish time"
										data-testid="reschedule-datetime"
										min={minRescheduleAt}
										bind:value={rescheduleAt}
										class="w-full rounded-xl border border-stone-200/80 bg-stone-50 px-3 py-2 text-sm font-bold text-stone-900 focus:border-stone-400 focus:bg-white focus:outline-none pointer-coarse:text-base"
									/>
								</div>
							</div>
						{/if}
						{#if rescheduleValid}
							<p class="text-[11px] font-bold text-stone-500" data-testid="reschedule-preview">
								Will publish {formatLocalDateTimeWithZone(rescheduleAt)} ({formatRelativeTime(
									rescheduleAt,
									new Date(now)
								)})
							</p>
						{:else}
							<p class="text-[11px] font-bold text-amber-700" data-testid="reschedule-invalid">
								Pick a time in the future
							</p>
						{/if}
						<div class="flex flex-wrap items-center gap-2">
							<button
								type="button"
								onclick={() =>
									void rescheduleAll(card.key, card.draftId, rescheduleTargetIds(card.platforms))}
								disabled={busy === card.key || !rescheduleValid}
								class="rounded-full bg-stone-900 px-4 py-1.5 text-xs font-bold text-white hover:bg-stone-800 disabled:opacity-50 pointer-coarse:min-h-11"
								>Confirm</button
							>
							<button
								type="button"
								onclick={closeReschedule}
								class="rounded-full border border-stone-200 px-4 py-1.5 text-xs font-bold text-stone-500 hover:text-stone-900"
								>Keep</button
							>
						</div>
					</div>
				{/if}
			</div>
		{/each}

		{#if !loading && !loadFailed && !searching && visible.length === 0}
			<div
				class="flex flex-col items-center justify-center rounded-[2rem] border border-dashed border-stone-200/80 bg-white px-4 py-20 text-center"
			>
				<div
					class="mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-stone-100 bg-stone-50 text-stone-500 shadow-sm"
				>
					<CalendarClock class="h-6 w-6" />
				</div>
				<h3 class="mb-2 text-lg font-extrabold tracking-tight text-stone-900">
					{emptyPostsHeading(activeTab)}
				</h3>
				<p class="max-w-sm text-[13px] leading-relaxed font-medium text-stone-500">
					{#if debouncedQuery}
						Nothing matches “{debouncedQuery}”. Try another search.
					{:else if accountFilter}
						No posts for this account. Try another filter or clear it.
					{:else}
						{emptyPostsBody(activeTab)}
					{/if}
				</p>
				{#if debouncedQuery || accountFilter}
					<!-- Nothing to write: the posts exist, the filter hides them. -->
				{:else if activeTab === 'failed'}
					<a
						href={postsHref({ tab: 'scheduled' })}
						class="mt-6 inline-flex rounded-full border border-stone-300 bg-white px-6 py-2.5 text-[13px] font-bold text-stone-900 transition-all hover:bg-stone-100"
						>See scheduled</a
					>
				{:else}
					<a
						href="/compose"
						class="mt-6 inline-flex rounded-full bg-stone-900 px-6 py-2.5 text-[13px] font-bold text-white transition-all hover:bg-stone-800"
						>Start writing</a
					>
				{/if}
			</div>
		{/if}
	</div>

	{#if !loadFailed && moreFor(activeTab) && !debouncedQuery.trim()}
		<div class="mt-5 flex flex-col items-center gap-2">
			<button
				type="button"
				data-testid="load-older"
				onclick={() => void loadOlder()}
				disabled={loadingOlder}
				aria-busy={loadingOlder}
				class="inline-flex items-center gap-2 rounded-full border border-stone-300 bg-white px-5 py-2 text-[13px] font-bold text-stone-900 transition-colors hover:bg-stone-100 disabled:opacity-60 pointer-coarse:min-h-11"
			>
				{#if loadingOlder}<LoaderCircle class="h-4 w-4 animate-spin" />{/if}
				{loadingOlder
					? 'Loading…'
					: activeTab === 'scheduled'
						? 'Load later posts'
						: activeTab === 'all' && queueNext.waiting !== null
							? 'Load more posts'
							: 'Load older posts'}
			</button>
			{#if olderError}
				<p class="text-[12px] font-bold text-red-700" role="alert">{olderError}</p>
			{/if}
		</div>
	{/if}
	{#if searching}
		<p class="mt-5 text-[12px] font-medium text-stone-500" role="status">Searching older posts…</p>
	{:else if searchShown && searchCut}
		<p class="mt-5 text-[12px] font-medium text-stone-500" data-testid="search-cut">
			Showing the first posts that match. Add a word to narrow the search.
		</p>
	{/if}

	{#if visible.length > 0}
		<p class="mt-5 text-[12px] leading-relaxed font-medium text-stone-500">
			Times are local ({localTimezoneShort()}).
		</p>
	{/if}
</div>

<ConfirmDialog
	open={pendingRemove !== null}
	idPrefix="remove-draft-dialog"
	title="Remove this draft?"
	body="Deletes the draft and its uploads."
	confirmLabel="Remove"
	busy={removeBusy}
	onConfirm={() => void confirmRemove()}
	onCancel={() => (pendingRemove = null)}
/>

<ConfirmDialog
	open={pendingCancel !== null}
	idPrefix="cancel-post-dialog"
	title={pendingCancel?.title ?? 'Cancel this scheduled post?'}
	body={pendingCancel ? `“${pendingCancel.label}” won't go out.` : null}
	confirmLabel={pendingCancel?.confirmLabel ?? 'Cancel post'}
	onConfirm={() => void confirmCancel()}
	onCancel={() => (pendingCancel = null)}
/>

{#if pendingDelete}
	<div
		class="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 z-30 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-full border border-stone-200 bg-white px-4 py-2 text-sm text-stone-700 shadow-lg"
		role="status"
	>
		<span>Draft deleted</span>
		<button type="button" onclick={undoDelete} class="font-bold underline">Undo</button>
	</div>
{/if}

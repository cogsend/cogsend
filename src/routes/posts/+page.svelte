<script lang="ts">
	import { onMount } from 'svelte';
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
		Users
	} from '@lucide/svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import { platformColorClass } from '$lib/components/platform-color';
	import SocialIcon from '$lib/components/SocialIcon.svelte';
	import { displayHandle, platformName, platformRank } from '$lib/domain/platforms';
	import { draftExcerpt } from '$lib/domain/excerpt';
	import { safeHttpUrl } from '$lib/domain/links';
	import { parseXPostUrl } from '$lib/domain/x-quote';
	import { humanizeError } from '$lib/domain/human-error';
	import { sessionExpiredIfUnauthorized } from '$lib/components/session-expired';
	import { menuNav } from '$lib/components/menu-nav';
	import {
		formatDayTime,
		formatFullLocalWithZone,
		formatLocalDateTimeWithZone,
		formatRelativeTime,
		localTimezoneShort
	} from '$lib/domain/relative-time';
	import {
		cancelTargetIds,
		emptyPostsBody,
		emptyPostsHeading,
		needsReconnect,
		rescheduleTargetIds,
		retryTargetIds,
		type PostsTab
	} from '$lib/domain/post-actions';
	import {
		DEFAULT_SCHEDULE_OFFSET,
		isFutureScheduleValue,
		minScheduleDatetime,
		offsetToDHM,
		scheduleFromDHM,
		scheduleValueToIso
	} from '$lib/domain/schedule-helpers';
	import { splitThreadSegments } from '$lib/domain/thread-segments';

	type PostMedia = {
		id: string;
		storageKey: string;
		mime: string;
		altText: string | null;
		segmentIndex?: number | null;
		sortOrder?: number | null;
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
		/** Absolute local time + zone, computed once at card build (not per render). */
		whenText: string;
		/** Full local timestamp for the tooltip, computed once at card build. */
		whenTitle: string;
		/** All attachments flattened across thread segments, display-sorted. */
		media: PostMedia[];
		/** Number of thread posts (1 = single post). */
		segmentCount: number;
	};

	const TAB_VALUES: PostsTab[] = ['all', 'scheduled', 'published', 'failed', 'drafts'];
	function initialTab(): PostsTab {
		const tab = page.url.searchParams.get('tab');
		return TAB_VALUES.includes(tab as PostsTab) ? (tab as PostsTab) : 'all';
	}
	let activeTab = $state<PostsTab>(initialTab());
	let accountFilter = $state<string | null>(null);
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
	let draftsHasMore = $state(data.draftsHasMore);
	// svelte-ignore state_referenced_locally
	let queueHasMore = $state(data.queueHasMore);
	// svelte-ignore state_referenced_locally
	let targets = $state<QueueTarget[]>(data.targets);
	// svelte-ignore state_referenced_locally
	let error = $state<string | null>(data.loadFailed ? 'Could not load posts' : null);
	let busy = $state<string | null>(null);
	let pendingCancel = $state<{
		ids: string[];
		label: string;
		cardKey: string;
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
				draftsHasMore = payload.hasMore === true;
			} else {
				failed.push('drafts');
			}
			if (queueRes.ok) {
				const payload = await queueRes.json().catch(() => ({}));
				targets = payload.targets || [];
				queueHasMore = payload.hasMore === true;
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

	function postMediaSrc(m: PostMedia): string {
		const src = `/api/media/${encodeURIComponent(m.storageKey)}`;
		return isPostVideo(m) ? src : `${src}?thumb=1`;
	}

	function isPostVideo(m: PostMedia): boolean {
		return (m.mime || '').toLowerCase().startsWith('video/');
	}

	function whenDisplay(when: string | Date | null | undefined): {
		text: string;
		title: string;
	} {
		if (!when) return { text: '', title: '' };
		const d = new Date(when);
		if (Number.isNaN(d.getTime())) return { text: '', title: '' };
		// The zone is named once under the list, so a card stays one short line
		// on a phone; the tooltip keeps the full timestamp with it.
		return {
			text: `${formatRelativeTime(d)} · ${formatDayTime(d)}`,
			title: formatFullLocalWithZone(d)
		};
	}

	function threadSegmentCount(body: string): number {
		try {
			return Math.max(1, splitThreadSegments(body ?? '').length);
		} catch {
			return 1;
		}
	}

	function draftCards(): Card[] {
		return drafts
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
					whenText: whenDisplay(d.updatedAt).text,
					whenTitle: whenDisplay(d.updatedAt).title,
					media: sortPostMedia(d.media),
					segmentCount: threadSegmentCount(body)
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
			const hasRetrying = group.some((t) => t.status === 'scheduled' && t.errorMessage);
			const cardStatus = hasFailed ? 'failed' : hasRetrying ? 'retrying' : primary.status;

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
			const whenShown = whenDisplay(when);
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
				platforms,
				// Fallbacks in case we need a general error
				remoteUrl: safeHttpUrl(primary.remoteUrl),
				error: hasFailed
					? group.find((t) => t.status === 'failed')?.errorMessage || 'Failed on some platforms'
					: null,
				draftId: primary.draft.id,
				targetId: primary.id,
				whenText: whenShown.text,
				whenTitle: whenShown.title,
				media: sortPostMedia(primary.draft.media),
				segmentCount: threadSegmentCount(body)
			};
		});
	}

	const upcoming = $derived(
		targets.filter((t) => ['scheduled', 'pending', 'publishing'].includes(t.status))
	);
	const history = $derived(
		targets.filter((t) => ['published', 'failed', 'cancelled'].includes(t.status))
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

	const cards = $derived.by(() => {
		if (activeTab === 'scheduled') return upcomingCards;
		if (activeTab === 'published') return historyCards;
		if (activeTab === 'failed') return failedCards;
		if (activeTab === 'drafts') return draftsOnlyCards;
		return [...upcomingCards, ...historyCards, ...draftsOnlyCards];
	});

	// A filter whose account no longer has any loaded posts (e.g. its last
	// card was cancelled) would strand the list on an empty state with no chip
	// left to clear. Drop the filter when the account disappears.
	$effect(() => {
		if (accountFilter && !accounts.some((a) => a.id === accountFilter)) accountFilter = null;
	});

	const visible = $derived.by(() => {
		const q = debouncedQuery.trim().toLowerCase();
		const list = cards.filter((c) => {
			if (accountFilter && !c.platforms.some((p) => p.connectionId === accountFilter)) return false;
			return !q || c.body.toLowerCase().includes(q);
		});
		// Newest first on every tab.
		list.sort((a, b) => b.sortKey - a.sortKey);
		return list;
	});

	function countFor(tab: PostsTab): number {
		if (tab === 'scheduled') return upcomingCards.length;
		if (tab === 'published') return historyCards.length;
		if (tab === 'failed') return failedCards.length;
		if (tab === 'drafts') return draftsOnlyCards.length;
		return upcomingCards.length + historyCards.length + draftsOnlyCards.length;
	}

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
		if (drafts.some((d) => d.id === draft.id)) return;
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
		accountFilter = id;
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
		extra?: Record<string, string>
	): Promise<boolean> {
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
			error = humanizeError('fetch failed');
			return false;
		}
		const payload = await res.json().catch(() => ({}));
		if (!res.ok) {
			error = humanizeError(payload.error || fallback);
			return false;
		}
		const failed = (payload.results ?? []).filter((r: { ok: boolean }) => !r.ok) as {
			error?: string;
		}[];
		if (failed.length) {
			error = humanizeError(failed[0]?.error || fallback);
			return false;
		}
		return true;
	}

	async function confirmCancel() {
		if (!pendingCancel) return;
		const ids = pendingCancel.ids;
		const cardKey = pendingCancel.cardKey;
		pendingCancel = null;
		busy = cardKey;
		error = null;
		// finally: the button always comes back, even if the call itself blows up.
		const done = await bulkTargets('cancel', ids, 'Could not cancel').finally(() => {
			busy = null;
		});
		if (done) await load({ keepError: true });
	}

	// Per-platform retry reuses the same bulk endpoint with a single id, so
	// only that platform's target is reset + republished — published siblings
	// are never touched (server skips rows with remotePostId).
	let busyTarget = $state<string | null>(null);

	async function retryAll(cardKey: string, ids: string[]) {
		if (!ids.length) return;
		busy = cardKey;
		error = null;
		await bulkTargets('retry', ids, 'Retry failed').finally(() => {
			busy = null;
		});
		await load({ keepError: true });
	}

	async function retryOne(targetId: string) {
		if (!targetId) return;
		busyTarget = targetId;
		error = null;
		await bulkTargets('retry', [targetId], 'Retry failed').finally(() => {
			busyTarget = null;
		});
		await load({ keepError: true });
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
			title: `Remove ${platformName(platform.name)} from this post?`,
			confirmLabel: 'Remove'
		};
	}

	async function rescheduleAll(cardKey: string, ids: string[]) {
		if (!ids.length) return;
		if (!isFutureScheduleValue(rescheduleAt, new Date())) {
			error = 'Pick a time in the future';
			return;
		}
		const runAt = scheduleValueToIso(rescheduleAt, new Date());
		if (!runAt) {
			error = 'Pick a time in the future';
			return;
		}
		busy = cardKey;
		error = null;
		const done = await bulkTargets('reschedule', ids, 'Could not reschedule', { runAt }).finally(
			() => {
				busy = null;
			}
		);
		if (done) rescheduleId = null;
		await load({ keepError: true });
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
		if (status === 'retrying') return 'retrying';
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
			<p class="text-[11px] font-bold tracking-widest text-stone-500 uppercase">Library</p>
			<h1 class="mt-2 text-3xl font-extrabold tracking-tight text-stone-900">Posts</h1>
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
					Retry
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

	<!-- Tabs: five pills are wider than a phone, so this row swipes instead of
	     stretching the page. -mx-6/px-6 keeps the pills in the page gutter. -->
	<div class="-mx-6 mb-6 scrollbar-thin overflow-x-auto px-6">
		<div class="w-max rounded-xl bg-stone-200/50 p-1">
			<div class="flex" role="group" aria-label="Filter posts by status">
				{#each ['all', 'scheduled', 'published', 'failed', 'drafts'] as tab (tab)}
					<button
						type="button"
						aria-pressed={activeTab === tab}
						aria-current={activeTab === tab ? 'page' : undefined}
						onclick={() => (activeTab = tab as typeof activeTab)}
						class="rounded-lg px-4 py-1.5 text-[13px] font-bold capitalize transition-all {activeTab ===
						tab
							? 'bg-white text-stone-900 shadow-sm'
							: 'text-stone-500 hover:text-stone-900'}"
					>
						{tab === 'all' ? 'All Posts' : tab}
						{#if countFor(tab as typeof activeTab) > 0}
							<span class="ml-1 opacity-50">{countFor(tab as typeof activeTab)}</span>
						{/if}
					</button>
				{/each}
			</div>
		</div>
	</div>

	{#if draftsHasMore && (activeTab === 'drafts' || activeTab === 'all')}
		<p class="mb-4 text-[12px] font-bold text-stone-500">Showing the 200 most recent drafts.</p>
	{/if}
	{#if queueHasMore && (activeTab === 'scheduled' || activeTab === 'published' || activeTab === 'failed' || activeTab === 'all')}
		<p class="mb-4 text-[12px] font-bold text-stone-500">
			Showing the 100 most recent scheduled and published posts.
		</p>
	{/if}

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
			{@const badge = statusBadge(card.status)}
			<div
				class="flex flex-col rounded-[2rem] border border-stone-200/80 bg-white p-5 shadow-[0_8px_30px_-12px_rgb(28_25_23/0.06)] transition-all hover:border-stone-300 hover:shadow-[0_8px_30px_-12px_rgb(28_25_23/0.1)] sm:p-6"
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
						{:else if badge === 'failed'}
							<span
								class="inline-flex items-center gap-1.5 rounded bg-red-50 px-2.5 py-1 text-[10px] font-bold tracking-widest text-red-700 uppercase"
							>
								<XCircle class="h-3 w-3" /> Failed
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
				<p
					class="mb-5 text-[14px] leading-relaxed font-medium break-words whitespace-pre-wrap text-stone-800"
				>
					{draftExcerpt(card.body, 500)}
				</p>

				{#if card.media.length > 0}
					{@const allValid = card.media.filter((m) => m.storageKey)}
					{@const preview = allValid.slice(0, 4)}
					{@const extraCount = allValid.length - preview.length}
					{#if preview.length > 0}
						<div class="mb-5" data-testid="post-media-{card.key}">
							<div class="flex flex-wrap gap-2">
								{#each preview as m, i (m.id)}
									<div
										class="relative h-20 w-20 overflow-hidden rounded-xl border border-stone-200/80 bg-white"
									>
										{#if isPostVideo(m)}
											<!-- svelte-ignore a11y_media_has_caption -->
											<video
												src={postMediaSrc(m)}
												controls
												preload="none"
												playsinline
												width="80"
												height="80"
												aria-label={m.altText || `Attached video ${i + 1}`}
												class="h-20 w-20 bg-black object-cover"
											></video>
										{:else}
											<img
												src={postMediaSrc(m)}
												alt={m.altText || `Attached image ${i + 1}`}
												loading="lazy"
												decoding="async"
												width="80"
												height="80"
												class="h-20 w-20 object-cover"
											/>
										{/if}
										{#if i === preview.length - 1 && extraCount > 0}
											<div
												class="pointer-events-none absolute inset-0 flex items-center justify-center bg-stone-900/60 text-sm font-extrabold text-white"
												role="img"
												aria-label={`${extraCount} more attachment${extraCount === 1 ? '' : 's'}`}
											>
												+{extraCount}
											</div>
										{/if}
									</div>
								{/each}
							</div>
							{#if card.segmentCount > 1}
								<p class="mt-2 text-[11px] font-bold text-stone-500">
									Thread · {card.segmentCount} posts · images combined
								</p>
							{/if}
						</div>
					{/if}
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
											onclick={() => void retryOne(platform.targetId!)}
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
							Retrying automatically — no action needed, or retry now.
						</p>
						{#each retryingOf(card) as platform (platform.targetId)}
							<div class="flex items-start justify-between gap-3">
								<p class="text-xs leading-relaxed text-amber-800">
									<span class="font-bold">{platformName(platform.name)}</span>
									<span class="font-medium"> — {humanizeError(platform.error)}</span>
								</p>
								{#if platform.targetId}
									<div class="flex shrink-0 items-center gap-3">
										<button
											type="button"
											disabled={busyTarget === platform.targetId || busy === card.key}
											onclick={() => void retryOne(platform.targetId!)}
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
				<!-- remoteUrl removed in favor of clickable platform icons -->

				<!-- Post Footer -->
				<div
					class="mt-auto flex flex-col gap-3 border-t border-stone-100 pt-4 sm:flex-row sm:items-center sm:justify-between"
				>
					<p class="text-[12px] font-bold text-stone-500">
						{#if card.whenLabel === 'scheduled' && card.when}
							Will publish
							<span class="text-stone-900" title={card.whenTitle}>{card.whenText}</span>
						{:else if card.whenLabel === 'published' && card.when}
							Published
							<span class="text-stone-900" title={card.whenTitle}>{card.whenText}</span>
						{:else if card.when}
							Edited
							<span class="text-stone-900" title={card.whenTitle}>{card.whenText}</span>
						{/if}
					</p>

					<div class="flex flex-wrap items-center gap-2 sm:flex-nowrap sm:gap-4">
						{#if card.kind === 'draft'}
							<a
								href="/compose?id={card.draftId}"
								class="{cardAction} text-stone-500 hover:text-stone-900"
							>
								Edit Post
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
								onclick={() => (pendingRemove = drafts.find((d) => d.id === card.draftId) ?? null)}
								class="{cardAction} text-red-500 hover:text-red-700"
							>
								Remove
							</button>
						{:else if (badge === 'scheduled' || badge === 'retrying') && card.targetId}
							<a
								href="/compose?id={card.draftId}"
								class="{cardAction} text-stone-500 hover:text-stone-900"
							>
								Edit Post
							</a>
							<button
								type="button"
								onclick={() => {
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
										cardKey: card.key
									})}
								class="{cardAction} text-red-500 hover:text-red-700"
							>
								{busy === card.key ? 'Cancelling…' : 'Cancel'}
							</button>
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
								onclick={() => void retryAll(card.key, failedIds)}
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
					{@const rescheduleValid = isFutureScheduleValue(rescheduleAt, new Date())}
					<div class="mt-3 flex flex-col gap-2">
						<div class="flex rounded-lg bg-stone-100 p-1">
							<button
								type="button"
								class="flex-1 rounded-md py-1.5 text-[12px] font-bold transition-colors {rescheduleMode ===
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
								class="flex-1 rounded-md py-1.5 text-[12px] font-bold transition-colors {rescheduleMode ===
								'absolute'
									? 'bg-white text-stone-900 shadow-sm'
									: 'text-stone-500 hover:text-stone-900'}"
								onclick={() => {
									rescheduleMode = 'absolute';
								}}
							>
								Specific Date
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
									rescheduleAt
								)})
							</p>
						{/if}
						<div class="flex flex-wrap items-center gap-2">
							<button
								type="button"
								onclick={() => void rescheduleAll(card.key, rescheduleTargetIds(card.platforms))}
								disabled={busy === card.key}
								class="rounded-full bg-stone-900 px-4 py-1.5 text-xs font-bold text-white hover:bg-stone-800"
								>Confirm</button
							>
							<button
								type="button"
								onclick={() => (rescheduleId = null)}
								class="rounded-full border border-stone-200 px-4 py-1.5 text-xs font-bold text-stone-500 hover:text-stone-900"
								>Keep</button
							>
						</div>
					</div>
				{/if}
			</div>
		{/each}

		{#if !loading && !loadFailed && visible.length === 0}
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
				{#if !debouncedQuery}
					<a
						href="/compose"
						class="mt-6 inline-flex rounded-full bg-stone-900 px-6 py-2.5 text-[13px] font-bold text-white transition-all hover:bg-stone-800"
						>Start Writing</a
					>
				{/if}
			</div>
		{/if}
	</div>

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

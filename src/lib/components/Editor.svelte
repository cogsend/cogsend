<script lang="ts">
	import { beforeNavigate, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import {
		Image as ImageIcon,
		Trash2,
		Calendar,
		Send,
		Check,
		X,
		TriangleAlert,
		ChevronUp,
		Plus,
		Link2Off,
		Settings,
		LoaderCircle,
		RefreshCw,
		User
	} from '@lucide/svelte';
	import { slide, fly } from 'svelte/transition';
	import {
		PLATFORM_LIMITS,
		isOverSelectedPlatformLimit,
		platformLimit
	} from '$lib/domain/editor-limits';
	import { humanizeError } from '$lib/domain/human-error';
	import { dialogFocus } from '$lib/components/dialog-focus';
	import { initialsOf } from '$lib/components/initials';
	import { platformColorClass } from '$lib/components/platform-color';
	import {
		BLUESKY_MAX_IMAGE_BYTES,
		LINKEDIN_MAX_IMAGES,
		LINKEDIN_MAX_IMAGE_BYTES,
		THREADS_MAX_IMAGE_BYTES,
		X_MAX_GIF_BYTES,
		X_MAX_IMAGE_BYTES,
		groupMediaBySegment,
		mediaSizeProblem,
		remapSegmentIndexAfterRemoval
	} from '$lib/domain/media-limits';
	import { shrinkToFit } from '$lib/components/shrink-image';
	import { persistMediaLayout, type MediaMove } from '$lib/domain/media-sync';
	import {
		customizePlatformBody,
		effectivePlatformBody,
		isPlatformCustomized,
		overridesFromVariants,
		platformsFromConnections,
		resetPlatformToFollow,
		resolveRestoredSelection,
		resolveSavedSelection,
		customizedBodiesForSave,
		type PlatformId,
		type PlatformOverrideMap
	} from '$lib/domain/platform-sync';
	import {
		supportsThreads,
		accountLabel,
		displayHandle,
		platformName,
		platformRank,
		PLATFORM_ORDER
	} from '$lib/domain/platforms';
	import { parsePollConfig, validatePollConfig, type PollConfig } from '$lib/domain/poll';
	import type { ProfileSettings } from '$lib/domain/profile-settings';
	import {
		DEFAULT_SCHEDULE_OFFSET,
		earliestFutureScheduleValue,
		isFutureScheduleValue,
		minScheduleDatetime,
		offsetToDHM,
		scheduleFromDHM,
		schedulePreviewText,
		scheduleValueToIso
	} from '$lib/domain/schedule-helpers';
	import { localTimezoneShort } from '$lib/domain/relative-time';
	import { splitLongText } from '$lib/domain/text-split';
	import {
		addSegment,
		flattenThreadBody,
		joinThreadSegments,
		maxThreadSegmentLength,
		remapSegmentIndexAfterInsert,
		remapSegmentIndexAfterReorder,
		removeSegment,
		reorderSegments,
		splitAtMarkers,
		splitThreadSegments,
		updateSegment
	} from '$lib/domain/thread-segments';
	import {
		countGraphemes,
		mastodonWeightedLength,
		xWeightedLength
	} from '$lib/domain/validation/text';
	import { utf8ByteLength } from '$lib/domain/bytes';
	import SocialIcon from './SocialIcon.svelte';
	import LinkPreview from './LinkPreview.svelte';
	import AccountAvatar from './AccountAvatar.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';

	type Connection = {
		id: string;
		platform: string;
		handle: string | null;
		displayName: string | null;
		avatarUrl?: string | null;
		status?: string;
		metaJson?: { maxCharacters?: number };
	};

	type MediaItem = {
		id: string;
		storageKey: string;
		mime: string;
		size?: number;
		altText: string | null;
		segmentIndex?: number;
		previewUrl?: string;
	};

	type ActiveTab = 'global' | PlatformId;

	// One row per destination while a publish runs (and afterwards, when some
	// destination failed, so the popover can keep showing the error).
	type DestinationProgress = {
		connectionId: string;
		// `retrying` = a retryable failure the scheduler will attempt again
		// automatically; the target is `scheduled` with an error, not failed.
		status: 'pending' | 'published' | 'failed' | 'publishing' | 'retrying';
		error?: string | null;
	};

	type EditorDraft = {
		id: string;
		baseBody?: string | null;
		selectedConnectionIds?: string[] | null;
		variants?: Array<{
			platform: string;
			body?: string | null;
			optionsJson?: { visibility?: string; spoilerText?: string; poll?: unknown };
		}>;
		media?: MediaItem[];
		targets?: Array<{ connectionId?: string | null; scheduledFor?: unknown }>;
	};

	let {
		initialConnections = [],
		initialSettings = null,
		initialDraft = null,
		displayName = null,
		videoEnabled = false
	}: {
		initialConnections?: Connection[];
		initialSettings?: ProfileSettings | null;
		initialDraft?: EditorDraft | null;
		displayName?: string | null;
		/** In-progress LinkedIn video uploads; the server decides, this is the affordance. */
		videoEnabled?: boolean;
	} = $props();

	// The open draft is rendered with the page. A later id change still fetches.
	function openedDraft(): EditorDraft | null {
		const id = page.url.searchParams.get('id');
		if (!initialDraft || !id || initialDraft.id !== id) return null;
		return initialDraft;
	}
	const seededDraft = openedDraft();
	const seededBody = seededDraft?.baseBody || '';
	const seededOverrides = seededDraft
		? overridesFromVariants(
				(seededDraft.variants || []).map((variant) => ({
					platform: variant.platform,
					body: variant.body ?? null
				})),
				seededBody
			)
		: {};
	const seededMedia = (seededDraft?.media || []).map((m) => ({
		...m,
		segmentIndex: m.segmentIndex ?? 0
	}));
	// svelte-ignore state_referenced_locally
	let seededVisibility = initialSettings?.mastoVisibility ?? 'public';
	let seededCw = '';
	let seededPoll: PollConfig | null = null;
	for (const variant of seededDraft?.variants || []) {
		if (variant.platform === 'mastodon' && variant.optionsJson) {
			const visibility = variant.optionsJson.visibility;
			if (
				visibility === 'public' ||
				visibility === 'unlisted' ||
				visibility === 'private' ||
				visibility === 'direct'
			) {
				seededVisibility = visibility;
			}
			if (variant.optionsJson.spoilerText) seededCw = variant.optionsJson.spoilerText;
			if (variant.optionsJson.poll) seededPoll = parsePollConfig(variant.optionsJson.poll);
		}
	}
	const seededSelection = (() => {
		const saved = seededDraft?.selectedConnectionIds;
		if (Array.isArray(saved)) return saved;
		const targetIds = (seededDraft?.targets || [])
			.map((t) => t.connectionId)
			.filter((id): id is string => Boolean(id));
		return targetIds.length ? targetIds : null;
	})();

	/** What the file picker accepts, and what a drop is filtered down to. */
	const ACCEPTED_MEDIA = $derived(
		videoEnabled
			? 'image/png,image/jpeg,image/webp,image/gif,video/mp4'
			: 'image/png,image/jpeg,image/webp,image/gif'
	);

	const SKIP_ASK_KEY = 'cogsend-skip-publish-confirm';

	let draftId = $state<string | null>(page.url.searchParams.get('id'));
	let baseBody = $state(seededBody);
	let activeTab = $state<ActiveTab>('global');
	let overrides = $state<PlatformOverrideMap>(seededOverrides);
	// Snapshot on purpose: the server-rendered list paints first; the client
	// refresh replaces it via loadConnections().
	// svelte-ignore state_referenced_locally
	let connections = $state<Connection[]>(initialConnections);
	let selected = $state<Set<string>>(new Set());
	let media = $state<MediaItem[]>(seededMedia);
	let saving = $state(false);
	let publishing = $state(false);
	// Single toast. Success auto-dismisses; problems stay until
	// replaced so failures are never missed.
	let toastMessage = $state('');
	let toastTone = $state<'success' | 'error' | 'warn'>('success');
	let toastAction = $state<{ label: string; href: string } | null>(null);
	let toastTimer: ReturnType<typeof setTimeout> | null = null;
	let scheduleOpen = $state(false);
	let schedDate = $state('');
	let schedTime = $state('');
	// The loaded draft's existing schedule (datetime-local, earliest future
	// target time) or null. openSchedule() starts from it instead of the
	// fresh-post default while it is still in the future.
	let loadedSchedule = $state<string | null>(
		earliestFutureScheduleValue(seededDraft?.targets, new Date())
	);
	// Set when the user changes a schedule control. Kept apart from `dirty`
	// (body/selection autosave) so a draft response landing mid-edit cannot
	// replace a schedule the user already picked.
	let scheduleTouched = $state(false);
	// Snapshot on purpose: defaults apply to a fresh editor only.
	let mastoVisibility = $state(seededVisibility);
	let mastoCW = $state(seededCw);
	let mastoPoll = $state<PollConfig | null>(seededPoll);
	let focusedSegment = $state(0);
	let uploadingSegment = $state<number | null>(null);
	let dirty = $state(false);
	// URL id of a draft whose load is in flight. Autosave waits for it so a
	// keystroke typed during a slow load cannot create a second draft.
	let loadingDraftId = $state<string | null>(null);
	// Set when a draft fetch fails: while it is non-null every save path stays
	// off, so an editor that never received the stored copy cannot PATCH an
	// empty (or partial) body over it. Cleared by a successful load.
	let loadFailedId = $state<string | null>(null);
	// Serial queue of media-layout writes (see queueMediaSync). Publish awaits
	// it because the stored segmentIndex — not the optimistic UI order — is
	// what the provider attaches images by.
	let mediaSync: Promise<void> = Promise.resolve();
	// Cleared only by a save that succeeds: the autosave keeps retrying a failed
	// save, and the status must not flicker back to "Saving…" on every attempt.
	let saveFailed = $state(false);
	// What the split Publish button is busy with (drives its label + spinner).
	let busyAction = $state<'publish' | 'schedule' | null>(null);
	// Per-destination publish progress shown inside the confirm popover.
	let publishProgress = $state<DestinationProgress[] | null>(null);
	// Quick publishes should not flash "Publishing…": the button only turns
	// busy after a short delay, once the work is actually slow.
	let publishBusyVisible = $state(false);
	let publishBusyTimer: ReturnType<typeof setTimeout> | null = null;
	// The popover closes while publishing, so completion is announced to
	// screen readers through this live region.
	let publishAnnouncement = $state('');
	let announceTimer: ReturnType<typeof setTimeout> | null = null;
	// Platforms with a persisted variant row. A save only DELETEs rows that
	// exist instead of firing a DELETE for every platform on every save.
	let storedVariants = new Set<PlatformId>(
		(seededDraft?.variants || []).map((v) => v.platform as PlatformId)
	);
	let reconnecting = $state<string | null>(null);
	let didInitSelection = false;
	let savedSnapshot = $state<string | null>(null);
	let pendingSelected: string[] | null = seededSelection;
	// True only when the user changed the account selection (never when the
	// editor initializes or restores one). Used to decide whether an in-flight
	// draft load may overwrite the current selection.
	let selectionTouched = false;
	let skipAsk = $state(false);
	// Dropdowns
	let isAccountsPopoverOpen = $state(false);
	let isPostConfirmOpen = $state(false);
	let publishNowBtn: HTMLButtonElement | null = $state(null);
	let isAddOverrideOpen = $state(false);
	let isMastoOptionsOpen = $state(false);
	let fileRefs = $state<(HTMLInputElement | null)[]>([]);
	let textareaRefs = $state<(HTMLTextAreaElement | null)[]>([]);
	let altOpen = $state<Record<string, boolean>>({});

	onMount(() => {
		try {
			skipAsk = localStorage.getItem(SKIP_ASK_KEY) === '1';
		} catch {
			// storage unavailable: defaults hold
		}
	});

	function setLocalFlag(key: string, on: boolean) {
		try {
			if (on) localStorage.setItem(key, '1');
			else localStorage.removeItem(key);
		} catch {
			// prefs are cosmetic
		}
	}

	function showToast(
		message: string,
		tone: 'success' | 'error' | 'warn' = 'success',
		action?: { label: string; href: string } | null
	) {
		if (toastTimer) {
			clearTimeout(toastTimer);
			toastTimer = null;
		}
		toastMessage = message;
		toastTone = tone;
		toastAction = action ?? null;
		// Success and warning nudges dismiss themselves; real failures stick
		// around with a close button so they are never missed.
		const dismissMs = tone === 'success' ? 5000 : tone === 'warn' ? 5000 : 0;
		if (dismissMs > 0) {
			toastTimer = setTimeout(() => {
				toastMessage = '';
				toastAction = null;
				toastTimer = null;
			}, dismissMs);
		}
	}

	function dismissToast() {
		if (toastTimer) {
			clearTimeout(toastTimer);
			toastTimer = null;
		}
		toastMessage = '';
		toastAction = null;
	}

	/**
	 * The strictest limit among the accounts a post can actually reach. Callers
	 * pass the *selected* accounts: using everything connected let an unselected
	 * 200-character Mastodon instance cap a post bound for a 500-character one,
	 * which blocked text the target would have accepted.
	 */
	function platformMax(platform: PlatformId, list: Connection[]): number {
		return platformLimit(platform, list);
	}

	/** Selected accounts on one platform — what a tab or the global composer can
	 *  reach. Falls back to every connected account when nothing is selected, so
	 *  the limit is never accidentally the most permissive one. */
	function accountsFor(platform: PlatformId): Connection[] {
		const selected = selectedAccounts.filter((c) => c.platform === platform);
		return selected.length ? selected : connections.filter((c) => c.platform === platform);
	}

	const connectedPlatforms = $derived(platformsFromConnections(connections));
	const sortedConnections = $derived(
		[...connections].sort((a, b) => {
			const pa = platformRank(a.platform);
			const pb = platformRank(b.platform);
			if (pa !== pb) return pa - pb;
			const na = (a.displayName || a.handle || '').toLowerCase();
			const nb = (b.displayName || b.handle || '').toLowerCase();
			if (na !== nb) return na < nb ? -1 : 1;
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		})
	);
	const selectedAccounts = $derived(sortedConnections.filter((c) => selected.has(c.id)));
	// An override only makes sense with more than one selected account: the
	// Global body already is that platform's body when it is the only pick.
	const canAddOverride = $derived(
		selectedAccounts.length > 1 &&
			selectedAccounts.some((a) => !isPlatformCustomized(overrides, a.platform as PlatformId))
	);
	// Tabs: Global plus one pill per customized platform.
	const tabs = $derived<ActiveTab[]>([
		'global',
		...connectedPlatforms.filter((p) => isPlatformCustomized(overrides, p))
	]);

	function representativeAccount(platform: PlatformId): Connection | undefined {
		return (
			selectedAccounts.find((c) => c.platform === platform) ??
			sortedConnections.find((c) => c.platform === platform)
		);
	}

	// Without a picture the card shows initials (drawn here, never fetched).
	const avatarSrc = $derived.by((): string | null => {
		const globalAvatar = initialSettings?.profilePictureUrl || null;
		if (activeTab === 'global') return globalAvatar;
		const platformAvatar = selectedAccounts.find((c) => c.platform === activeTab)?.avatarUrl;
		return platformAvatar || globalAvatar;
	});
	let failedAvatarSrc = $state<string | null>(null);
	const avatarInitials = $derived(displayName?.trim() ? initialsOf(displayName) : '');

	const selectedPlatforms = $derived(
		new Set(connections.filter((c) => selected.has(c.id)).map((c) => c.platform))
	);

	// Global is held to the strictest limit among the selected accounts, and is
	// counted the way that platform counts: a gauge in graphemes next to X's
	// weighted limit could read green while publishing was blocked.
	const globalLimit = $derived.by((): { platform: string; max: number } => {
		let strictest: { platform: string; max: number } | null = null;
		for (const platform of PLATFORM_ORDER) {
			if (!selectedPlatforms.has(platform)) continue;
			const max = platformMax(platform, accountsFor(platform));
			if (!strictest || max < strictest.max) strictest = { platform, max };
		}
		return strictest ?? { platform: 'generic', max: PLATFORM_LIMITS.x };
	});

	let maxChars = $derived(
		activeTab === 'global' ? globalLimit.max : platformMax(activeTab, accountsFor(activeTab))
	);

	// On Global the thread affordance follows the destinations: with only
	// single-post platforms selected (LinkedIn), a thread has nowhere to go.
	let tabSupportsThreads = $derived(
		activeTab === 'global'
			? [...selectedPlatforms].some((p) => supportsThreads(p))
			: supportsThreads(activeTab)
	);

	function countForPlatform(text: string, platform: string): number {
		if (platform === 'mastodon') return mastodonWeightedLength(text);
		if (platform === 'x') return xWeightedLength(text);
		return countGraphemes(text);
	}

	let activeContent = $derived.by(() => {
		if (activeTab === 'global') return baseBody;
		const body = effectivePlatformBody(baseBody, overrides, activeTab);
		// Single-post platforms (LinkedIn) always show the flattened result:
		// that is exactly what publish will send, customized or not.
		if (!supportsThreads(activeTab)) return flattenThreadBody(body);
		return body;
	});

	let segments = $derived(splitThreadSegments(activeContent));

	// Publish-time validation across the SELECTED platforms (unchanged rules).
	const counters = $derived.by(() => {
		const bskyText = effectivePlatformBody(baseBody, overrides, 'bluesky');
		const mastoText = effectivePlatformBody(baseBody, overrides, 'mastodon');
		const linkedinText = effectivePlatformBody(baseBody, overrides, 'linkedin');
		const threadsText = effectivePlatformBody(baseBody, overrides, 'threads');
		const xText = effectivePlatformBody(baseBody, overrides, 'x');
		const linkedinFlat = flattenThreadBody(linkedinText);
		return {
			bluesky: {
				len: maxThreadSegmentLength(bskyText, countGraphemes),
				max: PLATFORM_LIMITS.bluesky
			},
			mastodon: {
				len: maxThreadSegmentLength(mastoText, mastodonWeightedLength),
				max: platformMax('mastodon', accountsFor('mastodon'))
			},
			linkedin: { len: countGraphemes(linkedinFlat), max: PLATFORM_LIMITS.linkedin },
			threads: {
				len: maxThreadSegmentLength(threadsText, countGraphemes),
				max: PLATFORM_LIMITS.threads
			},
			x: { len: maxThreadSegmentLength(xText, xWeightedLength), max: PLATFORM_LIMITS.x }
		};
	});
	const blueskyBytesOver = $derived.by(() => {
		const bskyText = effectivePlatformBody(baseBody, overrides, 'bluesky');
		let over = 0;
		for (const seg of splitThreadSegments(bskyText)) {
			over = Math.max(over, utf8ByteLength(seg) - 3000);
		}
		return over;
	});
	const threadsLinkCount = $derived.by(() => {
		const text = effectivePlatformBody(baseBody, overrides, 'threads');
		const found = text.match(/https?:\/\/[^\s]+/gi) ?? [];
		const urls = new Set(
			found.map((u) => u.replace(/[.,);:!?]+$/, '').toLowerCase()).filter(Boolean)
		);
		return urls.size;
	});
	const threadsLinksOver = $derived(threadsLinkCount > 5 && selectedPlatforms.has('threads'));
	// LinkedIn flattens the whole thread into one post, so its media rules
	// apply to the combined attachments rather than per segment.
	const linkedinMediaProblem = $derived.by(() => {
		if (!selectedPlatforms.has('linkedin')) return null;
		if (media.length > LINKEDIN_MAX_IMAGES) {
			return `LinkedIn combines the thread into one post — max ${LINKEDIN_MAX_IMAGES} images (${media.length} attached)`;
		}
		const videos = media.filter((m) => (m.mime || '').toLowerCase().startsWith('video/'));
		const images = media.filter((m) => !(m.mime || '').toLowerCase().startsWith('video/'));
		if (videos.length > 1) return 'LinkedIn allows one video per post';
		if (videos.length > 0 && images.length > 0) return 'LinkedIn video posts cannot include images';
		return null;
	});
	const linkedinMediaOver = $derived(linkedinMediaProblem !== null);
	const overSelectedLimit = $derived(
		isOverSelectedPlatformLimit({
			selectedPlatforms,
			blueskyLen: counters.bluesky.len,
			mastodonLen: counters.mastodon.len,
			blueskyMax: counters.bluesky.max,
			mastodonMax: counters.mastodon.max,
			linkedinLen: counters.linkedin.len,
			linkedinMax: counters.linkedin.max,
			threadsLen: counters.threads.len,
			threadsMax: counters.threads.max,
			xLen: counters.x.len,
			xMax: counters.x.max
		}) ||
			threadsLinksOver ||
			linkedinMediaOver ||
			(blueskyBytesOver > 0 &&
				(selectedPlatforms.has('bluesky') || isPlatformCustomized(overrides, 'bluesky')))
	);

	function getPlatformStatus(platform: PlatformId) {
		const isCustomized = isPlatformCustomized(overrides, platform);
		const text = effectivePlatformBody(baseBody, overrides, platform);
		const max = platformMax(platform, accountsFor(platform));
		const countFn = (s: string) => countForPlatform(s, platform);
		return {
			isCustomized,
			hasError: supportsThreads(platform)
				? maxThreadSegmentLength(text, countFn) > max
				: countFn(flattenThreadBody(text)) > max
		};
	}

	const mediaBySegment = $derived(groupMediaBySegment(media));
	// Single-post platforms (LinkedIn) render one flattened card, which must
	// show every attachment publish will combine — not just segment 0's.
	function cardMedia(index: number): MediaItem[] {
		if (activeTab !== 'global' && !supportsThreads(activeTab)) return media;
		return mediaBySegment.get(index) ?? [];
	}
	const mastoPollError = $derived.by(() => {
		if (!mastoPoll) return null;
		const v = validatePollConfig(mastoPoll);
		return v.ok ? null : v.error;
	});
	// Options follow the destination: show the Mastodon panel only when
	// Mastodon is selected or the draft has a Mastodon override to edit.
	// Stored non-default values (instance defaults, leftover CW/poll) must not
	// surface it while another platform is the only destination.
	const showMastoOptions = $derived(
		selectedPlatforms.has('mastodon') || isPlatformCustomized(overrides, 'mastodon')
	);
	// Auto-resize that prevents the page scroll jumping.
	function autoResize(node: HTMLTextAreaElement, _value: string) {
		const resize = () => {
			const scrollY = window.scrollY;
			node.style.height = 'auto';
			node.style.height = node.scrollHeight + 'px';
			window.scrollTo(0, scrollY);
		};
		node.addEventListener('input', resize);
		setTimeout(resize, 0);
		return {
			update(_newValue: string) {
				setTimeout(resize, 0);
			},
			destroy() {
				node.removeEventListener('input', resize);
			}
		};
	}

	function takeSnapshot(): string {
		const sorted: PlatformOverrideMap = {};
		for (const k of Object.keys(overrides).sort())
			sorted[k as PlatformId] = overrides[k as PlatformId]!;
		return JSON.stringify({
			b: baseBody,
			o: sorted,
			v: mastoVisibility,
			c: mastoCW,
			p: mastoPoll,
			s: [...selected].sort(),
			m: media.map((m) => ({ i: m.id, a: m.altText || '', s: m.segmentIndex ?? 0 }))
		});
	}

	function markDirty() {
		dirty = true;
	}

	function setActiveBody(nextBody: string) {
		if (activeTab === 'global') {
			baseBody = nextBody;
		} else {
			// Editing a flattened single-post view implicitly customizes the platform.
			overrides = customizePlatformBody(overrides, activeTab, nextBody);
		}
		markDirty();
	}

	function initSelection(list: Connection[]) {
		if (pendingSelected) {
			selected = new Set(resolveRestoredSelection(pendingSelected, list) ?? []);
			pendingSelected = null;
			didInitSelection = true;
		} else if (!didInitSelection) {
			didInitSelection = true;
			const active = list.filter((c) => c.status === 'active');
			const preferred = (initialSettings?.defaultAccountIds ?? []).filter((id) =>
				active.some((c) => c.id === id)
			);
			selected = new Set(preferred.length ? preferred : active.map((c) => c.id));
		}
	}

	async function loadConnections() {
		const res = await fetch('/api/connections');
		if (!res.ok) return;
		const data = await res.json();
		const list: Connection[] = data.connections || [];
		connections = list;
		initSelection(list);
	}

	function resetEditorForNewDraft() {
		draftId = null;
		baseBody = '';
		overrides = {};
		media = [];
		mastoVisibility = initialSettings?.mastoVisibility ?? 'public';
		mastoCW = '';
		mastoPoll = null;
		activeTab = 'global';
		focusedSegment = 0;
		scheduleOpen = false;
		loadedSchedule = null;
		scheduleTouched = false;
		isPostConfirmOpen = false;
		pendingPublish = null;
		publishProgress = null;
		busyAction = null;
		dirty = false;
		saveFailed = false;
		savedSnapshot = null;
		loadFailedId = null;
		storedVariants = new Set();
	}

	async function loadDraft(id: string) {
		// A first load races whatever the user types into the still-empty
		// editor: applying the stored copy wholesale discarded that text (and
		// the queued autosave then wrote the stale body back). Snapshot the
		// editable pieces and merge field by field instead. Switching between
		// drafts still applies the stored copy wholesale — that draft is the
		// one the user deliberately asked for.
		// `draftId` is seeded from the URL at mount, so it cannot tell a first
		// load from a draft switch — an unset snapshot can: nothing has been
		// loaded or saved in this editor instance yet.
		const fresh = savedSnapshot === null;
		const before = fresh
			? {
					body: baseBody,
					overrides,
					media,
					visibility: mastoVisibility,
					cw: mastoCW,
					poll: mastoPoll
				}
			: null;
		// A failure belongs to the draft the editor is on. Clear a stale one when
		// a different draft starts loading, or the banner would sit over content
		// that is about to arrive and block saving on it.
		if (loadFailedId && loadFailedId !== id) loadFailedId = null;
		loadingDraftId = id;
		try {
			const res = await fetch(`/api/drafts/${id}`);
			if (res.status === 401) {
				// Navigating to /login here would throw away whatever is typed in
				// the composer (it exists only in memory, and the save on the way
				// out would 401 too). Pause saving, say why, and offer the link.
				loadFailedId = id;
				showToast('Your session expired — sign in again to keep editing', 'error', {
					label: 'Sign in',
					href: '/login'
				});
				return;
			}
			if (!res.ok) {
				// The stored copy never arrived. Keep saving off until it does:
				// otherwise the first keystroke autosaves an empty body over it.
				// Only arm the block for the draft the editor is actually on, and
				// only while this attempt is still the live one: a late failure
				// for a superseded attempt (the user moved on, a retry already
				// succeeded) must not freeze saving over content that loaded.
				if (loadingDraftId === id && page.url.searchParams.get('id') === id) {
					loadFailedId = id;
					showToast('Could not load this draft', 'error');
				}
				return;
			}
			const data = await res.json();
			loadFailedId = null;
			if (page.url.searchParams.get('id') !== id) return;
			const d = data.draft;
			if (before && draftId !== null && draftId !== id) {
				// An autosave or media upload claimed a brand-new draft while this
				// fetch was in flight; it owns the editor now (the URL was
				// rewritten to it), so this response must not hijack the session.
				return;
			}
			draftId = d.id;
			const main = d.baseBody || '';
			const loadedOverrides = overridesFromVariants(d.variants || [], main);
			const loadedMedia = (d.media || []).map((m: MediaItem) => ({
				...m,
				segmentIndex: m.segmentIndex ?? 0
			}));
			let loadedVisibility = initialSettings?.mastoVisibility ?? 'public';
			let loadedCw = '';
			let loadedPoll: PollConfig | null = null;
			for (const v of d.variants || []) {
				if (v.platform === 'mastodon' && v.optionsJson) {
					if (v.optionsJson.visibility) loadedVisibility = v.optionsJson.visibility;
					if (v.optionsJson.spoilerText) loadedCw = v.optionsJson.spoilerText;
					if (v.optionsJson.poll) loadedPoll = parsePollConfig(v.optionsJson.poll);
				}
			}
			storedVariants = new Set(
				((d.variants || []) as Array<{ platform: PlatformId }>).map((v) => v.platform)
			);

			let mergedCleanly = true;
			if (before) {
				const keepBody = baseBody !== before.body;
				const keepOverrides = overrides !== before.overrides;
				const keepMedia = media !== before.media;
				const keepVisibility = mastoVisibility !== before.visibility;
				const keepCw = mastoCW !== before.cw;
				const keepPoll = mastoPoll !== before.poll;
				const keepSelection = selectionTouched;
				mergedCleanly =
					!keepBody &&
					!keepOverrides &&
					!keepMedia &&
					!keepVisibility &&
					!keepCw &&
					!keepPoll &&
					!keepSelection;
				if (!keepBody) baseBody = main;
				// Platform bodies the user did not touch still come from the
				// draft; the ones they did keep their local text.
				overrides = keepOverrides ? { ...loadedOverrides, ...overrides } : loadedOverrides;
				if (!keepMedia) media = loadedMedia;
				if (!keepVisibility) mastoVisibility = loadedVisibility;
				if (!keepCw) mastoCW = loadedCw;
				if (!keepPoll) mastoPoll = loadedPoll;
			} else {
				baseBody = main;
				overrides = loadedOverrides;
				media = loadedMedia;
				mastoVisibility = loadedVisibility;
				mastoCW = loadedCw;
				mastoPoll = loadedPoll;
			}

			// Selection precedence: the draft's own saved selection wins; older
			// rows (and drafts scheduled/published before this existed) fall
			// back to their publish targets. null means "nothing stored".
			const targetIds = ((d.targets || []) as Array<{ connectionId?: string }>).map(
				(t) => t.connectionId
			);
			const savedRaw = Array.isArray(d.selectedConnectionIds)
				? (d.selectedConnectionIds as string[])
				: null;
			// A user toggle during the load wins over the stored selection.
			const keepSelection = before !== null && selectionTouched;
			if (!keepSelection) {
				const restored = savedRaw
					? resolveSavedSelection(savedRaw, connections)
					: resolveRestoredSelection(targetIds, connections);
				if (restored !== null) {
					if (didInitSelection && connections.length) {
						selected = new Set(restored);
					} else {
						// Keep the raw ids so initSelection filters them against
						// the live connection list once it arrives.
						pendingSelected = savedRaw ?? targetIds.filter((id): id is string => Boolean(id));
					}
				}
			}
			selectionTouched = false;

			// Schedule: a first load keeps a schedule the user edited while the
			// fetch was in flight; a draft switch applies the stored one wholesale.
			if (before === null || !scheduleTouched) {
				loadedSchedule = earliestFutureScheduleValue(d.targets, new Date());
				scheduleTouched = false;
				// The popover may already be open on the default; show the stored
				// time in place. With nothing future stored the default stays.
				if (scheduleOpen && loadedSchedule) applyLoadedSchedule(loadedSchedule);
			}
			if (mergedCleanly) {
				dirty = false;
				saveFailed = false;
				savedSnapshot = takeSnapshot();
			}
			// Otherwise the local edits stay dirty on purpose: the autosave
			// effect below persists the merged content once the load settles.
		} catch (err) {
			// Network failure or an unparseable body: same protection as a 4xx.
			if (loadingDraftId === id && page.url.searchParams.get('id') === id) {
				loadFailedId = id;
				showToast('Could not load this draft', 'error');
			}
			throw err;
		} finally {
			if (loadingDraftId === id) loadingDraftId = null;
		}
	}

	type SaveSnapshot = {
		baseBody: string;
		overrides: PlatformOverrideMap;
		mastoVisibility: string;
		mastoCW: string;
		mastoPoll: PollConfig | null;
		selectedConnectionIds: string[];
	};

	async function ensureDraft(
		snap: SaveSnapshot = {
			baseBody,
			overrides,
			mastoVisibility,
			mastoCW,
			mastoPoll,
			selectedConnectionIds: [...selected]
		},
		navigate = true
	): Promise<string> {
		if (draftId) {
			const res = await fetch(`/api/drafts/${draftId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					baseBody: snap.baseBody,
					selectedConnectionIds: snap.selectedConnectionIds
				})
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.error || 'Failed to save draft');
			return draftId;
		}
		const res = await fetch('/api/drafts', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				baseBody: snap.baseBody,
				selectedConnectionIds: snap.selectedConnectionIds
			})
		});
		const data = await res.json();
		if (!res.ok) throw new Error(data.error || 'Failed to create draft');
		draftId = data.draft.id;
		// Mark content as loaded BEFORE touching the URL so the id-watcher
		// effect sees id === loadedDraftContentFor and skips a spurious
		// loadDraft() that would overwrite in-flight typing.
		loadedDraftContentFor = draftId;
		if (navigate) {
			// Shallow URL update only: goto() re-runs load and steals textarea
			// focus on first autosave; replaceState() keeps focus and state.
			try {
				replaceState(`/compose?id=${data.draft.id}`, page.state);
			} catch {
				// URL update is cosmetic; the draft is already saved.
			}
		}
		return data.draft.id as string;
	}

	async function saveVariants(
		id: string,
		snap: SaveSnapshot = {
			baseBody,
			overrides,
			mastoVisibility,
			mastoCW,
			mastoPoll,
			selectedConnectionIds: [...selected]
		}
	) {
		const toSave = customizedBodiesForSave(snap.baseBody, snap.overrides, PLATFORM_ORDER);
		// Write a variant only when this save actually needs one, and clear a
		// row only when it exists. The old shape fired a request for every
		// platform on every save (usually five no-op DELETEs), each a full
		// Worker invocation.
		const writes = PLATFORM_ORDER.map((platform) => {
			const customized = isPlatformCustomized(snap.overrides, platform);
			const options =
				platform === 'mastodon'
					? {
							visibility: snap.mastoVisibility,
							spoilerText: snap.mastoCW || undefined,
							poll: snap.mastoPoll ?? undefined
						}
					: {};
			const mastodonOptions =
				platform === 'mastodon' &&
				Boolean(snap.mastoCW || snap.mastoVisibility !== 'public' || snap.mastoPoll);
			if (customized || mastodonOptions) {
				// Mark at dispatch, not on response: if the write commits but
				// the response is lost, a later save must still be allowed to
				// DELETE the row instead of leaving a stale variant that would
				// override the main body at publish time.
				storedVariants.add(platform);
				return {
					platform,
					action: 'put' as const,
					request: fetch(`/api/drafts/${id}/variants`, {
						method: 'PUT',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							platform,
							body: customized ? (toSave[platform] ?? '') : null,
							options
						})
					})
				};
			}
			if (!storedVariants.has(platform)) return null;
			return {
				platform,
				action: 'delete' as const,
				request: fetch(`/api/drafts/${id}/variants?platform=${platform}`, {
					method: 'DELETE'
				})
			};
		});
		const pending = writes.filter((w): w is NonNullable<typeof w> => w !== null);
		const results = await Promise.all(pending.map((w) => w.request));
		for (let i = 0; i < results.length; i++) {
			const res = results[i];
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.error || `Failed to save ${pending[i].platform} variant`);
			}
			if (pending[i].action === 'delete') storedVariants.delete(pending[i].platform);
		}
	}

	let savePromise: Promise<string | null> | null = null;

	async function persistAll(
		allowEmpty = false,
		opts: { navigate?: boolean } = {}
	): Promise<string | null> {
		if (savePromise) return savePromise;
		savePromise = doPersist(allowEmpty, opts);
		try {
			return await savePromise;
		} finally {
			savePromise = null;
		}
	}

	async function doPersist(
		allowEmpty = false,
		opts: { navigate?: boolean } = {}
	): Promise<string | null> {
		// Backstop for every caller (autosave, Cmd+S, publish, schedule,
		// beforeunload): never write a draft whose stored copy never loaded.
		if (loadFailedId) return null;
		const emptyNew = !draftId && !baseBody.trim();
		if (emptyNew && !allowEmpty) return null;
		// Nothing changed since the last successful save: skip the round trips.
		// Callers already gate on dirty; this makes the guarantee explicit for
		// every save path (autosave, Cmd+S, beforeunload, publish, schedule).
		if (draftId && takeSnapshot() === savedSnapshot && Object.keys(altPending).length === 0) {
			return draftId;
		}
		saving = true;
		const before = takeSnapshot();
		const snap: SaveSnapshot = {
			baseBody,
			overrides,
			mastoVisibility,
			mastoCW,
			mastoPoll,
			selectedConnectionIds: [...selected]
		};
		try {
			const id = await ensureDraft(snap, opts.navigate ?? true);
			await saveVariants(id, snap);
			loadedDraftContentFor = id;
			saveFailed = false;
			if (takeSnapshot() === before) {
				savedSnapshot = before;
				dirty = false;
			}
			return id;
		} catch (e) {
			saveFailed = true;
			showToast(humanizeError(e instanceof Error ? e.message : 'Save failed'), 'error');
			return null;
		} finally {
			saving = false;
		}
	}

	async function persistClean(rounds = 3): Promise<string | null> {
		let id: string | null = null;
		for (let i = 0; i < rounds; i++) {
			id = await persistAll();
			if (!id || !dirty) return id;
		}
		return id;
	}

	/**
	 * Persist only when there is something to persist. A clean, fully-saved
	 * draft returns its id immediately, so Publish/Schedule never wait on a
	 * redundant PATCH + variant fan-out before the real action starts.
	 */
	async function persistForAction(): Promise<string | null> {
		// Media moves are written next to the body; publish reads the stored
		// index, so any in-flight layout write has to land first.
		await mediaSync;
		if (draftId && !dirty && !saving && Object.keys(altPending).length === 0) return draftId;
		await flushAltPending();
		return persistClean();
	}

	function pollBlocked(): boolean {
		if (!mastoPoll || !mastoPollError) return false;
		if (![...selected].some((id) => connections.find((c) => c.id === id)?.platform === 'mastodon'))
			return false;
		showToast(mastoPollError, 'warn');
		return true;
	}

	// saving=true while the pre-publish persist is in flight. The dialog opens
	// synchronously (before any await) so the Publish button feels instant;
	// the confirm button stays disabled until draftId lands.
	let pendingPublish = $state<{
		draftId: string | null;
		connectionIds: string[];
		saving: boolean;
	} | null>(null);
	// Invalidates a stale open-dialog update when the user hits "Keep editing"
	// mid-save or starts a newer publish. The background persist still saves
	// the draft; only the dialog update is dropped.
	let publishRequestSeq = 0;

	async function requestPublish(connectionIds: string[]) {
		// Prevent overlapping publishes/schedules (publishing covers both).
		if (publishing) return;
		// Fast empty check before opening any UI: mirrors doPersist's
		// emptyNew guard so an empty composer toasts without flashing the
		// dialog (or the publishing spinner in skip-ask mode).
		if (loadFailedId) {
			showToast('Could not load this draft — retry before publishing', 'warn');
			return;
		}
		if (!draftId && !baseBody.trim()) {
			showToast('Nothing to publish', 'warn');
			return;
		}
		if (!connectionIds.length) {
			showToast('Select at least one account', 'warn');
			return;
		}
		if (threadsLinksOver && connectionIds.some((id) => platformOf(id) === 'threads')) {
			showToast(`Threads allows max 5 links per post (${threadsLinkCount} found)`, 'warn');
			return;
		}
		if (linkedinMediaOver && connectionIds.some((id) => platformOf(id) === 'linkedin')) {
			showToast(linkedinMediaProblem ?? 'LinkedIn cannot take this media', 'warn');
			return;
		}
		const sizeProblem = mediaSizeProblem(
			connectionIds.map(platformOf).filter((p) => p !== undefined),
			media
		);
		if (sizeProblem) {
			showToast(sizeProblem, 'warn');
			return;
		}
		if (overSelectedLimit) {
			showToast('A post is over the character limit', 'warn');
			return;
		}
		if (pollBlocked()) return;
		// Skip-ask fast path: give instant button feedback (publishing=true)
		// before the save round-trips, then publish without a dialog.
		if (skipAsk) {
			publishing = true;
			busyAction = 'publish';
			startPublishBusy();
			try {
				const id = await persistForAction();
				if (!id) {
					showToast('Nothing to publish', 'warn');
					return;
				}
				pendingPublish = null;
				isPostConfirmOpen = false;
				await publishToDestinations(id, connectionIds);
			} catch (e) {
				showToast(humanizeError(e instanceof Error ? e.message : 'Publish failed'), 'error');
			} finally {
				publishing = false;
				busyAction = null;
				stopPublishBusy();
			}
			return;
		}
		// Dialog path: open instantly with a saving placeholder, then persist
		// in the background. State is set synchronously before the first
		// await so first paint happens in ~1 frame, not after 2-7 round-trips.
		// A clean, already-saved draft skips the persist entirely.
		const requestId = ++publishRequestSeq;
		const ready = draftId !== null && !dirty && !saving && Object.keys(altPending).length === 0;
		// Fresh dialog: never show a previous attempt's progress/failure list.
		publishProgress = null;
		pendingPublish = { draftId, connectionIds, saving: !ready };
		isPostConfirmOpen = true;
		if (ready) return;
		try {
			const id = await persistForAction();
			if (requestId !== publishRequestSeq) return;
			if (!id) {
				pendingPublish = null;
				isPostConfirmOpen = false;
				showToast('Nothing to publish', 'warn');
				return;
			}
			if (pendingPublish && requestId === publishRequestSeq) {
				pendingPublish = { draftId: id, connectionIds, saving: false };
			}
		} catch (e) {
			if (requestId !== publishRequestSeq) return;
			pendingPublish = null;
			isPostConfirmOpen = false;
			showToast(humanizeError(e instanceof Error ? e.message : 'Publish failed'), 'error');
		}
	}

	function platformOf(connectionId: string): string | undefined {
		return connections.find((c) => c.id === connectionId)?.platform;
	}

	const pendingAccounts = $derived(
		(pendingPublish?.connectionIds ?? [])
			.map((id) => connections.find((c) => c.id === id))
			.filter((c) => c !== undefined)
	);

	async function onPublish() {
		scheduleOpen = false;
		await requestPublish([...selected]);
	}

	const destinationName = (connectionId: string): string => {
		const c = connections.find((x) => x.id === connectionId);
		if (!c) return 'Destination';
		if (!c.handle) return platformName(c.platform);
		return `${platformName(c.platform)} · ${displayHandle(c.handle)}`;
	};

	function setDestinationProgress(connectionId: string, patch: Partial<DestinationProgress>) {
		publishProgress = publishProgress
			? publishProgress.map((d) => (d.connectionId === connectionId ? { ...d, ...patch } : d))
			: publishProgress;
	}

	/**
	 * Publish to every destination in parallel, one request each. Per-destination
	 * requests let the confirm popover show live progress and keep each publish
	 * inside its own Worker subrequest budget. An already-published target comes
	 * back `skipped` and still counts as success.
	 */
	async function publishToDestinations(draftId: string, connectionIds: string[]) {
		publishProgress = connectionIds.map((connectionId) => ({
			connectionId,
			status: 'pending' as const,
			error: null
		}));
		announcePublish(
			`Publishing to ${connectionIds.length} ${connectionIds.length === 1 ? 'destination' : 'destinations'}.`
		);
		const settled = await Promise.all(
			connectionIds.map(async (connectionId) => {
				try {
					const res = await fetch(`/api/drafts/${draftId}/publish`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ connectionIds: [connectionId] })
					});
					const data = await res.json().catch(() => ({}));
					if (!res.ok) throw new Error(data.error || 'Publish failed');
					const row = (data.results || [])[0] as
						{ status?: string; error?: string | null; deferred?: boolean } | undefined;
					if (!row) throw new Error('Publish failed');
					if (row.status === 'published') {
						setDestinationProgress(connectionId, { status: 'published', error: null });
						return { connectionId, status: 'published' as const, error: null };
					}
					if (row.status === 'publishing') {
						setDestinationProgress(connectionId, { status: 'publishing', error: null });
						return { connectionId, status: 'publishing' as const, error: null };
					}
					if (row.deferred) {
						// Left for the scheduler's next tick (the request's call
						// budget ran short): it is on its way, not failed.
						const message = 'Queued — goes out on the next scheduler tick';
						setDestinationProgress(connectionId, { status: 'retrying', error: message });
						return { connectionId, status: 'retrying' as const, error: message };
					}
					if (row.status === 'scheduled') {
						// Retryable failure: the scheduler retries with backoff.
						const message = humanizeError(row.error ?? 'Retrying automatically');
						setDestinationProgress(connectionId, {
							status: 'retrying',
							error: message
						});
						return { connectionId, status: 'retrying' as const, error: message };
					}
					const message = humanizeError(row.error ?? 'Publish failed');
					setDestinationProgress(connectionId, { status: 'failed', error: message });
					return { connectionId, status: 'failed' as const, error: message };
				} catch (e) {
					const message = humanizeError(e instanceof Error ? e.message : 'Publish failed');
					setDestinationProgress(connectionId, { status: 'failed', error: message });
					return { connectionId, status: 'failed' as const, error: message };
				}
			})
		);

		const failed = settled.filter((s) => s.status === 'failed');
		const published = settled.filter((s) => s.status === 'published');
		const inFlight = settled.filter((s) => s.status === 'publishing');
		const retrying = settled.filter((s) => s.status === 'retrying');
		if (failed.length) {
			showToast(
				humanizeError(
					failed
						.map((f) => f.error)
						.filter(Boolean)
						.join('; ') || 'Publish failed'
				),
				'error',
				{ label: 'View posts', href: '/posts' }
			);
			announcePublish(
				(published.length ? `Published to ${published.length}. ` : '') +
					`Failed for ${failed.map((f) => destinationName(f.connectionId)).join(', ')}.`
			);
		} else if (retrying.length) {
			// Retryable failures are rescheduled server-side; report them as a
			// warning with a link instead of a red failure.
			showToast(
				`Retrying automatically for ${retrying.map((r) => destinationName(r.connectionId)).join(', ')}` +
					(published.length ? ` — already published to ${published.length}` : ''),
				'warn',
				{ label: 'View posts', href: '/posts' }
			);
			announcePublish(
				`Retrying automatically for ${retrying.map((r) => destinationName(r.connectionId)).join(', ')}.`
			);
		} else if (published.length) {
			showToast(
				`Successfully published to ${published.length} ${published.length === 1 ? 'destination' : 'destinations'}!`,
				'success'
			);
			announcePublish(
				`Published to ${published.length} ${published.length === 1 ? 'destination' : 'destinations'}.`
			);
		} else if (inFlight.length) {
			showToast('One of these destinations is already publishing', 'warn');
		}
		// The popover closed when the publish started. Reopen it only when a
		// destination failed, so the per-destination errors are visible; a
		// clean publish just closes out (success is reported by the toast).
		if (failed.length) {
			if (pendingPublish) isPostConfirmOpen = true;
		} else {
			clearPostConfirm();
		}
		try {
			await loadConnections();
		} catch {
			// Connection refresh is best-effort; the toast already reported.
		}
	}

	async function confirmPublish() {
		const pending = pendingPublish;
		if (!pending || publishing || pending.saving || !pending.draftId) return;
		// Close the popover now: the main button owns progress from here, and
		// the popover only comes back when a destination fails. pendingPublish
		// stays set so the failure view can still render the destinations.
		publishRequestSeq++;
		isPostConfirmOpen = false;
		publishing = true;
		busyAction = 'publish';
		startPublishBusy();
		try {
			await publishToDestinations(pending.draftId, pending.connectionIds);
		} finally {
			publishing = false;
			busyAction = null;
			stopPublishBusy();
		}
	}

	async function verifyConnection(connectionId: string) {
		reconnecting = connectionId;
		try {
			const res = await fetch(`/api/connections/${connectionId}/verify`, { method: 'POST' });
			const data = await res.json();
			if (!res.ok) throw new Error(data.error || 'Could not verify this account');
			showToast('Account reconnected', 'success');
			await loadConnections();
		} catch (e) {
			showToast(
				humanizeError(e instanceof Error ? e.message : 'Could not verify this account'),
				'error'
			);
		} finally {
			reconnecting = null;
		}
	}

	// Quick-set offset (days / hours / mins from now). Prefilled with a common
	// default; editing any field recomputes the date/time inputs below.
	let scheduleMode = $state<'relative' | 'absolute'>('relative');
	let relativeValue = $state('1');
	let relativeUnit = $state<'hours' | 'days' | 'mins'>('hours');

	function applyLoadedSchedule(value: string) {
		scheduleMode = 'absolute';
		schedDate = value.slice(0, 10);
		schedTime = value.slice(11, 16);
	}

	function openSchedule() {
		if (isPostConfirmOpen) dismissPostConfirm();
		if (scheduleOpen) {
			scheduleOpen = false;
			return;
		}
		scheduleOpen = true;
		if (scheduleTouched) {
			// Reopen on the user's own pick; a relative offset is re-based on now.
			if (scheduleMode === 'relative') applyRelativeFields();
			return;
		}
		if (loadedSchedule && isFutureScheduleValue(loadedSchedule, new Date())) {
			applyLoadedSchedule(loadedSchedule);
			return;
		}
		scheduleMode = 'relative';

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
		relativeUnit = defaultUnit;
		relativeValue = defaultValue;

		applyRelativeFields();
	}

	function applyRelativeFields() {
		const { days, hours, minutes } = offsetToDHM(relativeValue, relativeUnit);
		const value = scheduleFromDHM(days, hours, minutes, new Date());
		schedDate = value.slice(0, 10);
		schedTime = value.slice(11, 16);
	}

	// `by` keeps the read lazy: scheduleCombined is declared below.
	const schedulePreview = $derived.by(() => schedulePreviewText(scheduleCombined));

	// Computed once: the viewer's zone label (used in static headings).
	const tzShort = localTimezoneShort();

	const scheduleCombined = $derived(schedDate && schedTime ? `${schedDate}T${schedTime}` : '');
	const minSchedDate = $derived.by(() => {
		void scheduleOpen;
		return minScheduleDatetime(new Date()).slice(0, 10);
	});

	async function onSchedule() {
		if (!selected.size) {
			showToast('Select at least one account', 'warn');
			return;
		}
		const now = new Date();
		if (!scheduleCombined || !isFutureScheduleValue(scheduleCombined, now)) {
			showToast('Pick a time in the future', 'warn');
			return;
		}
		// Mirror the publish guards: scheduling a post that cannot publish just
		// parks a guaranteed failure in the queue.
		if (threadsLinksOver) {
			showToast(`Threads allows max 5 links per post (${threadsLinkCount} found)`, 'warn');
			return;
		}
		if (linkedinMediaOver) {
			showToast(linkedinMediaProblem ?? 'LinkedIn cannot take this media', 'warn');
			return;
		}
		const sizeProblem = mediaSizeProblem(selectedPlatforms, media);
		if (sizeProblem) {
			showToast(sizeProblem, 'warn');
			return;
		}
		if (overSelectedLimit) {
			showToast('A post is over the character limit', 'warn');
			return;
		}
		if (pollBlocked()) return;
		const runAt = scheduleValueToIso(scheduleCombined, now);
		if (!runAt) {
			showToast('Pick a time in the future', 'warn');
			return;
		}
		if (loadFailedId) {
			showToast('Could not load this draft — retry before scheduling', 'warn');
			return;
		}
		publishing = true;
		busyAction = 'schedule';
		try {
			const id = await persistForAction();
			if (!id) {
				showToast('Nothing to schedule', 'warn');
				return;
			}
			const res = await fetch(`/api/drafts/${id}/schedule`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ connectionIds: [...selected], runAt })
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.error || 'Schedule failed');
			showToast(
				`Successfully scheduled for ${selectedAccounts.length} ${selectedAccounts.length === 1 ? 'destination' : 'destinations'}!`,
				'success'
			);
			dirty = false;
			scheduleOpen = false;
			// The draft now carries this time; reopening should show it.
			loadedSchedule = scheduleCombined;
			scheduleTouched = false;
		} catch (e) {
			showToast(humanizeError(e instanceof Error ? e.message : 'Schedule failed'), 'error');
		} finally {
			publishing = false;
			busyAction = null;
			stopPublishBusy();
		}
	}

	async function attachFilesToSegment(segmentIndex: number, files: File[]) {
		const picked = files.filter(
			(f) => f.type.startsWith('image/') || (videoEnabled && f.type === 'video/mp4')
		);
		if (!picked.length) {
			showToast(
				videoEnabled
					? 'Only image files (PNG, JPEG, WebP, GIF) and MP4 video are supported'
					: 'Only image files (PNG, JPEG, WebP, GIF) are supported',
				'warn'
			);
			return;
		}
		// Shrink to Bluesky's cap, the strictest one, whatever is selected now:
		// the file is stored once and may be published anywhere later.
		uploadingSegment = segmentIndex;
		const images: File[] = [];
		for (const f of picked) images.push(await shrinkToFit(f, BLUESKY_MAX_IMAGE_BYTES));
		const blueskySelected = connections.some((c) => selected.has(c.id) && c.platform === 'bluesky');
		const linkedinSelected = connections.some(
			(c) => selected.has(c.id) && c.platform === 'linkedin'
		);
		const threadsSelected = connections.some((c) => selected.has(c.id) && c.platform === 'threads');
		const xSelected = connections.some((c) => selected.has(c.id) && c.platform === 'x');
		const videos = images.filter((f) => f.type === 'video/mp4');
		const nonLinkedinSelected = connections.some(
			(c) => selected.has(c.id) && c.platform !== 'linkedin'
		);
		const linkedinOnly = connections.some((c) => selected.has(c.id) && c.platform === 'linkedin');
		const webpSelected = images.some((f) => f.type === 'image/webp') && linkedinSelected;
		const overBluesky = images.filter((f) => f.size > BLUESKY_MAX_IMAGE_BYTES);
		const overLinkedin = images.filter((f) => f.size > LINKEDIN_MAX_IMAGE_BYTES);
		const advisories: string[] = [];
		if (videos.length && nonLinkedinSelected) {
			advisories.push(
				'Video posts only go to LinkedIn — other selected accounts will fail unless you uncheck them.'
			);
		}
		if (videos.length && !linkedinOnly) {
			advisories.push('Select a LinkedIn account or the video has nowhere to go.');
		}
		if (overBluesky.length && blueskySelected) {
			advisories.push(
				`${overBluesky[0].name} is over Bluesky's 2MB image cap. Use a smaller image or uncheck Bluesky — Mastodon can still take it.`
			);
		}
		if (overLinkedin.length && linkedinSelected) {
			advisories.push(`${overLinkedin[0].name} is over LinkedIn's 8MB image cap.`);
		}
		if (webpSelected) {
			advisories.push(
				'WebP images are rejected by LinkedIn — use JPEG, PNG, or GIF, or uncheck LinkedIn.'
			);
		}
		const threadsBadType =
			threadsSelected && images.some((f) => f.type !== 'image/jpeg' && f.type !== 'image/png');
		const threadsOversize = threadsSelected && images.some((f) => f.size > THREADS_MAX_IMAGE_BYTES);
		if (threadsBadType) {
			advisories.push('Threads takes JPEG/PNG images only — others stay on your other accounts.');
		}
		if (threadsOversize) {
			advisories.push("An image is over Threads' 8MB cap — compress it or uncheck Threads.");
		}
		const xBadType =
			xSelected &&
			images.some(
				(f) =>
					f.type !== 'image/jpeg' &&
					f.type !== 'image/png' &&
					f.type !== 'image/gif' &&
					f.type !== 'image/webp'
			);
		const xOversize =
			xSelected &&
			images.some((f) =>
				f.type === 'image/gif' ? f.size > X_MAX_GIF_BYTES : f.size > X_MAX_IMAGE_BYTES
			);
		if (xBadType) {
			advisories.push('X takes JPEG/PNG/GIF/WebP images only — video goes to LinkedIn.');
		}
		if (xOversize) {
			advisories.push("An image is over X's 5MB cap (15MB for GIFs) — compress it or uncheck X.");
		}
		if (videos.length && xSelected) {
			advisories.push('Video posts only go to LinkedIn — X accounts will fail unless unchecked.');
		}
		if (advisories.length) showToast(advisories[0], 'warn');
		uploadingSegment = segmentIndex;
		try {
			const id = await persistAll(true);
			if (!id) throw new Error('Could not create draft for upload');
			const form = new FormData();
			form.set('segmentIndex', String(segmentIndex));
			for (const f of images) form.append('files', f);
			const res = await fetch(`/api/drafts/${id}/media`, { method: 'POST', body: form });
			const data = await res.json();
			if (!res.ok) throw new Error(data.error || 'Upload failed');
			const items: MediaItem[] = Array.isArray(data.items)
				? data.items
				: data.media
					? Array.isArray(data.media)
						? data.media
						: [data.media]
					: [];
			media = [
				...media,
				...items.map((it) => ({ ...it, segmentIndex: it.segmentIndex ?? segmentIndex }))
			];
			showToast(
				items.length === 1 ? 'Image attached' : `${items.length} images attached`,
				'success'
			);
		} catch (e) {
			showToast(e instanceof Error ? e.message : 'Upload failed', 'error');
		} finally {
			uploadingSegment = null;
		}
	}

	const altTimers: Record<string, ReturnType<typeof setTimeout>> = {};
	const altPending: Record<string, string> = {};
	async function fireAltUpdate(mediaId: string, altText: string, id: string) {
		try {
			const res = await fetch(`/api/drafts/${id}/media`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ mediaId, altText })
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.error || 'Failed to save alt text');
			}
			delete altPending[mediaId];
		} catch (e) {
			showToast(e instanceof Error ? e.message : 'Failed to save alt text', 'error');
		}
	}
	async function updateMediaAlt(mediaId: string, altText: string) {
		media = media.map((m) => (m.id === mediaId ? { ...m, altText } : m));
		if (!draftId) return;
		altPending[mediaId] = altText;
		clearTimeout(altTimers[mediaId]);
		const id = draftId;
		altTimers[mediaId] = setTimeout(() => void fireAltUpdate(mediaId, altText, id), 500);
	}
	async function flushAltPending() {
		const entries = Object.entries(altPending);
		for (const [mediaId] of entries) clearTimeout(altTimers[mediaId]);
		for (const [mediaId, altText] of entries) {
			if (draftId) await fireAltUpdate(mediaId, altText, draftId);
		}
	}

	let pendingMediaRemove = $state<string | null>(null);
	// Ids with a delete in flight: the dialog stays usable for a *different*
	// image while one is being removed.
	let mediaRemoving = $state<string[]>([]);
	let keepMediaBtn: HTMLButtonElement | null = $state(null);
	const mediaBusy = $derived(
		pendingMediaRemove !== null && mediaRemoving.includes(pendingMediaRemove)
	);
	let isDiscardOpen = $state(false);
	let discarding = $state(false);

	// Single-post trash = discard whole draft. Hidden when there is nothing
	// to discard (fresh /compose with empty text and no media).
	const canDiscard = $derived(draftId !== null || baseBody.trim() !== '' || media.length > 0);

	function requestDiscard() {
		if (discarding || saving || publishing || uploadingSegment !== null) {
			showToast('Please wait…', 'warn');
			return;
		}
		if (!canDiscard) return;
		isDiscardOpen = true;
	}

	async function confirmDiscard() {
		if (discarding) return;
		if (saving || publishing) {
			showToast('Please wait…', 'warn');
			return;
		}
		const id = draftId;
		// Nothing persisted yet: just clear local state, no API call.
		if (!id) {
			isDiscardOpen = false;
			for (const key of Object.keys(altTimers)) clearTimeout(altTimers[key]);
			for (const key of Object.keys(altPending)) delete altPending[key];
			pendingMediaRemove = null;
			resetEditorForNewDraft();
			try {
				replaceState('/compose', page.state);
			} catch {
				// URL update is cosmetic; the editor is already cleared.
			}
			showToast('Draft discarded', 'success');
			return;
		}
		discarding = true;
		try {
			const res = await fetch(`/api/drafts/${encodeURIComponent(id)}`, { method: 'DELETE' });
			if (!res.ok && res.status !== 404) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.error || 'Could not discard draft');
			}
			isDiscardOpen = false;
			for (const key of Object.keys(altTimers)) clearTimeout(altTimers[key]);
			for (const key of Object.keys(altPending)) delete altPending[key];
			pendingMediaRemove = null;
			resetEditorForNewDraft();
			loadedDraftContentFor = null;
			try {
				replaceState('/compose', page.state);
			} catch {
				// URL update is cosmetic; the editor is already cleared.
			}
			showToast('Draft discarded', 'success');
		} catch (e) {
			showToast(humanizeError(e instanceof Error ? e.message : 'Could not discard draft'), 'error');
		} finally {
			discarding = false;
		}
	}

	function requestRemoveMedia(mediaId: string) {
		pendingMediaRemove = mediaId;
	}

	async function confirmRemoveMedia() {
		const mediaId = pendingMediaRemove;
		if (!mediaId || !draftId || mediaRemoving.includes(mediaId)) return;
		mediaRemoving = [...mediaRemoving, mediaId];
		try {
			const res = await fetch(
				`/api/drafts/${draftId}/media?mediaId=${encodeURIComponent(mediaId)}`,
				{ method: 'DELETE' }
			);
			if (res.status === 401) {
				showToast('Your session expired — sign in again to keep editing', 'error', {
					label: 'Sign in',
					href: '/login'
				});
				return;
			}
			if (!res.ok) throw new Error('Failed to remove image');
			media = media.filter((m) => m.id !== mediaId);
			// Close only the dialog that is still about this image: one opened
			// for another image while this request was in flight stays.
			if (pendingMediaRemove === mediaId) pendingMediaRemove = null;
		} catch (e) {
			showToast(e instanceof Error ? e.message : 'Failed to remove image', 'error');
		} finally {
			mediaRemoving = mediaRemoving.filter((id) => id !== mediaId);
		}
	}

	function toggleAlt(id: string) {
		altOpen = { ...altOpen, [id]: !altOpen[id] };
	}

	function handleSegmentInput(i: number, e: Event) {
		const val = (e.target as HTMLTextAreaElement).value;
		const pieces = splitAtMarkers(val);
		if (!pieces) {
			setActiveBody(joinThreadSegments(updateSegment(segments, i, val)));
			return;
		}
		setActiveBody(
			joinThreadSegments([...segments.slice(0, i), ...pieces, ...segments.slice(i + 1)])
		);
		shiftMediaAfter(i, pieces.length - 1);
		const focusAt = i + pieces.length - 1;
		setTimeout(() => {
			textareaRefs[focusAt]?.focus();
		}, 0);
	}

	/**
	 * Keep images on the cards they belong to when cards are inserted after
	 * card `index`. A single-post view (LinkedIn) edits a flattened body whose
	 * cards are not the thread's, so the thread's images stay where they are.
	 */
	function shiftMediaAfter(index: number, added: number) {
		if (added === 0) return;
		if (activeTab !== 'global' && !supportsThreads(activeTab)) return;
		const remapped = media.map((m) => ({
			...m,
			segmentIndex: remapSegmentIndexAfterInsert(m.segmentIndex ?? 0, index, added)
		}));
		const moves = remapped
			.filter((m, k) => m.segmentIndex !== (media[k]?.segmentIndex ?? 0))
			.map((m) => ({ id: m.id, segmentIndex: m.segmentIndex }));
		media = remapped;
		void queueMediaSync(moves, [], { saveBodyFirst: true });
	}

	function onAddSegment() {
		const idx = segments.length;
		setActiveBody(joinThreadSegments(addSegment(segments)));
		focusedSegment = idx;
		setTimeout(() => {
			textareaRefs[idx]?.focus();
		}, 0);
	}

	// Media segmentIndex lives in its own table and the UI applies changes
	// optimistically, so these writes are queued in order, retried once and
	// awaited before publish — publish reads the stored index, and a silently
	// dropped move would attach an image to the wrong thread post.
	function queueMediaSync(
		moves: MediaMove[],
		removals: string[] = [],
		opts: { saveBodyFirst?: boolean } = {}
	) {
		const id = draftId;
		if (!id || (!moves.length && !removals.length)) return mediaSync;
		mediaSync = mediaSync
			.catch(() => {})
			.then(async () => {
				// The server refuses an image on a card the stored draft does not
				// have yet, so a move onto a card a split just created waits for
				// the body that created it instead of the autosave. persistClean,
				// because a save already in flight may predate the split.
				if (opts.saveBodyFirst) await persistClean();
				const result = await persistMediaLayout({ draftId: id, moves, removals });
				if (!result.ok) {
					showToast('Couldn’t save the image layout — check the images and try again', 'error');
				}
			});
		return mediaSync;
	}

	function onRemoveSegment(index: number) {
		if (uploadingSegment === index) uploadingSegment = null;
		else if (uploadingSegment !== null && uploadingSegment > index) uploadingSegment -= 1;
		setActiveBody(joinThreadSegments(removeSegment(segments, index)));
		focusedSegment = Math.max(0, Math.min(index, segments.length - 2));
		const kept: MediaItem[] = [];
		const moves: MediaMove[] = [];
		const removals: string[] = [];
		for (const m of media) {
			const mapped = remapSegmentIndexAfterRemoval(m.segmentIndex ?? 0, index);
			if (mapped === null) {
				removals.push(m.id);
				continue;
			}
			if (mapped !== (m.segmentIndex ?? 0)) moves.push({ id: m.id, segmentIndex: mapped });
			kept.push({ ...m, segmentIndex: mapped });
		}
		media = kept;
		void queueMediaSync(moves, removals);
	}

	function applyReorder(from: number, to: number) {
		if (from === to) return;
		const next = reorderSegments(segments, from, to);
		if (next === segments) return;
		setActiveBody(joinThreadSegments(next));
		focusedSegment = to;
		const remapped = media.map((m) => ({
			...m,
			segmentIndex: remapSegmentIndexAfterReorder(m.segmentIndex ?? 0, from, to)
		}));
		const moves = remapped
			.filter((m, i) => m.segmentIndex !== (media[i]?.segmentIndex ?? 0))
			.map((m) => ({ id: m.id, segmentIndex: m.segmentIndex ?? 0 }));
		media = remapped;
		void queueMediaSync(moves);
	}

	function handleReorderKeyboard(index: number, direction: -1 | 1) {
		const to = index + direction;
		if (to < 0 || to >= segments.length) return;
		applyReorder(index, to);
		setTimeout(() => {
			textareaRefs[to]?.focus();
		}, 0);
	}

	function handleSplitPaste(segmentIndex: number, pasted: string): boolean {
		const text = pasted.replace(/\r\n/g, '\n');
		const hasDelimiter = text.includes('\n---\n') || /\n---\n/.test(text);
		const selectedCaps = ([...selectedPlatforms] as PlatformId[]).map((p) => ({
			platform: p,
			max: platformMax(p, accountsFor(p))
		}));
		let capPlatform = selectedCaps[0]?.platform;
		let cap = selectedCaps[0]?.max ?? maxChars;
		for (const c of selectedCaps) {
			if (c.max < cap) {
				cap = c.max;
				capPlatform = c.platform;
			}
		}
		if (activeTab !== 'global') {
			cap = platformMax(activeTab, accountsFor(activeTab));
			capPlatform = activeTab;
		}
		const countFn = (s: string) => countForPlatform(s, capPlatform ?? 'generic');
		if (!hasDelimiter && splitLongText(text, cap, countFn).length <= 1) return false;
		const pieces = hasDelimiter
			? text
					.split(/\n?---\n?/)
					.map((s) => s.trim())
					.filter(Boolean)
			: splitLongText(text, cap, countFn);
		if (pieces.length <= 1) return false;
		const wasEmpty = (segments[segmentIndex] ?? '').trim() === '';
		const next = wasEmpty
			? [...segments.slice(0, segmentIndex), ...pieces, ...segments.slice(segmentIndex + 1)]
			: [...segments.slice(0, segmentIndex + 1), ...pieces, ...segments.slice(segmentIndex + 1)];
		const delta = next.length - segments.length;
		setActiveBody(joinThreadSegments(next));
		shiftMediaAfter(segmentIndex, delta);
		focusedSegment = wasEmpty ? segmentIndex + pieces.length - 1 : segmentIndex + pieces.length;
		showToast(`Split into ${pieces.length} posts`, 'success');
		return true;
	}

	function handlePaste(e: ClipboardEvent, index: number) {
		const data = e.clipboardData;
		if (!data) return;
		const files: File[] = [];
		for (let i = 0; i < data.items.length; i++) {
			const item = data.items[i];
			if (item.kind === 'file' && (item.type.startsWith('image/') || item.type === 'video/mp4')) {
				const f = item.getAsFile();
				if (f) files.push(f);
			}
		}
		if (files.length) {
			e.preventDefault();
			void attachFilesToSegment(index, files);
			return;
		}
		const pasted = data.getData('text/plain');
		if (pasted && handleSplitPaste(index, pasted)) e.preventDefault();
	}

	function handleDrop(e: DragEvent, index: number) {
		e.preventDefault();
		if (e.dataTransfer?.files?.length) {
			const files = Array.from(e.dataTransfer.files).filter(
				(f) => f.type.startsWith('image/') || f.type === 'video/mp4'
			);
			if (files.length) void attachFilesToSegment(index, files);
		}
	}

	function openDestinations() {
		isAccountsPopoverOpen = !isAccountsPopoverOpen;
	}

	function clearSelection() {
		if (!selected.size) return;
		selected = new Set();
		selectionTouched = true;
		markDirty();
	}

	function selectOnly(id: string) {
		if (selected.size === 1 && selected.has(id)) return;
		selected = new Set([id]);
		selectionTouched = true;
		markDirty();
	}

	function toggleAccountSelection(id: string) {
		const next = new Set(selected);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selected = next;
		selectionTouched = true;
		markDirty();
	}

	function addOverride(accountId: string) {
		const conn = connections.find((c) => c.id === accountId);
		if (!conn) return;
		const platform = conn.platform as PlatformId;
		if (!isPlatformCustomized(overrides, platform)) {
			overrides = customizePlatformBody(overrides, platform, baseBody);
			markDirty();
		}
		activeTab = platform;
		isAddOverrideOpen = false;
	}

	function resetToGlobal(platform: PlatformId) {
		overrides = resetPlatformToFollow(overrides, platform);
		if (activeTab === platform) activeTab = 'global';
		markDirty();
	}

	function countForCard(text: string): number {
		return countForPlatform(text, activeTab === 'global' ? globalLimit.platform : activeTab);
	}

	function clearPostConfirm() {
		// Invalidate any in-flight pre-publish save's dialog update.
		publishRequestSeq++;
		pendingPublish = null;
		isPostConfirmOpen = false;
		publishProgress = null;
	}

	function dismissPostConfirm() {
		// User close attempts (Keep editing, outside click) are ignored while a
		// publish is in flight so the progress view stays until it settles.
		if (publishing) return;
		clearPostConfirm();
	}

	function startPublishBusy() {
		if (publishBusyTimer) clearTimeout(publishBusyTimer);
		publishBusyVisible = false;
		publishBusyTimer = setTimeout(() => {
			publishBusyVisible = true;
			publishBusyTimer = null;
		}, 400);
	}

	function stopPublishBusy() {
		if (publishBusyTimer) {
			clearTimeout(publishBusyTimer);
			publishBusyTimer = null;
		}
		publishBusyVisible = false;
	}

	function announcePublish(message: string) {
		if (announceTimer) clearTimeout(announceTimer);
		// Clear first so a repeated message (same count, same platform names)
		// is still announced by screen readers.
		publishAnnouncement = '';
		announceTimer = setTimeout(() => {
			publishAnnouncement = message;
			announceTimer = null;
		}, 30);
	}

	const publishBusyLabel = $derived.by(() => {
		const list = publishProgress ?? [];
		const settled = list.filter((d) => d.status === 'published' || d.status === 'failed').length;
		return settled > 0 && list.length > 1 ? `Publishing ${settled}/${list.length}…` : 'Publishing…';
	});

	const publishButtonBusy = $derived(
		publishing && (saving || busyAction === 'schedule' || publishBusyVisible)
	);

	const publishButtonLabel = $derived(
		publishing
			? saving
				? 'Saving…'
				: busyAction === 'schedule'
					? 'Scheduling…'
					: publishBusyVisible
						? publishBusyLabel
						: 'Publish'
			: 'Publish'
	);
	// Autosave is otherwise silent, and a phone has no Cmd+S to fall back on.
	// A pending autosave already reads as "Saving…"; an empty new draft is never
	// saved, so it shows nothing.
	const saveIndicator = $derived.by((): 'saving' | 'saved' | 'failed' | null => {
		if (loadFailedId || loadingDraftId) return null;
		if (saveFailed) return 'failed';
		if (saving || (dirty && (draftId || baseBody.trim()))) return 'saving';
		return draftId ? 'saved' : null;
	});
	// Close dropdowns on click outside.
	function handleWindowClick(e: MouseEvent) {
		const target = e.target as HTMLElement;
		if (!target.closest('.accounts-popover-container')) {
			isAccountsPopoverOpen = false;
		}
		if (!target.closest('.post-actions-container')) {
			scheduleOpen = false;
			if (isPostConfirmOpen) dismissPostConfirm();
		}
		if (!target.closest('.override-dropdown-container')) {
			isAddOverrideOpen = false;
		}
		if (!target.closest('.masto-options-container')) {
			isMastoOptionsOpen = false;
		}
	}

	let loadedDraftContentFor: string | null = seededDraft?.id ?? null;
	let initLoadedFor: string | null | undefined = undefined;
	$effect(() => {
		const id = page.url.searchParams.get('id');
		initSelection(connections);
		if (initLoadedFor === undefined) {
			initLoadedFor = id ?? null;
			void loadConnections();
		}
		if (id && id !== loadedDraftContentFor) {
			loadedDraftContentFor = id;
			void loadDraft(id).catch(() => {
				loadedDraftContentFor = null;
			});
		} else if (id !== initLoadedFor) {
			initLoadedFor = id ?? null;
		}
		if (!id && (loadedDraftContentFor || loadFailedId)) {
			// `page.url` does not track shallow `replaceState` (the autosave
			// assigns the draft id that way), so it can still read id-less
			// while the browser is on a loaded draft. Only a real navigation
			// to /compose — browser URL has no id — resets the editor;
			// re-running this effect for unrelated reasons (connections
			// refresh) must not wipe the composer.
			const browserId = new URL(location.href).searchParams.get('id');
			if (!browserId) {
				loadedDraftContentFor = null;
				resetEditorForNewDraft();
			}
		}
		if (!id) initLoadedFor = null;
	});

	// A tab can disappear when its platform override is removed.
	$effect(() => {
		if (activeTab !== 'global' && !tabs.includes(activeTab)) activeTab = 'global';
	});

	$effect(() => {
		void segments.length;
		if (focusedSegment > segments.length - 1) focusedSegment = Math.max(0, segments.length - 1);
		if (uploadingSegment !== null && uploadingSegment > segments.length - 1)
			uploadingSegment = null;
	});

	$effect(() => {
		// A draft that failed to load must not be baselined as "saved": that is
		// what turned the empty editor into an autosave target.
		if (loadFailedId) return;
		if (savedSnapshot === null) {
			savedSnapshot = takeSnapshot();
			return;
		}
		void baseBody;
		void overrides;
		void mastoVisibility;
		void mastoCW;
		void mastoPoll;
		void media;
		if (takeSnapshot() !== savedSnapshot) {
			dirty = true;
		} else if (!saving) {
			dirty = false;
		}
		if (!dirty || publishing || saving) return;
		// A load in flight owns the editor identity (and may merge local edits
		// into the stored copy): saving now could strand the keystrokes in a
		// second draft, so wait for it to settle.
		if (loadingDraftId) return;
		// Don't autosave while the user is deciding to discard: the save
		// could create/patch a draft between open and confirm.
		if (isDiscardOpen || discarding) return;
		const emptyNew = !draftId && !baseBody.trim();
		if (emptyNew) return;
		const timer = setTimeout(() => {
			void persistAll();
		}, 1400);
		return () => clearTimeout(timer);
	});

	beforeNavigate(() => {
		if (!dirty && Object.keys(altPending).length === 0) return;
		void persistAll(false, { navigate: false });
		void flushAltPending();
	});

	$effect(() => {
		const onBeforeUnload = (event: BeforeUnloadEvent) => {
			if (!dirty) return;
			event.preventDefault();
			event.returnValue = '';
		};
		window.addEventListener('beforeunload', onBeforeUnload);
		return () => window.removeEventListener('beforeunload', onBeforeUnload);
	});

	$effect(() => {
		const onKey = (event: KeyboardEvent) => {
			// Escape first, and before the publish guard below: the guard exists
			// so the compose shortcuts cannot fire while the confirm popover is
			// open, and it used to swallow Escape too — which is the one key a
			// keyboard user needs to get out of that popover.
			if (event.key === 'Escape') {
				scheduleOpen = false;
				if (isPostConfirmOpen) dismissPostConfirm();
				isAddOverrideOpen = false;
				isAccountsPopoverOpen = false;
				if (isMastoOptionsOpen) isMastoOptionsOpen = false;
				return;
			}
			if (pendingPublish) return;
			const meta = event.metaKey || event.ctrlKey;
			if (meta && event.key.toLowerCase() === 's') {
				event.preventDefault();
				void persistAll();
			}
			if (meta && event.key === 'Enter') {
				event.preventDefault();
				void onPublish();
			}
			// Alt+Arrow reorders thread posts while typing.
			if (
				event.altKey &&
				(event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
				document.activeElement?.hasAttribute('data-segment-index')
			) {
				const idx = Number(document.activeElement?.getAttribute('data-segment-index'));
				if (!Number.isNaN(idx)) {
					event.preventDefault();
					handleReorderKeyboard(idx, event.key === 'ArrowUp' ? -1 : 1);
				}
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});
</script>

<svelte:window onclick={handleWindowClick} />
<div
	class="relative mx-auto mb-8 flex w-full max-w-2xl flex-1 flex-col pb-32"
	data-testid="thread-preview"
>
	<h1 class="sr-only">Compose post</h1>
	{#if loadFailedId}
		<div
			role="alert"
			data-testid="draft-load-error"
			class="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-amber-200/70 bg-amber-50/60 px-4 py-3"
		>
			<p class="min-w-0 flex-1 text-[13px] font-medium text-amber-900">
				This draft could not be loaded. Saving is paused so an empty editor cannot overwrite the
				stored copy. Retry loads it, replacing anything typed here.
			</p>
			<button
				type="button"
				disabled={loadingDraftId !== null}
				onclick={() => {
					const id = loadFailedId;
					if (id) void loadDraft(id);
				}}
				class="rounded-full border border-amber-300 bg-white px-4 py-1.5 text-[12px] font-bold text-amber-900 transition-colors hover:bg-amber-100 disabled:opacity-50"
			>
				{loadingDraftId !== null ? 'Loading…' : 'Retry'}
			</button>
		</div>
	{/if}
	<!-- Platform Tabs (Always visible) -->
	<div class="relative mb-8 flex flex-wrap items-center gap-2 pt-2">
		<!-- Global Tab -->
		<button
			type="button"
			data-testid="editor-tab-global"
			aria-pressed={activeTab === 'global'}
			class="flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px] font-bold whitespace-nowrap transition-all {activeTab ===
			'global'
				? 'bg-stone-900 text-white shadow-md'
				: 'border border-stone-200/80 bg-white text-stone-500 hover:border-stone-300 hover:text-stone-900 hover:shadow-sm'}"
			onclick={() => (activeTab = 'global')}
		>
			Global
		</button>

		<!-- Active Overrides -->
		{#each tabs.filter((t) => t !== 'global') as platform (platform)}
			{@const status = getPlatformStatus(platform)}
			{@const rep = representativeAccount(platform)}
			<div
				class="flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px] font-bold whitespace-nowrap transition-all {activeTab ===
				platform
					? 'bg-stone-900 text-white shadow-md'
					: 'border border-stone-200/80 bg-white text-stone-500 hover:border-stone-300 hover:text-stone-900 hover:shadow-sm'}"
			>
				<button
					type="button"
					data-testid="editor-tab-{platform}"
					class="flex items-center gap-2"
					aria-pressed={activeTab === platform}
					onclick={() => (activeTab = platform)}
				>
					<SocialIcon
						{platform}
						className={`h-3.5 w-3.5 ${activeTab === platform ? '' : platformColorClass(platform)}`}
					/>
					{rep?.displayName || displayHandle(rep?.handle) || platformName(platform)}
				</button>
				{#if status.hasError}
					<div
						class="ml-0.5 h-2 w-2 rounded-full border-2 border-white bg-red-500"
						title="Character limit exceeded"
						role="img"
						aria-label={`${platformName(platform)} over character limit`}
					></div>
				{:else}
					<button
						type="button"
						data-testid="reset-platform-tab"
						class="-mr-1.5 ml-0.5 flex items-center justify-center rounded-full p-1 transition-colors {activeTab ===
						platform
							? 'text-stone-300 hover:bg-stone-700 hover:text-white'
							: 'text-stone-500 hover:bg-stone-100 hover:text-stone-900'}"
						title="Unlinked from Global. Click to re-sync."
						onclick={() => resetToGlobal(platform)}
					>
						<Link2Off class="h-3 w-3" />
					</button>
				{/if}
			</div>
		{/each}

		<!-- Add Override Dropdown -->
		{#if canAddOverride}
			<div class="mx-1 hidden h-4 w-px bg-stone-200 sm:block"></div>
			<div class="override-dropdown-container relative">
				<button
					type="button"
					data-testid="add-override-toggle"
					class="flex items-center gap-1.5 rounded-full border border-dashed border-stone-200 px-3 py-1.5 text-[12px] font-bold whitespace-nowrap text-stone-500 transition-colors hover:border-stone-300 hover:bg-stone-100 hover:text-stone-900"
					onclick={(e) => {
						e.stopPropagation();
						isAddOverrideOpen = !isAddOverrideOpen;
					}}
				>
					<Plus class="h-3 w-3" /> Add override...
				</button>

				{#if isAddOverrideOpen}
					<div
						class="absolute top-full left-0 z-40 mt-2 w-48 rounded-[1rem] border border-stone-200/80 bg-white p-2 shadow-[0_16px_40px_-12px_rgb(28_25_23/0.15)]"
						transition:slide={{ duration: 150 }}
					>
						<div class="mb-1 px-2 py-1">
							<span class="text-[10px] font-bold tracking-widest text-stone-500 uppercase"
								>Select Account</span
							>
						</div>
						{#each selectedAccounts.filter((a) => !isPlatformCustomized(overrides, a.platform as PlatformId)) as account (account.id)}
							<button
								type="button"
								class="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-stone-50"
								onclick={() => addOverride(account.id)}
							>
								<AccountAvatar
									platform={account.platform}
									handle={account.handle}
									displayName={account.displayName}
									avatarUrl={account.avatarUrl}
									size={24}
									title={accountLabel(account.displayName, account.handle) || undefined}
								/>
								<span class="truncate text-[12px] font-bold text-stone-700"
									>{account.displayName ||
										displayHandle(account.handle) ||
										platformName(account.platform)}</span
								>
							</button>
						{/each}
					</div>
				{/if}
			</div>
		{/if}

		<!-- Mastodon Options Popover Button -->
		{#if showMastoOptions}
			<div class="mx-1 hidden h-4 w-px bg-stone-200 sm:block"></div>
			<div class="masto-options-container relative" data-testid="masto-options">
				<button
					type="button"
					data-testid="masto-settings-toggle"
					class="flex items-center gap-1.5 rounded-full border border-stone-200 px-3 py-1.5 text-[12px] font-bold whitespace-nowrap text-stone-500 transition-colors hover:border-stone-300 hover:bg-stone-100 hover:text-stone-900"
					onclick={(e) => {
						e.stopPropagation();
						isMastoOptionsOpen = !isMastoOptionsOpen;
					}}
				>
					<Settings class="h-3 w-3" /> Mastodon
				</button>

				{#if isMastoOptionsOpen}
					<div
						class="absolute top-full left-0 z-40 mt-2 w-64 rounded-[1rem] border border-stone-200/80 bg-white p-3 shadow-[0_16px_40px_-12px_rgb(28_25_23/0.15)]"
						transition:slide={{ duration: 150 }}
					>
						<div class="mb-2">
							<span class="text-[10px] font-bold tracking-widest text-stone-500 uppercase"
								>Mastodon Options</span
							>
						</div>
						<div class="flex flex-col gap-3">
							<label class="flex flex-col gap-1.5 text-[11px] font-bold text-stone-500">
								Visibility
								<select
									data-testid="masto-visibility"
									value={mastoVisibility}
									onchange={(e) => {
										mastoVisibility = e.currentTarget.value as typeof mastoVisibility;
										markDirty();
									}}
									class="rounded-lg border border-stone-200 bg-stone-50 px-2.5 py-1.5 text-[12px] font-bold text-stone-900 focus:border-stone-400 focus:bg-white focus:outline-none pointer-coarse:text-base"
								>
									<option value="public">Public</option>
									<option value="unlisted">Unlisted</option>
									<option value="private">Followers</option>
									<option value="direct">Direct</option>
								</select>
							</label>
							<label class="flex flex-col gap-1.5 text-[11px] font-bold text-stone-500">
								Content Warning
								<input
									type="text"
									data-testid="masto-cw"
									value={mastoCW}
									placeholder="Optional"
									aria-label="Content warning (optional)"
									oninput={(e) => {
										mastoCW = e.currentTarget.value;
										markDirty();
									}}
									class="w-full rounded-lg border border-stone-200 bg-stone-50 px-3 py-1.5 text-[12px] font-medium text-stone-900 placeholder:text-stone-500 focus:border-stone-400 focus:bg-white focus:outline-none pointer-coarse:text-base"
								/>
							</label>
						</div>
					</div>
				{/if}
			</div>
		{/if}

		{#if saveIndicator}
			<p
				data-testid="save-status"
				class="ml-auto flex items-center gap-1 text-[12px] font-bold whitespace-nowrap {saveIndicator ===
				'failed'
					? 'text-red-600'
					: 'text-stone-500'}"
			>
				{#if saveIndicator === 'failed'}
					Not saved ·
					<button
						type="button"
						disabled={saving}
						onclick={() => void persistAll()}
						class="-my-3 inline-flex min-h-11 items-center underline-offset-2 hover:underline disabled:opacity-50"
					>
						Retry
					</button>
				{:else if saveIndicator === 'saving'}
					Saving…
				{:else}
					<Check class="h-3.5 w-3.5" /> Saved
				{/if}
			</p>
		{/if}
	</div>

	<!-- Body: Threads -->
	<div class="relative flex-1">
		<div class="flex flex-col gap-6">
			{#each segments as segment, index (index)}
				{@const segLen = countForCard(segment)}
				{@const isOver = segLen > maxChars}
				{@const segMedia = cardMedia(index)}
				<div class="group relative flex gap-4 sm:gap-6">
					<!-- Avatar / Node -->
					<div class="relative z-10 hidden flex-shrink-0 flex-col items-center sm:flex">
						{#if avatarSrc && failedAvatarSrc !== avatarSrc}
							<img
								src={avatarSrc}
								alt="Avatar"
								referrerpolicy="no-referrer"
								class="relative z-10 h-10 w-10 rounded-full border-[3px] border-stone-50 bg-white object-cover shadow-sm"
								onerror={() => (failedAvatarSrc = avatarSrc)}
							/>
						{:else}
							<span
								class="relative z-10 flex h-10 w-10 items-center justify-center rounded-full border-[3px] border-stone-50 bg-stone-200 text-[11px] font-bold text-stone-700 shadow-sm"
								aria-hidden="true"
							>
								{#if avatarInitials}
									{avatarInitials}
								{:else}
									<User class="h-4 w-4" />
								{/if}
							</span>
						{/if}
						{#if index < segments.length - 1}
							<div
								class="absolute top-10 bottom-[-24px] left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-stone-200/80"
							></div>
						{/if}
					</div>

					<!-- Input Area. min-w-0 is load-bearing: the link preview's title
					truncates (nowrap), and a flex item's default min-width:auto let
					that one line set this card's min-content width, stretching the
					card past the composer column instead of ellipsizing. -->
					<div
						data-testid="segment-card-{index}"
						class="flex min-w-0 flex-1 flex-col rounded-[1.5rem] border border-stone-200/80 bg-white p-5 shadow-[0_4px_24px_-8px_rgb(28_25_23/0.06)] transition-all focus-within:border-stone-500 focus-within:shadow-[0_8px_30px_-12px_rgb(28_25_23/0.12)] focus-within:ring-2 focus-within:ring-stone-900/10"
					>
						<textarea
							use:autoResize={segment}
							bind:this={textareaRefs[index]}
							value={segment}
							data-segment-index={index}
							data-testid="segment-input-{index}"
							oninput={(e) => handleSegmentInput(index, e)}
							onpaste={(e) => handlePaste(e, index)}
							ondrop={(e) => handleDrop(e, index)}
							ondragover={(e) => e.preventDefault()}
							placeholder={index === 0 ? "What's happening?" : 'Add another post...'}
							aria-label={index === 0 ? 'Post text' : `Post ${index + 1} text`}
							class="w-full resize-none bg-transparent text-[15px] font-medium text-stone-900 placeholder:text-stone-500 focus:outline-none pointer-coarse:text-base"
							rows="1"></textarea>

						{#if segMedia.length > 0}
							<div class="mt-3 flex flex-wrap gap-2" data-testid="segment-media-{index}">
								{#each segMedia as m (m.id)}
									{@const hasAlt = Boolean((m.altText || '').trim())}
									<div class="group/media relative">
										{#if (m.mime || '').startsWith('video/')}
											<!-- svelte-ignore a11y_media_has_caption -->
											<video
												src={m.previewUrl || `/api/media/${encodeURIComponent(m.storageKey)}`}
												controls
												preload="none"
												width="80"
												height="80"
												aria-label={`Attached video ${index + 1} (no captions)`}
												class="h-20 w-20 rounded-xl border border-stone-200/80 bg-black object-cover"
											></video>
										{:else}
											<img
												src={m.previewUrl || `/api/media/${encodeURIComponent(m.storageKey)}`}
												alt={m.altText || ''}
												loading="lazy"
												decoding="async"
												width="80"
												height="80"
												class="h-20 w-20 rounded-xl border border-stone-200/80 object-cover"
											/>
										{/if}
										<button
											type="button"
											data-testid="alt-toggle-{m.id}"
											onclick={() => toggleAlt(m.id)}
											class="absolute -top-1.5 -right-1.5 z-10 min-h-6 min-w-6 rounded-md px-1 py-px text-[9px] font-bold tracking-wide shadow-sm {hasAlt
												? 'bg-black/60 text-white'
												: 'bg-amber-400 text-black'}"
											title={hasAlt ? 'Edit alt text' : 'Add alt text (accessibility)'}
											aria-label={hasAlt
												? `Edit alt text for image ${index + 1}`
												: `Add alt text for image ${index + 1}`}
										>
											ALT
										</button>
										<button
											type="button"
											data-testid="remove-media-{m.id}"
											onclick={() => requestRemoveMedia(m.id)}
											class="absolute -right-1.5 -bottom-1.5 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-focus-within/media:opacity-100 group-hover/media:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
											title={`Remove ${(m.mime || '').startsWith('video/') ? 'video' : 'image'} ${index + 1}`}
											aria-label={`Remove ${(m.mime || '').startsWith('video/') ? 'video' : 'image'} ${index + 1}`}
										>
											<svg width="8" height="8" viewBox="0 0 12 12" fill="none" aria-hidden="true">
												<path
													d="M2 2l8 8M10 2l-8 8"
													stroke="currentColor"
													stroke-width="1.6"
													stroke-linecap="round"
												/>
											</svg>
										</button>
									</div>
								{/each}
							</div>
						{/if}

						{#each segMedia as m (m.id)}
							{#if altOpen[m.id]}
								<!-- In flow under the media strip: as a thumb-anchored popover this
								     hung off the right edge whenever the thumb was not the first. -->
								<div class="mt-2 rounded-xl border border-stone-200/80 bg-white p-2 shadow-sm">
									<input
										type="text"
										value={m.altText || ''}
										data-testid="media-alt-{m.id}"
										oninput={(e) => updateMediaAlt(m.id, e.currentTarget.value)}
										placeholder="Describe this image…"
										aria-label={`Alt text for image ${index + 1}`}
										class="w-full rounded-lg border border-stone-200 bg-stone-50 px-2 py-1 text-[11px] font-medium text-stone-900 focus:border-stone-400 focus:bg-white focus:outline-none pointer-coarse:text-base"
									/>
									<div class="mt-1 flex justify-end">
										<button
											type="button"
											data-testid="alt-done-{m.id}"
											onclick={() => toggleAlt(m.id)}
											class="text-[11px] font-bold text-stone-900 hover:underline">Done</button
										>
									</div>
								</div>
							{/if}
						{/each}

						<LinkPreview text={segment} hasMedia={segMedia.length > 0} />

						<!-- Thread Tools -->
						<div class="mt-3 flex items-center justify-between border-t border-stone-100 pt-3">
							<!-- Left: Tools -->
							<div
								class="flex items-center gap-2 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
							>
								{#if tabSupportsThreads}
									{#if index === segments.length - 1}
										<button
											type="button"
											data-testid="add-thread-post"
											onclick={onAddSegment}
											class="flex items-center gap-1.5 rounded-full border border-stone-100 bg-stone-50 px-3 py-1.5 text-[12px] font-bold text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-900"
										>
											<Plus class="h-3.5 w-3.5" /> Thread
										</button>
									{/if}
								{/if}
								{#if segments.length > 1}
									<button
										type="button"
										data-testid="remove-segment-{index}"
										onclick={() => onRemoveSegment(index)}
										class="flex items-center justify-center rounded-lg p-1.5 text-red-600 transition-colors hover:bg-red-50 hover:text-red-700"
										title="Remove post from thread"
										aria-label="Remove post from thread"
									>
										<Trash2 class="h-3.5 w-3.5" />
									</button>
								{:else if index === 0 && canDiscard}
									<button
										type="button"
										data-testid="discard-draft"
										onclick={requestDiscard}
										class="flex items-center justify-center rounded-lg p-1.5 text-red-600 transition-colors hover:bg-red-50 hover:text-red-700"
										title="Discard draft"
										aria-label="Discard draft"
									>
										<Trash2 class="h-3.5 w-3.5" />
									</button>
								{/if}
							</div>

							<!-- Right: Image & Char Count -->
							<div class="flex items-center gap-3">
								<button
									type="button"
									data-testid="attach-image-{index}"
									disabled={uploadingSegment === index}
									class="flex items-center justify-center rounded-lg p-1.5 text-stone-500 opacity-0 transition-all group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-stone-50 hover:text-stone-900 disabled:opacity-40 pointer-coarse:opacity-100"
									aria-label={uploadingSegment === index
										? `Uploading to post ${index + 1}`
										: `Add image to post ${index + 1}`}
									title={uploadingSegment === index ? 'Uploading…' : 'Add Image'}
									onclick={() => fileRefs[index]?.click()}
								>
									<ImageIcon class="h-4 w-4" />
								</button>
								<input
									bind:this={fileRefs[index]}
									type="file"
									accept={ACCEPTED_MEDIA}
									multiple
									class="hidden"
									data-testid="file-input-{index}"
									onchange={(e) => {
										const list = e.currentTarget.files;
										if (list?.length) void attachFilesToSegment(index, Array.from(list));
										e.currentTarget.value = '';
									}}
								/>
								<div
									data-testid="segment-count-{index}"
									class="rounded-full px-2.5 py-1 text-[11px] font-bold tracking-wider transition-colors {isOver
										? 'border border-red-100 bg-red-50 text-red-600'
										: 'border border-stone-100 bg-stone-50 text-stone-500'}"
								>
									{segLen}/{maxChars}
								</div>
							</div>
						</div>
					</div>
				</div>
			{/each}
		</div>
	</div>

	<!-- Floating Bottom Action Dock -->
	<div
		class="pointer-events-none fixed bottom-[max(2rem,env(safe-area-inset-bottom))] left-1/2 z-30 w-full max-w-2xl -translate-x-1/2 px-4 sm:px-6"
	>
		<div class="flex items-center justify-center gap-4">
			<!-- Left side: Account Selector -->
			<div class="accounts-popover-container pointer-events-auto relative flex items-center">
				<button
					type="button"
					data-testid="destinations-toggle"
					class="flex items-center gap-2 rounded-full border border-stone-200/80 bg-white/95 px-4 py-2.5 text-[13px] font-bold text-stone-700 shadow-[0_16px_40px_-12px_rgb(28_25_23/0.15)] backdrop-blur-xl transition-all hover:border-stone-300 hover:bg-white {isAccountsPopoverOpen
						? 'border-stone-300 bg-stone-50'
						: ''}"
					onclick={openDestinations}
					aria-haspopup="dialog"
					aria-expanded={isAccountsPopoverOpen}
				>
					<div class="mr-0.5 flex -space-x-1.5">
						{#each selectedAccounts.slice(0, 3) as account (account.id)}
							<div
								class="z-10 flex h-[20px] w-[20px] items-center justify-center rounded-full border-2 border-white bg-stone-100"
							>
								<SocialIcon
									platform={account.platform}
									className={`h-2.5 w-2.5 ${platformColorClass(account.platform)}`}
								/>
							</div>
						{/each}
					</div>
					<span
						>{selectedAccounts.length}
						<span class="hidden sm:inline">selected</span></span
					>
					<ChevronUp
						class="ml-1 h-3.5 w-3.5 text-stone-500 transition-transform {isAccountsPopoverOpen
							? 'rotate-180'
							: ''}"
					/>
				</button>

				<!-- Sleek Popover Menu -->
				{#if isAccountsPopoverOpen}
					<div
						class="absolute bottom-full left-0 z-40 mb-3 w-72 rounded-[1.5rem] border border-stone-200/80 bg-white p-2 shadow-[0_16px_40px_-12px_rgb(28_25_23/0.15)]"
						transition:slide={{ duration: 200 }}
						role="dialog"
						aria-label="Destinations"
					>
						<div class="mb-2 flex items-center justify-between border-b border-stone-100 px-3 py-2">
							<span class="text-[11px] font-bold tracking-widest text-stone-500 uppercase"
								>Destinations</span
							>
							<button
								type="button"
								onclick={clearSelection}
								disabled={selected.size === 0}
								class="rounded-md bg-stone-100 px-2.5 py-1 text-[11px] font-bold text-stone-700 transition hover:bg-stone-200 hover:text-stone-900 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-stone-100 disabled:hover:text-stone-700"
							>
								Clear all
							</button>
						</div>

						<div class="max-h-[40vh] space-y-1 overflow-y-auto px-1 pb-2">
							{#each sortedConnections as account (account.id)}
								{@const isSelected = selected.has(account.id)}
								{@const needsReconnect = account.status && account.status !== 'active'}
								<div
									class="group flex w-full items-center gap-1 rounded-xl px-2 py-1.5 transition-colors {isSelected
										? 'bg-stone-50/80'
										: 'hover:bg-stone-50/50'}"
								>
									<button
										type="button"
										class="flex min-w-0 flex-1 items-center gap-3 text-left"
										onclick={() => toggleAccountSelection(account.id)}
										aria-pressed={isSelected}
										title={`${platformName(account.platform)}: ${account.displayName || account.handle || ''}`}
									>
										<AccountAvatar
											platform={account.platform}
											handle={account.handle}
											displayName={account.displayName}
											avatarUrl={account.avatarUrl}
											size={24}
											title={accountLabel(account.displayName, account.handle) || undefined}
										/>
										<span
											class="min-w-0 flex-1 truncate text-[13px] font-bold {isSelected
												? 'text-stone-900'
												: 'text-stone-600'}"
										>
											{account.displayName ||
												displayHandle(account.handle) ||
												platformName(account.platform)}
										</span>
										{#if needsReconnect}
											<span class="shrink-0 text-[11px] font-bold text-red-500"
												>needs reconnect</span
											>
										{/if}
										<span
											aria-hidden="true"
											class="flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors {isSelected
												? 'border-stone-900 bg-stone-900 text-white'
												: 'border-stone-200 text-transparent'}"
										>
											<Check class="h-3 w-3" />
										</span>
									</button>
									<div class="flex shrink-0 items-center gap-2">
										{#if needsReconnect}
											<button
												type="button"
												onclick={() => void verifyConnection(account.id)}
												disabled={reconnecting === account.id}
												class="text-[11px] font-bold text-stone-900 underline"
											>
												{reconnecting === account.id ? 'Checking…' : 'Reconnect'}
											</button>
										{/if}
										{#if !needsReconnect && sortedConnections.length > 1}
											<button
												type="button"
												onclick={() => selectOnly(account.id)}
												title={`Post only to ${account.displayName || account.handle || platformName(account.platform)}`}
												aria-label={`Select only ${account.displayName || account.handle || platformName(account.platform)}`}
												class="rounded bg-stone-200 px-2 py-0.5 text-[10px] font-bold text-stone-600 shadow-sm transition hover:bg-stone-300 sm:pointer-events-none sm:opacity-0 sm:group-focus-within:pointer-events-auto sm:group-focus-within:opacity-100 sm:group-hover:pointer-events-auto sm:group-hover:opacity-100 sm:focus-visible:pointer-events-auto sm:focus-visible:opacity-100"
											>
												ONLY
											</button>
										{/if}
									</div>
								</div>
							{/each}
							{#if connections.length === 0}
								<div class="px-3 py-4 text-center">
									<p class="text-[13px] font-bold text-stone-900">Connect an account first</p>
									<p class="mt-1 text-[12px] font-medium text-stone-500">
										Add one, then come back to write.
									</p>
									<a
										href="/accounts"
										class="mt-3 inline-flex rounded-full bg-stone-900 px-4 py-2 text-[12px] font-bold text-white"
										>Open accounts</a
									>
								</div>
							{/if}
						</div>
					</div>
				{/if}
			</div>

			<!-- Right side: Split Post Button -->
			<div
				class="post-actions-container pointer-events-auto relative flex items-center rounded-full bg-stone-900 text-white shadow-[0_16px_40px_-12px_rgb(28_25_23/0.3)]"
			>
				<button
					type="button"
					data-testid="publish-now"
					class="flex cursor-pointer items-center gap-2 rounded-l-full px-6 py-2.5 text-[13px] font-bold transition-all hover:bg-stone-800 disabled:opacity-60"
					disabled={publishing}
					aria-busy={publishButtonBusy}
					onclick={() => void onPublish()}
				>
					<span>{publishButtonLabel}</span>
					{#if publishButtonBusy}
						<LoaderCircle class="h-3.5 w-3.5 animate-spin" />
					{:else}
						<Send class="h-3.5 w-3.5" />
					{/if}
				</button>
				<div class="h-5 w-px bg-stone-700/80"></div>
				<button
					type="button"
					data-testid="schedule-toggle"
					class="group flex cursor-pointer items-center justify-center rounded-r-full px-4 py-2.5 transition-all hover:bg-stone-800"
					title="Schedule Options"
					aria-label="Schedule Options"
					aria-expanded={scheduleOpen}
					disabled={publishing}
					onclick={openSchedule}
				>
					<Calendar class="h-4 w-4 text-stone-300 transition-colors group-hover:text-white" />
				</button>

				<!-- Post Confirmation Popover -->
				{#if isPostConfirmOpen && pendingPublish}
					<div
						class="absolute right-0 bottom-full z-40 mb-3 w-64 origin-bottom-right rounded-[1.5rem] border border-stone-200/80 bg-white/95 p-3 text-stone-900 shadow-[0_12px_40px_-12px_rgb(28_25_23/0.15)] backdrop-blur-xl"
						transition:fly={{ y: 10, duration: 250, opacity: 0 }}
						role="dialog"
						aria-label={publishProgress?.some((d) => d.status === 'failed')
							? 'Publish results'
							: 'Confirm post'}
						use:dialogFocus={{
							onEscape: () => dismissPostConfirm(),
							// Publishing is not destructive — the draft is saved — so
							// the confirm button is preferred. It is disabled while
							// the draft is still being saved, and the action falls
							// back to the first control that can take focus.
							initial: publishNowBtn
						}}
					>
						<div class="px-2 pt-2 pb-4 text-center">
							{#if publishProgress?.some((d) => d.status === 'failed')}
								<h4 class="mb-1 text-[14px] font-extrabold text-stone-900">
									Couldn’t publish everywhere
								</h4>
								<p class="text-[12px] font-medium text-stone-500">
									Fix the problems below, then retry from Posts.
								</p>
							{:else}
								<h4 class="mb-1 text-[14px] font-extrabold text-stone-900">Confirm Post</h4>
								<p class="text-[12px] font-medium text-stone-500">
									Publishing to {pendingAccounts.length}
									{pendingAccounts.length === 1 ? 'destination' : 'destinations'}.
								</p>
							{/if}
						</div>

						<div
							class="mb-4 flex justify-center -space-x-2"
							data-testid="publish-confirm-destinations"
						>
							{#each pendingAccounts as account (account.id)}
								{@const state = publishProgress?.find((d) => d.connectionId === account.id)}
								<div
									class="relative flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-stone-50 shadow-sm"
									title="{platformName(account.platform)}: {account.displayName || account.handle}"
								>
									<SocialIcon
										platform={account.platform}
										className={`h-3.5 w-3.5 ${platformColorClass(account.platform)}`}
									/>
									{#if state?.status === 'published'}
										<span
											class="absolute -right-1 -bottom-1 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-white"
										>
											<Check class="h-2.5 w-2.5" />
										</span>
									{:else if state?.status === 'failed'}
										<span
											class="absolute -right-1 -bottom-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-white"
										>
											<X class="h-2.5 w-2.5" />
										</span>
									{/if}
								</div>
							{/each}
						</div>

						{#if publishProgress?.some((d) => d.status === 'failed')}
							<ul class="mb-3 space-y-1.5" data-testid="publish-progress">
								{#each publishProgress ?? [] as dest (dest.connectionId)}
									<li
										class="flex items-start gap-2 rounded-xl bg-stone-50 px-2.5 py-2"
										data-testid="publish-dest"
										data-status={dest.status}
									>
										{#if dest.status === 'pending' || dest.status === 'publishing'}
											<LoaderCircle
												class="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-stone-500"
											/>
											<span class="text-[11px] font-bold text-stone-600">
												{destinationName(dest.connectionId)} — publishing…
											</span>
										{:else if dest.status === 'published'}
											<Check class="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
											<span class="text-[11px] font-bold text-stone-700">
												{destinationName(dest.connectionId)} — published
											</span>
										{:else if dest.status === 'retrying'}
											<RefreshCw class="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
											<span
												class="min-w-0 flex-1 text-[11px] font-medium break-words text-amber-700"
											>
												{destinationName(dest.connectionId)}: {dest.error ||
													'retrying automatically'}
												— retrying automatically
											</span>
										{:else}
											<X class="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
											<span class="min-w-0 flex-1 text-[11px] font-medium break-words text-red-600">
												{destinationName(dest.connectionId)}: {dest.error || 'Publish failed'}
											</span>
										{/if}
									</li>
								{/each}
							</ul>
						{/if}

						{#if publishProgress?.some((d) => d.status === 'failed')}
							<button
								type="button"
								data-testid="publish-progress-close"
								class="w-full cursor-pointer rounded-full bg-stone-900 py-2.5 text-[13px] font-bold text-white shadow-sm transition-all hover:bg-stone-800"
								onclick={() => dismissPostConfirm()}
							>
								Close
							</button>
						{:else}
							<button
								type="button"
								bind:this={publishNowBtn}
								data-testid="confirm-dialog-ok"
								class="flex w-full cursor-pointer items-center justify-center gap-2 rounded-full bg-stone-900 py-2.5 text-[13px] font-bold text-white shadow-sm transition-all hover:bg-stone-800 disabled:opacity-60"
								disabled={pendingPublish?.saving || !pendingPublish?.draftId}
								onclick={() => void confirmPublish()}
							>
								{pendingPublish?.saving ? 'Saving…' : 'Publish Now'}
								<Send class="h-3.5 w-3.5" />
							</button>
							<button
								type="button"
								class="mt-1 w-full rounded-full py-1.5 text-[12px] font-bold text-stone-500 transition-colors hover:text-stone-900"
								onclick={() => dismissPostConfirm()}
							>
								Keep editing
							</button>
							<label
								class="mt-1 flex items-center justify-center gap-1.5 text-[11px] font-medium text-stone-500"
							>
								<input
									type="checkbox"
									checked={skipAsk}
									onchange={(e) => {
										skipAsk = e.currentTarget.checked;
										setLocalFlag(SKIP_ASK_KEY, skipAsk);
									}}
								/>
								Publish without asking next time
							</label>
						{/if}
					</div>
				{/if}

				<!-- Schedule Popover -->
				{#if scheduleOpen}
					<div
						data-testid="schedule-panel"
						class="absolute right-0 bottom-full z-40 mb-3 w-72 origin-bottom-right rounded-[1.5rem] border border-stone-200/80 bg-white/95 p-3 text-stone-900 shadow-[0_12px_40px_-12px_rgb(28_25_23/0.15)] backdrop-blur-xl"
						transition:fly={{ y: 10, duration: 250, opacity: 0 }}
						role="dialog"
						aria-label="Schedule post"
					>
						<div class="flex items-center gap-2 px-2 pt-2 pb-3">
							<Calendar class="h-4 w-4 text-stone-900" />
							<h4 class="text-[14px] font-extrabold text-stone-900">Schedule Post</h4>
						</div>

						<div class="mx-1 mb-4 flex rounded-lg bg-stone-100 p-1">
							<button
								type="button"
								class="flex-1 rounded-md py-1.5 text-[12px] font-bold transition-colors {scheduleMode ===
								'relative'
									? 'bg-white text-stone-900 shadow-sm'
									: 'text-stone-500 hover:text-stone-900'}"
								onclick={() => {
									scheduleMode = 'relative';
									scheduleTouched = true;
									applyRelativeFields();
								}}
							>
								Relative
							</button>
							<button
								type="button"
								class="flex-1 rounded-md py-1.5 text-[12px] font-bold transition-colors {scheduleMode ===
								'absolute'
									? 'bg-white text-stone-900 shadow-sm'
									: 'text-stone-500 hover:text-stone-900'}"
								onclick={() => {
									scheduleMode = 'absolute';
								}}
							>
								Specific Date
							</button>
						</div>

						{#if scheduleMode === 'relative'}
							<div class="mb-4 flex flex-col gap-2 px-1" data-testid="schedule-offsets">
								<span class="text-[10px] font-bold tracking-widest text-stone-500 uppercase"
									>Publish in</span
								>
								<label class="flex items-center gap-2">
									<input
										type="number"
										min="1"
										data-testid="schedule-offset-value"
										aria-label="Publish in amount"
										bind:value={relativeValue}
										oninput={() => {
											scheduleTouched = true;
											applyRelativeFields();
										}}
										class="w-20 rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-center text-[13px] font-bold text-stone-900 transition-colors focus:border-stone-400 focus:bg-white focus:outline-none pointer-coarse:text-base"
									/>
									<select
										data-testid="schedule-offset-unit"
										aria-label="Publish in unit"
										bind:value={relativeUnit}
										onchange={() => {
											scheduleTouched = true;
											applyRelativeFields();
										}}
										class="flex-1 appearance-none rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-[13px] font-bold text-stone-900 transition-colors focus:border-stone-400 focus:bg-white focus:outline-none pointer-coarse:text-base"
									>
										<option value="mins">Minutes</option>
										<option value="hours">Hours</option>
										<option value="days">Days</option>
									</select>
								</label>
							</div>
						{:else}
							<div class="mb-4 flex flex-col gap-2 px-1">
								<span class="text-[10px] font-bold tracking-widest text-stone-500 uppercase"
									>Publish at ({tzShort})</span
								>
								<!-- At the 16px a touch screen needs, the two pickers no longer fit
								     side by side in the popover. -->
								<div class="flex gap-2 pointer-coarse:flex-col">
									<div class="flex-1">
										<input
											type="date"
											data-testid="schedule-date"
											bind:value={schedDate}
											oninput={() => (scheduleTouched = true)}
											min={minSchedDate}
											aria-label="Schedule date"
											class="w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-[13px] font-bold text-stone-900 transition-colors focus:border-stone-400 focus:bg-white focus:outline-none pointer-coarse:text-base"
										/>
									</div>
									<div class="flex-1">
										<input
											type="time"
											data-testid="schedule-time"
											bind:value={schedTime}
											oninput={() => (scheduleTouched = true)}
											aria-label="Schedule time"
											class="w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-[13px] font-bold text-stone-900 transition-colors focus:border-stone-400 focus:bg-white focus:outline-none pointer-coarse:text-base"
										/>
									</div>
								</div>
							</div>
						{/if}

						{#if schedulePreview}
							<p
								data-testid="schedule-preview"
								class="mb-3 px-2 text-center text-[12px] font-bold text-stone-500"
							>
								Will publish {schedulePreview}
							</p>
						{/if}

						<button
							type="button"
							data-testid="schedule-confirm"
							class="w-full cursor-pointer rounded-full bg-stone-900 py-2.5 text-[13px] font-bold text-white shadow-sm transition-all hover:bg-stone-800 disabled:opacity-60"
							disabled={publishing}
							onclick={() => void onSchedule()}
						>
							Confirm Schedule
						</button>
					</div>
				{/if}
			</div>
		</div>
	</div>

	<!-- Toast -->
	<!-- Publishing progress/results for screen readers (the popover closes while publishing). -->
	<!-- The live region repeats the toast's wording, so it has its own test id: a
	     `getByText` for a publish message matches both once the announcement
	     lands (30 ms later), which is a strict-mode violation rather than a
	     passing assertion. -->
	<div class="sr-only" role="status" aria-live="polite" data-testid="publish-announcement">
		{publishAnnouncement}
	</div>
	{#if toastMessage}
		{@const tone = toastTone}
		<div
			class="pointer-events-none fixed bottom-[calc(6rem+env(safe-area-inset-bottom))] left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2.5 rounded-full border border-stone-200/80 bg-white/95 px-4 py-2.5 shadow-[0_8px_30px_-12px_rgb(28_25_23/0.15)] backdrop-blur-xl"
			transition:fly={{ y: 20, duration: 300, opacity: 0 }}
			role={tone === 'error' ? 'alert' : 'status'}
			data-testid="publish-toast"
		>
			<div
				class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-white {tone ===
				'success'
					? 'bg-emerald-500'
					: tone === 'warn'
						? 'bg-amber-500'
						: 'bg-red-500'}"
			>
				{#if tone === 'success'}
					<Check class="h-3.5 w-3.5" strokeWidth={3} />
				{:else if tone === 'warn'}
					<TriangleAlert class="h-3.5 w-3.5" strokeWidth={2.5} />
				{:else}
					<X class="h-3.5 w-3.5" strokeWidth={3} />
				{/if}
			</div>
			<span
				class="max-w-64 truncate text-[13px] font-bold tracking-tight text-stone-700 sm:max-w-96"
				title={toastMessage}>{toastMessage}</span
			>
			{#if toastAction}
				<a
					href={toastAction.href}
					data-testid="toast-action"
					class="pointer-events-auto shrink-0 rounded-full bg-stone-900 px-3 py-1 text-[12px] font-bold text-white transition-colors hover:bg-stone-700"
				>
					{toastAction.label}
				</a>
			{/if}
			{#if tone === 'error'}
				<button
					type="button"
					data-testid="toast-dismiss"
					onclick={dismissToast}
					aria-label="Dismiss error"
					class="pointer-events-auto -mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-900"
				>
					<X class="h-3.5 w-3.5" />
				</button>
			{/if}
		</div>
	{/if}
</div>

<ConfirmDialog
	open={isDiscardOpen}
	idPrefix="discard-draft-dialog"
	title="Discard this draft?"
	body="This will permanently delete the draft and its images. This cannot be undone."
	confirmLabel="Discard"
	cancelLabel="Keep"
	tone="danger"
	busy={discarding || saving || publishing}
	onConfirm={() => void confirmDiscard()}
	onCancel={() => {
		if (!discarding) isDiscardOpen = false;
	}}
/>

{#if pendingMediaRemove}
	<div
		role="presentation"
		class="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
		onclick={(e) => {
			if (e.target === e.currentTarget) pendingMediaRemove = null;
		}}
	>
		<div
			role="alertdialog"
			aria-modal="true"
			aria-labelledby="remove-media-title"
			aria-describedby="remove-media-body"
			class="w-full max-w-sm rounded-[1.5rem] border border-stone-200/80 bg-white/95 p-5 shadow-xl backdrop-blur-xl"
			use:dialogFocus={{
				initial: keepMediaBtn,
				// Always dismissable: closing does not cancel the request, and a
				// hung DELETE must not trap a keyboard user in the dialog.
				onEscape: () => (pendingMediaRemove = null)
			}}
		>
			<h2 id="remove-media-title" class="text-sm font-extrabold text-stone-900">
				Remove this image?
			</h2>
			<p id="remove-media-body" class="mt-1 text-sm font-medium text-stone-500">
				It will be deleted from this draft.
			</p>
			<div class="mt-4 flex justify-end gap-2">
				<button
					type="button"
					bind:this={keepMediaBtn}
					disabled={mediaBusy}
					onclick={() => (pendingMediaRemove = null)}
					class="rounded-full border border-stone-200/80 px-4 py-1.5 text-sm font-bold text-stone-600 disabled:opacity-50"
				>
					Keep
				</button>
				<button
					type="button"
					data-testid="confirm-dialog-ok-media"
					disabled={mediaBusy}
					onclick={() => void confirmRemoveMedia()}
					class="rounded-full bg-stone-900 px-4 py-1.5 text-sm font-bold text-white disabled:opacity-50"
				>
					{mediaBusy ? 'Removing…' : 'Remove'}
				</button>
			</div>
		</div>
	</div>
{/if}

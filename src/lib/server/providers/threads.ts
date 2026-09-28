import {
	formatThreadsMetaMarker,
	isThreadsMediaFetchFailure,
	THREADS_META_AUTH_CODES
} from '$lib/domain/threads-error';
import { validateThreadsText } from '$lib/domain/validation/text';
import {
	mediaByteLength,
	ProviderError,
	PublishPartialError,
	providerErrorForStatus,
	unconfirmedPostError
} from './types';
import type {
	ConnectionCredentials,
	ConnectionMeta,
	FetchLike,
	NormalizedPost,
	PlatformProvider,
	PublishResult,
	ValidationIssue
} from './types';
import { providerFetch } from './timed-fetch';
import { THREADS_MAX_IMAGE_BYTES } from '$lib/domain/media-limits';

export const THREADS_MAX_CHARS = 500;
// Carousel children cap at 20 in the API; the apps allow 10 — match the apps.
export const THREADS_MAX_IMAGES = 10;
const THREADS_IMAGE_MIMES = new Set(['image/jpeg', 'image/png']);
export const THREADS_API_VERSION = 'v1.0';
const REFRESH_SKEW_MS = 7 * 24 * 60 * 60 * 1000;
// Container status polling before publish (media needs server-side
// processing): 12 checks x 3s ~= 33s max, mirroring the docs' guidance to
// wait before publishing. Unknown shapes proceed — publish is authoritative.
const CONTAINER_STATUS_ATTEMPTS = 12;
const CONTAINER_STATUS_POLL_MS = 3000;
// Carousel children must each reach FINISHED before the CAROUSEL parent is
// created: Meta validates every child at parent-creation time and rejects
// unready/errored ones with code 100 / subcode 4279004 ("Invalid carousel
// children"), which is how the first 4-image carousel failed in production.
// Bounded so one carousel creation stays well inside the Workers Free plan's
// 50-subrequest budget: the cap counts every child status read AND every
// child recreation, so even a 10-image API carousel cannot exhaust an
// invocation on its own. (An outer media-fetch retry restarts the count; a
// double-flake storm can still hit the platform limit and fails retryable,
// which the scheduler handles.) Still not ready after the cap? Throw
// retryable and let the scheduler or manual Retry try with fresh containers.
const CAROUSEL_CHILD_ROUNDS = 4;
const CAROUSEL_CHILD_CALL_BUDGET = 24;
// The Free plan allows 6 simultaneous outgoing connections per request, so
// large carousels read child status in chunks instead of all at once.
const CAROUSEL_STATUS_CONCURRENCY = 6;
// Once every child is FINISHED the parent container normally finishes almost
// immediately, so it needs a much shorter budget than a fresh media upload.
const CAROUSEL_PARENT_POLL_ATTEMPTS = 6;
// Meta's media crawler occasionally fails to pull a URL that works moments
// later (subcode 2207052), so a media container is re-created with a freshly
// signed URL before the failure reaches the user. The sleeps sum to ~25s: a
// closed tab keeps the request alive via waitUntil for 30s after disconnect,
// so a publish interrupted mid-retry still finishes. Longer crawler outages
// are picked up by the scheduler retry (the failure stays retryable).
// Carousel parent failures (4279004/4279009) retry the same way: the whole
// child + parent creation re-runs, so Meta never sees stale child ids.
const MEDIA_FETCH_RETRY_DELAYS_MS = [2000, 8000, 15000];
// A carousel retry recreates every child and the parent plus status polls
// (Workers Free caps one invocation at 50 subrequests), so multi-image
// segments get fewer, shorter retries. Very large API carousels skip the
// in-request retry entirely and rely on the scheduler.
const CAROUSEL_FETCH_RETRY_DELAYS_MS = [2000, 8000];
// media.length > this: no in-request retry (see above)
const CAROUSEL_NO_RETRY_ABOVE = 4;
// Breather between chained segments (same role as X's 300ms delay).
const THREADS_SEGMENT_DELAY_MS = 300;
// Public post links use the API's permalink field, never the numeric media id
// the publish endpoints return: a post lives at
// https://www.threads.com/@user/post/DdHkaqrEruo (shortcode), while
// /post/18021145505922992 renders a not-found page. The lookup is
// best-effort — a published post must never fail because of it — with
// retries only for transient failures.
const PERMALINK_ATTEMPTS = 3;
const PERMALINK_RETRY_DELAYS_MS = [400, 1200];

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function threadsUserId(creds: ConnectionCredentials, meta?: ConnectionMeta): string {
	const id = creds.threadsUserId || meta?.threadsUserId;
	if (id) return id;
	throw new ProviderError('Threads credentials require user id (reconnect account)', {
		code: 'auth'
	});
}

function normalizeSegment(seg: NormalizedPost): {
	text: string;
	media: NonNullable<NormalizedPost['media']>;
} {
	const text = (seg.text ?? '').trim();
	const media = (seg.media ?? []).slice(0, THREADS_MAX_IMAGES);
	if (!text && media.length === 0) throw new Error('Segment needs text or an image');
	for (const m of media) {
		if (!THREADS_IMAGE_MIMES.has((m.mime || '').toLowerCase())) {
			throw new Error('Threads images must be JPEG or PNG');
		}
		if (mediaByteLength(m) > THREADS_MAX_IMAGE_BYTES) {
			throw new Error('Threads allows max 8MB per image');
		}
	}
	return { text, media };
}

function graphBase(): string {
	return `https://graph.threads.net/${THREADS_API_VERSION}`;
}

// Meta failures arrive as HTTP 400 with a JSON envelope like
// {"error":{"message":"...","type":"THApiException","code":100,
// "error_subcode":33,"trace_id":"..."}}. The numeric code is the only
// reliable auth signal: the "missing permissions" boilerplate ALSO appears
// inside code-100 (invalid parameter) envelopes, so text alone must never
// expire a connection. Codes 190/200 (or codeless permission text) map to
// `auth`; everything else stays unclassified. The parsed code travels in a
// ` [meta <code>[.<subcode>]]` suffix so string-based matchers downstream
// can gate on it; the full body is kept on `detail` for diagnosis.
const META_PERMISSION_TEXT = /missing permissions|permission denied|does not have permission/i;

function parseMetaCode(body: string): { code?: number; subcode?: number } {
	try {
		const err = (JSON.parse(body) as { error?: { code?: unknown; error_subcode?: unknown } })
			?.error;
		if (err && typeof err === 'object') {
			return {
				...(typeof err.code === 'number' ? { code: err.code } : {}),
				...(typeof err.error_subcode === 'number' ? { subcode: err.error_subcode } : {})
			};
		}
	} catch {
		// Not JSON — no code; text rules apply downstream.
	}
	return {};
}

function threadsPermissionDenied(body: string): boolean {
	const { code } = parseMetaCode(body);
	// A present code is ground truth: only the auth family counts, even when
	// the boilerplate message mentions permissions (e.g. code 100.33).
	if (code !== undefined) return THREADS_META_AUTH_CODES.includes(code);
	return META_PERMISSION_TEXT.test(body);
}

export function threadsUpstreamError(prefix: string, status: number, body: string): ProviderError {
	const { code, subcode } = parseMetaCode(body);
	const marker = code !== undefined ? formatThreadsMetaMarker(code, subcode) : '';
	const message = `${prefix} failed (${status}): ${body.slice(0, 300)}${marker}`;
	const detail = body ? body.slice(0, 2000) : undefined;
	if (status === 400 && threadsPermissionDenied(body)) {
		return new ProviderError(message, { status, code: 'auth', detail });
	}
	const base = providerErrorForStatus(prefix, status, body);
	// Rebuild on the local message (identical shape plus the meta marker);
	// base.message alone would drop the marker downstream matchers gate on.
	if (detail) return new ProviderError(message, { status: base.status, code: base.code, detail });
	return base;
}

// Token facts via GET /debug_token (self-inspection: the user token checks
// itself, so no app secret is needed). Returns null whenever anything is
// unclear — callers MUST proceed with publishing in that case, so an
// inspection hiccup can never break a working post. Only positive evidence
// (valid:false, user mismatch, absent grant) may fail fast.
export type ThreadsTokenFacts = {
	valid: boolean;
	userId?: string;
	scopes: string[];
};

export async function threadsInspectToken(
	token: string,
	fetchImpl: FetchLike
): Promise<ThreadsTokenFacts | null> {
	let res: Response;
	try {
		res = await fetchImpl(
			`${graphBase()}/debug_token?access_token=${encodeURIComponent(token)}&input_token=${encodeURIComponent(token)}`
		);
	} catch {
		return null;
	}
	if (!res.ok) return null;
	try {
		const payload = (await res.json()) as {
			data?: { is_valid?: unknown; user_id?: unknown; scopes?: unknown };
		};
		const data = payload?.data;
		if (!data || typeof data !== 'object') return null;
		if (typeof data.is_valid !== 'boolean') return null;
		if (!Array.isArray(data.scopes) || !data.scopes.every((s) => typeof s === 'string'))
			return null;
		const facts: ThreadsTokenFacts = { valid: data.is_valid, scopes: data.scopes };
		if (typeof data.user_id === 'string' || typeof data.user_id === 'number') {
			facts.userId = String(data.user_id);
		}
		return facts;
	} catch {
		return null;
	}
}

// Profile fields per https://developers.facebook.com/docs/threads/threads-profiles:
// `username` is the handle, `name` is the display name, `threads_profile_picture_url`
// is the avatar. `name` was missing before, so displayName could never resolve.
const THREADS_PROFILE_FIELDS = 'id,username,name,threads_profile_picture_url';

type ThreadsProfile = {
	id?: string | number;
	username?: string;
	name?: string;
	threads_profile_picture_url?: string;
};

function isResolvedThreadsUsername(username: string | undefined, userId: string): boolean {
	if (!username) return false;
	const trimmed = username.trim();
	if (!trimmed) return false;
	// Unresolved fallback stores the numeric user id as username — never treat that as real.
	if (userId && trimmed === userId) return false;
	if (trimmed.replace(/^@/, '') === userId) return false;
	return true;
}

/**
 * GET /me is the documented publish path (`POST /me/threads`) and therefore
 * the authoritative answer to "which user does this token belong to?".
 * Threads has been observed handing OAuth a `user_id` that the Graph API
 * then rejects as "Object ... does not exist" while /me resolves fine, so
 * publish and alignCredentials resolve identity here instead of trusting the
 * id captured at connect time. Returns null when the lookup fails — callers
 * then keep the id they already had.
 */
export async function threadsResolveIdentity(
	token: string,
	fetchImpl: FetchLike
): Promise<{ userId?: string; username?: string; name?: string; profilePic?: string } | null> {
	try {
		const res = await fetchImpl(
			`${graphBase()}/me?fields=${THREADS_PROFILE_FIELDS}&access_token=${encodeURIComponent(token)}`
		);
		if (!res.ok) return null;
		const me = (await res.json()) as ThreadsProfile;
		const userId =
			typeof me.id === 'string' || typeof me.id === 'number' ? String(me.id) : undefined;
		const username = typeof me.username === 'string' ? me.username.trim() : undefined;
		const name = typeof me.name === 'string' ? me.name.trim() : undefined;
		const profilePic =
			typeof me.threads_profile_picture_url === 'string'
				? me.threads_profile_picture_url
				: undefined;
		if (!userId && !username) return null;
		return { userId, username, name, profilePic };
	} catch {
		return null;
	}
}

async function fetchThreadsProfile(
	userId: string,
	token: string,
	fetchImpl: FetchLike
): Promise<{ id?: string; username?: string; name?: string; profilePic?: string }> {
	const targets = userId
		? [
				`${graphBase()}/${encodeURIComponent(userId)}?fields=${THREADS_PROFILE_FIELDS}&access_token=${encodeURIComponent(token)}`,
				`${graphBase()}/me?fields=${THREADS_PROFILE_FIELDS}&access_token=${encodeURIComponent(token)}`
			]
		: [
				`${graphBase()}/me?fields=${THREADS_PROFILE_FIELDS}&access_token=${encodeURIComponent(token)}`
			];
	for (const url of targets) {
		try {
			const res = await fetchImpl(url);
			if (!res.ok) continue;
			const me = (await res.json()) as ThreadsProfile;
			const id = typeof me.id === 'string' || typeof me.id === 'number' ? String(me.id) : undefined;
			const username = typeof me.username === 'string' ? me.username.trim() : undefined;
			const name = typeof me.name === 'string' ? me.name.trim() : undefined;
			const profilePic =
				typeof me.threads_profile_picture_url === 'string'
					? me.threads_profile_picture_url
					: undefined;
			if (id || username || name || profilePic) return { id, username, name, profilePic };
		} catch {
			// Try next target; profile is optional at connect time (verify backfills later).
		}
	}
	return {};
}
// Best-effort public link from a post shortcode (the value the API exposes as
// `shortcode`, e.g. DdHkaqrEruo — never the numeric media id). Omit when the
// username is unknown rather than linking somewhere that 404s. Numeric-id
// fallbacks (stored when the profile fetch failed) are skipped — they 404.
// This prefers the first resolved candidate so a healed handle fixes links
// even if stale creds still hold the id.
export function threadsPostUrl(
	shortcode: string,
	creds: ConnectionCredentials,
	meta?: ConnectionMeta
): string | null {
	if (!shortcode) return null;
	const userId = creds.threadsUserId || meta?.threadsUserId || '';
	const candidates = [creds.threadsUsername, creds.handle, meta?.handle];
	for (const raw of candidates) {
		if (!raw) continue;
		const username = raw.replace(/^@/, '').trim();
		if (!username) continue;
		if (!/^[A-Za-z0-9_.]+$/.test(username)) continue;
		// Real usernames never equal the numeric id.
		if (userId && username === userId) continue;
		return `https://www.threads.net/@${username}/post/${encodeURIComponent(shortcode)}`;
	}
	return null;
}

// True for real public post permalinks (…/post/<shortcode>). The pre-fix code
// stored …/post/<numeric-media-id>, which the web app renders as a not-found
// page — those values must never be kept or reused.
export function isThreadsPermalink(value: string | null | undefined): value is string {
	if (!value) return false;
	try {
		const url = new URL(value);
		if (url.protocol !== 'https:') return false;
		if (!/^(www\.)?threads\.(com|net)$/.test(url.hostname)) return false;
		const code = url.pathname.match(/\/post\/([^/]+)\/?$/)?.[1];
		return Boolean(code && !/^\d+$/.test(code));
	} catch {
		return false;
	}
}

// Map a published media id to its public permalink. GET /{threads-media-id}
// is the documented lookup; `permalink` can be omitted (copyright-flagged
// media), in which case the shortcode plus the stored username still yields a
// working link. Returns null when Meta offers neither — callers store no link
// instead of a fabricated one that 404s. Failures are swallowed on purpose:
// the post is already live and must not be reported as failed over a link.
export async function threadsPermalinkForMedia(
	mediaId: string,
	token: string,
	creds: ConnectionCredentials,
	meta: ConnectionMeta | undefined,
	fetchImpl: FetchLike
): Promise<string | null> {
	if (!mediaId) return null;
	const url = `${graphBase()}/${encodeURIComponent(mediaId)}?fields=permalink,shortcode&access_token=${encodeURIComponent(token)}`;
	for (let attempt = 0; attempt < PERMALINK_ATTEMPTS; attempt++) {
		let res: Response | null;
		try {
			res = await fetchImpl(url);
		} catch {
			res = null;
		}
		if (res?.ok) {
			let data: { permalink?: unknown; shortcode?: unknown };
			try {
				data = (await res.json()) as typeof data;
			} catch {
				return null;
			}
			if (typeof data.permalink === 'string' && isThreadsPermalink(data.permalink)) {
				return data.permalink;
			}
			// A numeric shortcode would rebuild the broken pre-fix URL.
			if (typeof data.shortcode === 'string' && data.shortcode && !/^\d+$/.test(data.shortcode)) {
				return threadsPostUrl(data.shortcode, creds, meta);
			}
			return null;
		}
		// A 4xx means Meta has nothing to give for this id (deleted post,
		// missing permission); only network/5xx/429 failures are worth a retry.
		const retryable = !res || res.status === 429 || res.status >= 500;
		const delay = PERMALINK_RETRY_DELAYS_MS[attempt];
		if (!retryable || delay === undefined) return null;
		await sleep(delay);
	}
	return null;
}

export const threadsProvider: PlatformProvider = {
	id: 'threads',
	// Meta pulls every image from a signed URL (createMediaContainer).
	mediaByUrl: true,
	capabilities: {
		maxImages: THREADS_MAX_IMAGES,
		maxImageBytes: THREADS_MAX_IMAGE_BYTES,
		supportsCW: false,
		supportsVisibility: false,
		supportsThreads: true
	},

	validate(content: NormalizedPost): ValidationIssue[] {
		const issues: ValidationIssue[] = [];
		const segments = content.thread && content.thread.length > 0 ? content.thread : [content];
		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i];
			const segMedia = (seg.media ?? []).slice(0, THREADS_MAX_IMAGES);
			if (!seg.text?.trim() && segMedia.length === 0) {
				issues.push({
					field: `thread[${i}]`,
					message: 'Segment needs text or an image',
					code: 'empty'
				});
			}
			const check = validateThreadsText(seg.text || '', THREADS_MAX_CHARS);
			if (!check.ok) {
				issues.push({
					field: `thread[${i}].text`,
					message: check.message || 'Text too long',
					code: 'max_length'
				});
			}
			if ((seg.media?.length ?? 0) > THREADS_MAX_IMAGES) {
				issues.push({
					field: `thread[${i}].media`,
					message: `Threads allows max ${THREADS_MAX_IMAGES} images`,
					code: 'max_images'
				});
			}
			for (const m of segMedia) {
				if ((m.mime || '').toLowerCase().startsWith('video/')) {
					issues.push({
						field: `thread[${i}].media`,
						message: 'Threads video is not supported yet — post it to LinkedIn',
						code: 'no_video'
					});
				} else if (!THREADS_IMAGE_MIMES.has((m.mime || '').toLowerCase())) {
					issues.push({
						field: `thread[${i}].media`,
						message: 'Threads images must be JPEG or PNG',
						code: 'bad_image_type'
					});
				} else if (mediaByteLength(m) > THREADS_MAX_IMAGE_BYTES) {
					issues.push({
						field: `thread[${i}].media`,
						message: 'Threads allows max 8MB per image',
						code: 'max_image_bytes'
					});
				}
			}
			const links = (seg.text || '').match(/https?:\/\/[^\s]+/gi) || [];
			const unique = new Set(links.map((l) => l.replace(/[.,);:!?]+$/, '').toLowerCase()));
			if (unique.size > 5) {
				issues.push({
					field: `thread[${i}].text`,
					message: 'Threads allows max 5 links per post',
					code: 'max_links'
				});
			}
		}
		return issues;
	},

	async publish(content, creds, meta, fetchImpl = providerFetch, opts): Promise<PublishResult> {
		if (!creds.accessToken)
			throw new ProviderError('Threads credentials require accessToken (reconnect)', {
				code: 'auth'
			});
		const storedUserId = threadsUserId(creds, meta);
		const token = creds.accessToken;
		let endpoint = `${graphBase()}/${encodeURIComponent(storedUserId)}/threads`;
		const segments = content.thread && content.thread.length > 0 ? content.thread : [content];
		const resumeIds = opts?.resume?.segmentIds ?? [];
		const startAt = Math.min(resumeIds.length, segments.length);
		const segmentIds = resumeIds.slice(0, startAt);
		let replyTo = segmentIds.at(-1);
		// Resolve the thread root's public link once. On resume it starts
		// immediately (for the root, not the segment published next),
		// otherwise the moment the first segment goes live — either way it
		// runs alongside the remaining segments instead of after them.
		let permalinkPromise: Promise<string | null> | null = segmentIds[0]
			? threadsPermalinkForMedia(segmentIds[0], token, creds, meta, fetchImpl)
			: null;
		async function resolvedRemoteUrl(): Promise<string | undefined> {
			const resolved = permalinkPromise ? await permalinkPromise : null;
			if (resolved) return resolved;
			// The lookup is best-effort, so a real permalink stored by an
			// earlier partial attempt is worth keeping — but a pre-fix numeric
			// url never is, it 404s.
			const stored = opts?.resume?.remoteUrl;
			return isThreadsPermalink(stored) ? stored : undefined;
		}

		// The token — not the id captured at connect time — decides which
		// account we may publish to. OAuth has been seen returning a user_id
		// that the Graph API then rejects ("Object with ID ... does not
		// exist"), while /me names the real user and is itself the documented
		// publish path. Resolve identity first and publish as the token's own
		// user; fall back to the stored id only when the lookup is
		// unavailable (best effort: the container call stays authoritative).
		const identity = await threadsResolveIdentity(token, fetchImpl);
		const targetUserId = identity?.userId || storedUserId;
		if (targetUserId !== storedUserId) {
			endpoint = `${graphBase()}/${encodeURIComponent(targetUserId)}/threads`;
		}

		// Preflight: ask Meta what this token actually carries. An expired or
		// under-scoped token fails the container call with a generic code-100
		// "object does not exist" error; catching it here names the exact
		// cause and the fix instead. Inspection trouble is tolerated —
		// publishing proceeds exactly as before.
		const facts = await threadsInspectToken(token, fetchImpl);
		if (facts && !facts.valid) {
			throw new ProviderError(
				'Threads token is no longer valid (missing permissions) — remove and reconnect the Threads account, then retry',
				{ code: 'auth' }
			);
		}
		if (facts) {
			const required =
				segments.length > 1
					? ['threads_content_publish', 'threads_manage_replies']
					: ['threads_content_publish'];
			const missing = required.filter((s) => !facts.scopes.includes(s));
			if (missing.length) {
				throw new ProviderError(
					`Threads has not granted ${missing.join(' and ')} (missing permissions) — enable “Publish content” for your app in Threads Settings → Website permissions, save, then reconnect and retry`,
					{ code: 'auth' }
				);
			}
		}

		async function createContainer(params: Record<string, string>): Promise<string> {
			const form = new URLSearchParams({ ...params, access_token: token });
			const res = await fetchImpl(endpoint, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: form
			});
			if (!res.ok) throw threadsUpstreamError('Threads container', res.status, await res.text());
			const created = (await res.json()) as { id?: string };
			if (!created.id) throw new Error('Threads container returned no id');
			return created.id;
		}

		// One status read, normalized for both the parent wait and the
		// stricter carousel-child readiness check. null covers network / HTTP
		// / shape trouble: the parent wait lets publish decide, while children
		// treat it as "not ready yet" and retry.
		async function readContainerStatus(
			containerId: string
		): Promise<
			| { state: 'ready' }
			| { state: 'processing' }
			| { state: 'failed'; status: string; detail: string }
			| null
		> {
			let res: Response;
			try {
				res = await fetchImpl(
					`${graphBase()}/${encodeURIComponent(containerId)}?fields=status,error_message&access_token=${encodeURIComponent(token)}`
				);
			} catch {
				return null;
			}
			if (!res.ok) return null;
			let data: { status?: unknown; error_message?: unknown };
			try {
				data = (await res.json()) as { status?: unknown; error_message?: unknown };
			} catch {
				return null;
			}
			if (typeof data.status !== 'string') return null;
			if (data.status === 'FINISHED' || data.status === 'PUBLISHED') return { state: 'ready' };
			if (data.status === 'ERROR' || data.status === 'EXPIRED') {
				const detail =
					typeof data.error_message === 'string' && data.error_message
						? data.error_message
						: data.status;
				return { state: 'failed', status: data.status, detail };
			}
			return { state: 'processing' };
		}

		// Image/video containers need server-side processing before they can
		// be published (the docs recommend waiting ~30s). Poll the status
		// endpoint until FINISHED; TEXT fast paths and unknown shapes fall
		// through immediately and let the publish call decide.
		async function waitForContainer(
			containerId: string,
			attempts = CONTAINER_STATUS_ATTEMPTS
		): Promise<void> {
			for (let attempt = 0; attempt < attempts; attempt++) {
				const state = await readContainerStatus(containerId);
				// Unreadable status: let the publish call decide (unchanged).
				if (!state) return;
				if (state.state === 'ready') return;
				if (state.state === 'failed') {
					throw new ProviderError(
						`Threads media container ${state.status.toLowerCase()}: ${state.detail}`,
						{ code: 'upstream', detail: state.detail }
					);
				}
				if (attempt + 1 < attempts) await sleep(CONTAINER_STATUS_POLL_MS);
			}
			// Still processing after the budget: try publishing anyway so a
			// slow-but-finished container still succeeds. A genuinely unready
			// container fails here with the API's own error, which stays
			// retryable like any other upstream 4xx/5xx.
		}

		// Meta validates every carousel child when the CAROUSEL parent is
		// created: a child that is still IN_PROGRESS — or whose media download
		// failed after Meta returned its id — is rejected with code 100 /
		// subcode 4279004 ("Invalid carousel children"). Wait for each child
		// in parallel, recreating media-fetch failures with a freshly signed
		// URL; only create the parent once every child is FINISHED.
		async function ensureCarouselChildren(
			created: string[],
			media: NonNullable<NormalizedPost['media']>
		): Promise<string[]> {
			const ids = [...created];
			// Every status read and every recreation is a subrequest; a bigger
			// carousel therefore gets fewer sweeps while the total stays inside
			// the invocation budget.
			let calls = 0;
			for (let round = 0; round <= CAROUSEL_CHILD_ROUNDS; round++) {
				if (calls + ids.length > CAROUSEL_CHILD_CALL_BUDGET) break;
				const states: Awaited<ReturnType<typeof readContainerStatus>>[] = [];
				for (let i = 0; i < ids.length; i += CAROUSEL_STATUS_CONCURRENCY) {
					states.push(
						...(await Promise.all(
							ids.slice(i, i + CAROUSEL_STATUS_CONCURRENCY).map(readContainerStatus)
						))
					);
				}
				calls += ids.length;
				let retryNextRound = false;
				for (let i = 0; i < ids.length; i++) {
					const state = states[i];
					if (state?.state === 'ready') continue;
					if (state?.state === 'failed') {
						const message = `Threads media container ${state.status.toLowerCase()}: ${state.detail}`;
						// EXPIRED means this child id died before the thread
						// could publish; a fresh id with a freshly signed URL
						// is exactly the recovery. So is a media-download flake.
						const recreatable = state.status === 'EXPIRED' || isThreadsMediaFetchFailure(message);
						if (!recreatable) {
							// Anything else is a content error retrying cannot fix.
							// `forbidden` keeps it non-retryable and, crucially,
							// out of the "expired" auth regex.
							throw new ProviderError(message, {
								code: 'forbidden',
								detail: state.detail
							});
						}
						// Only recreate when another sweep can check the new child
						// within the call budget; otherwise park retryable.
						if (round >= CAROUSEL_CHILD_ROUNDS || calls >= CAROUSEL_CHILD_CALL_BUDGET) {
							retryNextRound = true;
							continue;
						}
						const m = media[i];
						if (!m?.storageKey) throw new Error('Threads image is missing its storage key');
						if (!opts?.mediaUrlFor) throw new Error('Threads image posts need a media signer');
						calls += 1;
						ids[i] = await createContainer({
							media_type: 'IMAGE',
							image_url: await opts.mediaUrlFor(m.storageKey),
							is_carousel_item: 'true'
						});
						retryNextRound = true;
						continue;
					}
					// processing or unreadable: check again after a breather
					retryNextRound = true;
				}
				if (!retryNextRound) return ids;
				if (round < CAROUSEL_CHILD_ROUNDS) await sleep(CONTAINER_STATUS_POLL_MS);
			}
			// Still not ready: park it retryable instead of handing Meta an
			// unready child (which would fail the whole publish with 4279004).
			throw new ProviderError('Threads carousel images are still processing — retry', {
				code: 'upstream'
			});
		}

		/** The published post's id, or '' when a 2xx came back without one. */
		async function publishContainer(containerId: string): Promise<string> {
			const pubForm = new URLSearchParams({
				creation_id: containerId,
				access_token: token
			});
			let pubRes: Response;
			try {
				pubRes = await fetchImpl(
					`${graphBase()}/${encodeURIComponent(targetUserId)}/threads_publish`,
					{
						method: 'POST',
						headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
						body: pubForm
					}
				);
			} catch (err) {
				throw unconfirmedPostError('Threads', err);
			}
			if (!pubRes.ok)
				throw threadsUpstreamError('Threads publish', pubRes.status, await pubRes.text());
			// A 2xx is a live post even without a readable id: a retry would build
			// a new container and post it again.
			const published = (await pubRes.json().catch(() => ({}))) as { id?: unknown };
			const id = published.id;
			return typeof id === 'string' || typeof id === 'number' ? String(id) : '';
		}

		// One thread segment = one post. Segments after the first reply to the
		// previously published post via reply_to_id, forming a thread chain
		// (per POST /{threads-user-id}/threads: reply_to_id is required when
		// replying). Carousel children are plain media items, never replies.
		// Signed URLs are minted inside this helper so every retry hands Meta
		// a fresh, unexpired link instead of reusing a rejected one.
		async function createMediaContainer(
			text: string,
			media: NonNullable<NormalizedPost['media']>,
			reply: Record<string, string>
		): Promise<string> {
			if (!opts?.mediaUrlFor) throw new Error('Threads image posts need a media signer');
			const urls: string[] = [];
			for (const m of media) {
				if (!m.storageKey) throw new Error('Threads image is missing its storage key');
				urls.push(await opts.mediaUrlFor(m.storageKey));
			}
			if (urls.length === 1) {
				const params: Record<string, string> = {
					media_type: 'IMAGE',
					image_url: urls[0],
					...reply
				};
				if (text) params.text = text;
				return createContainer(params);
			}
			const children: string[] = [];
			for (const imageUrl of urls) {
				children.push(
					await createContainer({
						media_type: 'IMAGE',
						image_url: imageUrl,
						is_carousel_item: 'true'
					})
				);
			}
			// The parent may only be created once every child is FINISHED;
			// otherwise Meta rejects it with 4279004 (see ensureCarouselChildren).
			const readyChildren = await ensureCarouselChildren(children, media);
			const params: Record<string, string> = {
				media_type: 'CAROUSEL',
				children: readyChildren.join(','),
				...reply
			};
			if (text) params.text = text;
			return createContainer(params);
		}

		async function publishSegment(
			text: string,
			media: NonNullable<NormalizedPost['media']>,
			replyToId: string | undefined
		): Promise<string> {
			const reply: Record<string, string> = replyToId ? { reply_to_id: replyToId } : {};
			let containerId: string;
			if (media.length === 0) {
				containerId = await createContainer({ media_type: 'TEXT', text, ...reply });
			} else {
				let attempts = 0;
				let lastError: unknown = null;
				for (;;) {
					try {
						containerId = await createMediaContainer(text, media, reply);
						break;
					} catch (err) {
						lastError = err;
						const message = err instanceof Error ? err.message : String(err);
						// Very large carousels already spend most of the Free-plan
						// subrequest budget on the first attempt; the scheduler retry
						// handles them instead.
						const delays =
							media.length > CAROUSEL_NO_RETRY_ABOVE
								? []
								: media.length > 1
									? CAROUSEL_FETCH_RETRY_DELAYS_MS
									: MEDIA_FETCH_RETRY_DELAYS_MS;
						const delay = delays[attempts];
						if (delay === undefined || !isThreadsMediaFetchFailure(message)) throw err;
						attempts += 1;
						await sleep(delay);
					}
				}
				if (!containerId) throw lastError;
			}
			// Carousel parents are already backed by FINISHED children, so the
			// short poll budget is enough; single containers keep the full one.
			await waitForContainer(
				containerId,
				media.length > 1 ? CAROUSEL_PARENT_POLL_ATTEMPTS : CONTAINER_STATUS_ATTEMPTS
			);
			return publishContainer(containerId);
		}

		for (let i = startAt; i < segments.length; i++) {
			try {
				const seg = segments[i];
				const { text, media } = normalizeSegment(seg);
				const mediaId = await publishSegment(text, media, replyTo);
				segmentIds.push(mediaId);
				if (!permalinkPromise && mediaId) {
					// startAt was 0: this segment is the thread root.
					permalinkPromise = threadsPermalinkForMedia(mediaId, token, creds, meta, fetchImpl);
				}
				await opts?.checkpoint?.({
					segmentIds: [...segmentIds],
					remoteUrl: opts?.resume?.remoteUrl ?? null
				});
				if (mediaId) {
					replyTo = mediaId;
				} else if (i < segments.length - 1) {
					// A reply needs the parent's id: stop here with what was posted,
					// so the retry resumes after this segment rather than reposting.
					throw new PublishPartialError(
						'Threads accepted the post but returned no id — the rest of the thread cannot be linked',
						{ segmentIds: [...segmentIds], remoteUrl: (await resolvedRemoteUrl()) ?? null }
					);
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (segmentIds.length) {
					throw new PublishPartialError(message, {
						segmentIds,
						remoteUrl: (await resolvedRemoteUrl()) ?? null
					});
				}
				throw err;
			}
			if (i < segments.length - 1) await sleep(THREADS_SEGMENT_DELAY_MS);
		}

		if (!segmentIds.length) throw new Error('Threads publish produced no posts');
		return {
			remotePostId: segmentIds[0] || undefined,
			remoteUrl: await resolvedRemoteUrl(),
			segmentIds
		};
	},

	/**
	 * Reconcile the stored user id with the one the token actually belongs
	 * to. Reconnect flows have stored an OAuth `user_id` that the Graph API
	 * then rejected as "object does not exist", while GET /me (the documented
	 * publish path) named the real user — healing here fixes the row for good
	 * instead of repeating the failed call on every retry.
	 */
	async alignCredentials(creds, _meta, fetchImpl = providerFetch) {
		if (!creds.accessToken) return null;
		const identity = await threadsResolveIdentity(creds.accessToken, fetchImpl);
		if (!identity?.userId) return null;
		const username = identity.username;
		const userIdChanged = creds.threadsUserId !== identity.userId;
		const usernameChanged = Boolean(username) && username !== creds.threadsUsername;
		if (!userIdChanged && !usernameChanged) return null;
		return {
			...creds,
			threadsUserId: identity.userId,
			...(usernameChanged && username ? { threadsUsername: username } : {})
		};
	},

	async refreshIfNeeded(creds, fetchImpl = providerFetch): Promise<ConnectionCredentials> {
		if (!creds.accessToken) return creds;
		if (creds.expiresAt && creds.expiresAt - Date.now() > REFRESH_SKEW_MS) return creds;
		try {
			const url = `https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(creds.accessToken)}`;
			const res = await fetchImpl(url, { method: 'GET' });
			if (!res.ok) {
				// Same contract as LinkedIn: auth rejection throws 401 so the
				// connection is marked expired; transients keep current creds.
				if (res.status === 400 || res.status === 401 || res.status === 403) {
					throw new ProviderError(`Threads token refresh rejected (${res.status}) — reconnect`, {
						status: 401,
						code: 'auth'
					});
				}
				return creds;
			}
			const data = (await res.json()) as { access_token?: string; expires_in?: number };
			if (!data.access_token) {
				throw new ProviderError('Threads token refresh returned no token — reconnect', {
					status: 401,
					code: 'auth'
				});
			}
			return {
				...creds,
				accessToken: data.access_token,
				expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : creds.expiresAt
			};
		} catch (err) {
			// Network failures stay transient; auth rejections propagate.
			if ((err as { status?: number } | null)?.status === 401) throw err;
			return creds;
		}
	}
};

// --- OAuth helpers ---

export function threadsAuthorizeUrl(appId: string, appUrl: string, state: string): string {
	const redirect = `${appUrl.replace(/\/$/, '')}/api/connections/threads/callback`;
	const params = new URLSearchParams({
		client_id: appId,
		redirect_uri: redirect,
		scope: 'threads_basic,threads_content_publish,threads_manage_replies',
		response_type: 'code',
		state
	});
	return `https://threads.net/oauth/authorize?${params.toString()}`;
}

async function exchangeForLongLived(
	shortToken: string,
	appSecret: string,
	fetchImpl: FetchLike
): Promise<{ accessToken: string; expiresAt?: number }> {
	const url = `https://graph.threads.net/access_token?grant_type=th_exchange_token&client_secret=${encodeURIComponent(appSecret)}&access_token=${encodeURIComponent(shortToken)}`;
	const res = await fetchImpl(url, { method: 'GET' });
	if (!res.ok)
		throw Object.assign(
			new Error(
				`Threads long-lived exchange failed (${res.status}): ${(await res.text()).slice(0, 300)}`
			),
			{ status: res.status }
		);
	const data = (await res.json()) as { access_token?: string; expires_in?: number };
	if (!data.access_token) throw new Error('Threads exchange returned no access_token');
	return {
		accessToken: data.access_token,
		expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined
	};
}

export async function threadsExchangeCode(
	args: { appId: string; appSecret: string; code: string; appUrl: string },
	fetchImpl: FetchLike = providerFetch
): Promise<ConnectionCredentials & ConnectionMeta> {
	const redirect = `${args.appUrl.replace(/\/$/, '')}/api/connections/threads/callback`;
	const cleanCode = args.code.replace(/#_$/, '');
	const body = new URLSearchParams({
		client_id: args.appId,
		client_secret: args.appSecret,
		grant_type: 'authorization_code',
		redirect_uri: redirect,
		code: cleanCode
	});
	const tokRes = await fetchImpl('https://graph.threads.net/oauth/access_token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body
	});
	if (!tokRes.ok)
		throw Object.assign(
			new Error(
				`Threads token exchange failed (${tokRes.status}): ${(await tokRes.text()).slice(0, 300)}`
			),
			{ status: tokRes.status }
		);
	const tok = (await tokRes.json()) as { access_token?: string; user_id?: number | string };
	if (!tok.access_token) throw new Error('Threads exchange returned no access_token');

	const { accessToken: longToken, expiresAt } = await exchangeForLongLived(
		tok.access_token,
		args.appSecret,
		fetchImpl
	);

	// Profile is optional at connect time: a failure here must not fail OAuth.
	// Verify backfills later. Never store the numeric id as the username —
	// store undefined so postUrl returns null instead of a 404 link.
	const exchangedUserId = tok.user_id != null ? String(tok.user_id) : '';
	const profile = exchangedUserId
		? await fetchThreadsProfile(exchangedUserId, longToken, fetchImpl)
		: {};
	// Prefer the id from the profile response: the /me fallback returns the
	// token's own user even when the OAuth `user_id` is one the Graph API
	// rejects, so this stores a publishable id at connect time.
	const userId = profile.id || exchangedUserId;
	const resolvedUsername = profile.username?.trim();
	const resolved = resolvedUsername && isResolvedThreadsUsername(resolvedUsername, userId);
	const username = resolved ? resolvedUsername : undefined;
	const displayName = profile.name?.trim() || username || 'Threads';

	return {
		accessToken: longToken,
		expiresAt,
		tokenType: 'bearer',
		// threads_manage_replies covers POST reply endpoints, which chained
		// thread segments (reply_to_id) may require. Existing connections
		// predate it and need one reconnect to pick it up.
		scopes: ['threads_basic', 'threads_content_publish', 'threads_manage_replies'],
		clientId: args.appId,
		clientSecret: args.appSecret,
		threadsUserId: userId || undefined,
		threadsUsername: username,
		handle: username ? `@${username}` : userId ? `@${userId}` : undefined,
		displayName,
		avatarUrl: profile.profilePic,
		maxCharacters: THREADS_MAX_CHARS
	};
}

export async function threadsVerify(
	creds: ConnectionCredentials,
	fetchImpl: FetchLike = providerFetch
): Promise<{ displayName?: string; avatarUrl?: string; handle?: string; userId?: string }> {
	if (!creds.accessToken) throw new Error('Missing accessToken');
	const userId = creds.threadsUserId;
	if (!userId) throw new Error('Missing Threads user id');
	// Try the stored user id first, then /me (matches the docs example).
	// Unlike exchange, a failure here must throw so callers can expire/retry.
	const urls = [
		`${graphBase()}/${encodeURIComponent(userId)}?fields=${THREADS_PROFILE_FIELDS}&access_token=${encodeURIComponent(creds.accessToken)}`,
		`${graphBase()}/me?fields=${THREADS_PROFILE_FIELDS}&access_token=${encodeURIComponent(creds.accessToken)}`
	];
	let lastStatus = 0;
	for (const url of urls) {
		const res = await fetchImpl(url);
		if (!res.ok) {
			lastStatus = res.status;
			continue;
		}
		const me = (await res.json()) as ThreadsProfile;
		const username = typeof me.username === 'string' ? me.username.trim() : undefined;
		const name = typeof me.name === 'string' ? me.name.trim() : undefined;
		const resolved = username && isResolvedThreadsUsername(username, userId) ? username : undefined;
		// Only accept payloads with something usable; otherwise try the next target.
		if (!resolved && !name && !me.threads_profile_picture_url) continue;
		const resolvedId =
			typeof me.id === 'string' || typeof me.id === 'number' ? String(me.id) : undefined;
		return {
			displayName: name || resolved || undefined,
			avatarUrl: me.threads_profile_picture_url,
			handle: resolved ? `@${resolved}` : undefined,
			userId: resolvedId
		};
	}
	throw Object.assign(new Error(`Threads verify failed (${lastStatus || 'no profile'})`), {
		status: lastStatus || 502
	});
}

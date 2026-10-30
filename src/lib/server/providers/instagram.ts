import {
	INSTAGRAM_MAX_IMAGE_BYTES,
	INSTAGRAM_MAX_ITEMS,
	instagramMediaProblems
} from '#lib/domain/media-limits.js';
import { formatThreadsMetaMarker } from '#lib/domain/threads-error.js';
import { INSTAGRAM_MAX_CHARS, validateInstagramText } from '#lib/domain/validation/text.js';
import { singlePost } from './flatten';
import { providerFetch } from './timed-fetch';
import {
	mediaByteLength,
	processingError,
	ProviderError,
	resumedVideoState,
	unconfirmedPostError
} from './types';
import type {
	ConnectionCredentials,
	ConnectionMeta,
	FetchLike,
	MediaAttachment,
	PlatformProvider,
	PublishResult,
	ValidationIssue
} from './types';
import { isVideoAttachment, pollVideo, videoValidation } from './video';

export const INSTAGRAM_API_VERSION = 'v26.0';
const GRAPH = `https://graph.instagram.com/${INSTAGRAM_API_VERSION}`;
const SCOPES = ['instagram_business_basic', 'instagram_business_content_publish'];
const PROFILE_FIELDS = 'user_id,username,name,account_type,profile_picture_url';
/** The account kinds Instagram lets post through its API. */
const POSTING_ACCOUNT_TYPES = new Set(['BUSINESS', 'MEDIA_CREATOR']);
const REFRESH_SKEW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ALT_TEXT = 1000;

// A photo container is usually ready within seconds; a Reel can take minutes,
// so it parks instead of holding the request (processingError).
const PHOTO_POLLS = 6;
const PHOTO_POLL_MS = 2000;
const REEL_POLLS = 12;
const REEL_POLL_MS = 3000;
// Calls a waiting container must leave for the publish and the permalink.
const POLL_RESERVE = 4;
// Meta's publishing limit: 100 posts per rolling day. Look again in an hour.
const DAILY_LIMIT_RETRY_MS = 60 * 60_000;

/** Meta codes that mean the token itself is rejected. */
const AUTH_CODES = new Set([190, 200]);
/** Meta's throttling codes, plus 9 (the daily publishing limit). */
const RATE_CODES = new Set([4, 9, 17, 32, 613]);
/** Meta's own transient failures. */
const TRANSIENT_CODES = new Set([1, 2]);
// The crawler sometimes fails to pull a URL that works moments later, and a
// container made before its parts finished says it is not ready yet.
const MEDIA_FETCH_SUBCODES = new Set([2207003, 2207027, 2207052]);
const DAILY_LIMIT_SUBCODE = 2207042;

function parseMetaError(body: string): { code?: number; subcode?: number; message?: string } {
	try {
		const err = (
			JSON.parse(body) as {
				error?: {
					code?: unknown;
					error_subcode?: unknown;
					error_user_msg?: unknown;
					message?: unknown;
				};
			}
		)?.error;
		if (!err || typeof err !== 'object') return {};
		const userMessage = typeof err.error_user_msg === 'string' ? err.error_user_msg : undefined;
		return {
			...(typeof err.code === 'number' ? { code: err.code } : {}),
			...(typeof err.error_subcode === 'number' ? { subcode: err.error_subcode } : {}),
			...(userMessage || typeof err.message === 'string'
				? { message: userMessage || (err.message as string) }
				: {})
		};
	} catch {
		return {};
	}
}

/**
 * Classify a Graph API failure by Meta's numeric code, never by its text: the
 * "missing permissions" boilerplate also appears in invalid-parameter errors.
 * Anything not known to be passing is a problem with the post itself, which a
 * retry would only repeat.
 */
export function instagramUpstreamError(
	prefix: string,
	status: number,
	body: string
): ProviderError {
	const { code, subcode, message: metaMessage } = parseMetaError(body);
	const marker = code !== undefined ? formatThreadsMetaMarker(code, subcode) : '';
	const said = metaMessage || body.slice(0, 300);
	const detail = body ? body.slice(0, 2000) : undefined;
	if (subcode === DAILY_LIMIT_SUBCODE) {
		return new ProviderError(
			`Instagram's limit of 100 posts a day is reached — it is tried again in an hour${marker}`,
			{ status, code: 'rate_limited', detail, retryAfterMs: DAILY_LIMIT_RETRY_MS }
		);
	}
	const message = `${prefix} failed (${status}): ${said}${marker}`;
	if (status === 401 || (code !== undefined && AUTH_CODES.has(code))) {
		return new ProviderError(message, { status, code: 'auth', detail });
	}
	if (status === 429 || (code !== undefined && RATE_CODES.has(code))) {
		return new ProviderError(message, { status, code: 'rate_limited', detail });
	}
	if (
		status >= 500 ||
		(code !== undefined && TRANSIENT_CODES.has(code)) ||
		(subcode !== undefined && MEDIA_FETCH_SUBCODES.has(subcode))
	) {
		return new ProviderError(message, { status, code: 'upstream', detail });
	}
	return new ProviderError(message, { status, code: 'forbidden', detail });
}

function isJpeg(m: MediaAttachment): boolean {
	return (m.mime || '').toLowerCase() === 'image/jpeg';
}

export const instagramProvider: PlatformProvider = {
	id: 'instagram',
	// Meta pulls every photo and video from a public URL.
	mediaByUrl: true,
	capabilities: {
		maxImages: INSTAGRAM_MAX_ITEMS,
		maxImageBytes: INSTAGRAM_MAX_IMAGE_BYTES,
		supportsCW: false,
		supportsVisibility: false,
		supportsThreads: false
	},

	validate(content, meta): ValidationIssue[] {
		const { text, media } = singlePost(content);
		const issues: ValidationIssue[] = [];
		const checked = validateInstagramText(text);
		if (!checked.ok) issues.push({ field: 'text', message: checked.message ?? 'Caption too long' });
		const problems = instagramMediaProblems(media);
		for (const message of problems)
			issues.push({ field: 'media', message, code: 'instagram_media' });
		if (problems.length) return issues;
		if (media.some((m) => isJpeg(m) && mediaByteLength(m) > INSTAGRAM_MAX_IMAGE_BYTES)) {
			issues.push({ field: 'media', message: "An image is over Instagram's 8MB limit" });
		}
		issues.push(...videoValidation('instagram', media, meta, 'media'));
		return issues;
	},

	async publish(content, creds, _meta, fetchImpl = providerFetch, opts): Promise<PublishResult> {
		const token = creds.accessToken;
		if (!token) {
			throw new ProviderError('Instagram credentials are missing a token (reconnect)', {
				code: 'auth'
			});
		}
		// A run that published and then lost its answer resumes here: never twice.
		const done = opts?.resume?.segmentIds?.[0];
		if (done) return { remotePostId: done, remoteUrl: opts?.resume?.remoteUrl ?? undefined };
		const mediaUrlFor = opts?.mediaUrlFor;
		if (!mediaUrlFor) throw new Error('Instagram posts need a media signer');
		const account = encodeURIComponent(creds.igUserId || 'me');
		const { text, media } = singlePost(content);

		async function graphPost(path: string, params: Record<string, string>, label: string) {
			const res = await fetchImpl(`${GRAPH}/${path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ ...params, access_token: token! })
			});
			if (!res.ok) throw instagramUpstreamError(label, res.status, await res.text());
			const data = (await res.json().catch(() => ({}))) as { id?: unknown };
			return typeof data.id === 'string' || typeof data.id === 'number' ? String(data.id) : '';
		}

		async function createContainer(params: Record<string, string>): Promise<string> {
			const id = await graphPost(`${account}/media`, params, 'Instagram media');
			if (!id)
				throw new ProviderError('Instagram returned no media container', { code: 'upstream' });
			return id;
		}

		/** Ready, still working, or failed with Meta's reason. Null when unreadable. */
		async function containerState(
			id: string
		): Promise<
			{ state: 'ready' | 'working' } | { state: 'failed'; code: string; status: string } | null
		> {
			let res: Response;
			try {
				res = await fetchImpl(
					`${GRAPH}/${encodeURIComponent(id)}?fields=status_code,status&access_token=${encodeURIComponent(token!)}`
				);
			} catch {
				return null;
			}
			if (!res.ok) return null;
			const data = (await res.json().catch(() => ({}))) as {
				status_code?: unknown;
				status?: unknown;
			};
			const code = typeof data.status_code === 'string' ? data.status_code : '';
			if (code === 'FINISHED' || code === 'PUBLISHED') return { state: 'ready' };
			if (code === 'ERROR' || code === 'EXPIRED') {
				return {
					state: 'failed',
					code,
					status: typeof data.status === 'string' && data.status ? data.status : code
				};
			}
			return code ? { state: 'working' } : null;
		}

		/**
		 * Wait for photo containers. One Meta could not take is a problem with
		 * the photo; one still working after the wait is published anyway, and
		 * media_publish says whether it was ready.
		 */
		async function photosReady(ids: string[]): Promise<void> {
			let waiting = [...ids];
			await pollVideo(
				{
					polls: PHOTO_POLLS,
					delayMs: PHOTO_POLL_MS,
					reserve: POLL_RESERVE + waiting.length,
					callsLeft: opts?.callsLeft,
					timeLeft: opts?.timeLeft
				},
				async () => {
					const still: string[] = [];
					for (const id of waiting) {
						const state = await containerState(id);
						if (state?.state === 'failed') {
							throw new ProviderError(`Instagram could not take a photo: ${state.status}`, {
								code: 'forbidden',
								detail: state.status
							});
						}
						if (state?.state !== 'ready') still.push(id);
					}
					waiting = still;
					return waiting.length ? null : true;
				}
			);
		}

		function photoParams(m: MediaAttachment, url: string): Record<string, string> {
			const params: Record<string, string> = { image_url: url };
			const alt = m.alt?.trim();
			if (alt) params.alt_text = alt.slice(0, MAX_ALT_TEXT);
			return params;
		}

		async function photoUrl(m: MediaAttachment): Promise<string> {
			if (!m.storageKey) throw new Error('Instagram photo is missing its storage key');
			return mediaUrlFor!(m.storageKey, isJpeg(m) ? undefined : 'jpeg');
		}

		/** A Reel: wait while it is cheap to, then park the container for a later run. */
		async function reelContainer(video: MediaAttachment, fresh = false): Promise<string> {
			if (!video.storageKey) throw new Error('Instagram video is missing its storage key');
			const resumed = fresh ? null : resumedVideoState(opts?.resume, 0, video.storageKey);
			let id = typeof resumed?.containerId === 'string' ? resumed.containerId : '';
			if (!id) {
				const params: Record<string, string> = {
					media_type: 'REELS',
					video_url: await mediaUrlFor!(video.storageKey),
					share_to_feed: 'true'
				};
				if (text) params.caption = text;
				if (video.coverKey) params.cover_url = await mediaUrlFor!(video.storageKey, 'cover');
				id = await createContainer(params);
			}
			const containerId = id;
			let expired = false;
			const ready = await pollVideo(
				{
					polls: REEL_POLLS,
					delayMs: REEL_POLL_MS,
					reserve: POLL_RESERVE,
					callsLeft: opts?.callsLeft,
					timeLeft: opts?.timeLeft
				},
				async () => {
					const state = await containerState(containerId);
					if (state?.state === 'ready') return containerId;
					if (state?.state === 'failed') {
						// A container left parked past Meta's 24 hours: make a new one.
						if (state.code === 'EXPIRED' && resumed) {
							expired = true;
							return containerId;
						}
						throw new ProviderError(`Instagram could not take the video: ${state.status}`, {
							code: 'forbidden',
							detail: state.status
						});
					}
					return null;
				}
			);
			if (expired) return reelContainer(video, true);
			if (ready) return ready;
			throw processingError('Instagram', {
				segment: 0,
				storageKey: video.storageKey,
				state: { containerId }
			});
		}

		let containerId: string;
		const video = media.find(isVideoAttachment);
		if (video) {
			containerId = await reelContainer(video);
		} else if (media.length === 1) {
			const params = photoParams(media[0], await photoUrl(media[0]));
			if (text) params.caption = text;
			containerId = await createContainer(params);
			await photosReady([containerId]);
		} else {
			const children: string[] = [];
			for (const m of media) {
				children.push(
					await createContainer({ ...photoParams(m, await photoUrl(m)), is_carousel_item: 'true' })
				);
			}
			// Meta checks every child when the carousel is made, so each must be ready first.
			await photosReady(children);
			const params: Record<string, string> = {
				media_type: 'CAROUSEL',
				children: children.join(',')
			};
			if (text) params.caption = text;
			containerId = await createContainer(params);
			await photosReady([containerId]);
		}

		let postId: string;
		try {
			postId = await graphPost(
				`${account}/media_publish`,
				{ creation_id: containerId },
				'Instagram publish'
			);
		} catch (err) {
			if (err instanceof ProviderError) throw err;
			// No answer: the post may be live, and a second try would post it twice.
			throw unconfirmedPostError('Instagram', err);
		}
		const remoteUrl = postId ? await permalink(postId, token, fetchImpl) : null;
		await opts?.checkpoint?.({ segmentIds: postId ? [postId] : [], remoteUrl });
		return { remotePostId: postId || undefined, remoteUrl: remoteUrl ?? undefined };
	},

	async refreshIfNeeded(creds, fetchImpl = providerFetch): Promise<ConnectionCredentials> {
		if (!creds.accessToken) return creds;
		if (creds.expiresAt && creds.expiresAt - Date.now() > REFRESH_SKEW_MS) return creds;
		try {
			const res = await fetchImpl(
				`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(creds.accessToken)}`
			);
			if (!res.ok) {
				// A rejected token expires the account; anything else, a rate limit
				// included, keeps the current one for the next try.
				const err = tokenAwareError('Instagram token refresh', res.status, await res.text());
				if (err.code === 'auth') throw err;
				return creds;
			}
			const data = (await res.json()) as { access_token?: string; expires_in?: number };
			if (!data.access_token) {
				throw new ProviderError('Instagram token refresh returned no token — reconnect', {
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
			if ((err as { status?: number } | null)?.status === 401) throw err;
			return creds;
		}
	}
};

/** The post's link, or null: the post is live either way, so a failure here is swallowed. */
async function permalink(id: string, token: string, fetchImpl: FetchLike): Promise<string | null> {
	try {
		const res = await fetchImpl(
			`${GRAPH}/${encodeURIComponent(id)}?fields=permalink&access_token=${encodeURIComponent(token)}`
		);
		if (!res.ok) return null;
		const data = (await res.json()) as { permalink?: unknown };
		return typeof data.permalink === 'string' &&
			/^https:\/\/(www\.)?instagram\.com\//.test(data.permalink)
			? data.permalink
			: null;
	} catch {
		return null;
	}
}

/**
 * Meta answers a dead token with a 400 and code 190, so the error is given
 * the 401 that callers expire an account on.
 */
function tokenAwareError(prefix: string, status: number, body: string): ProviderError {
	const err = instagramUpstreamError(prefix, status, body);
	if (err.code !== 'auth' && status !== 403) return err;
	return new ProviderError(`${err.message} — reconnect`, {
		status: 401,
		code: 'auth',
		detail: err.detail
	});
}

export function instagramCallbackUrl(appUrl: string): string {
	return `${appUrl.replace(/\/$/, '')}/api/connections/instagram/callback`;
}

export function instagramAuthorizeUrl(appId: string, appUrl: string, state: string): string {
	const params = new URLSearchParams({
		client_id: appId,
		redirect_uri: instagramCallbackUrl(appUrl),
		scope: SCOPES.join(','),
		response_type: 'code',
		state
	});
	return `https://www.instagram.com/oauth/authorize?${params.toString()}`;
}

type InstagramProfile = {
	user_id?: string | number;
	username?: string;
	name?: string;
	account_type?: string;
	profile_picture_url?: string;
};

async function fetchProfile(token: string, fetchImpl: FetchLike): Promise<InstagramProfile> {
	const res = await fetchImpl(
		`${GRAPH}/me?fields=${PROFILE_FIELDS}&access_token=${encodeURIComponent(token)}`
	);
	if (!res.ok) throw tokenAwareError('Instagram profile', res.status, await res.text());
	// The reference shows `/me` wrapped in `data`; the API answers flat.
	const raw = (await res.json()) as InstagramProfile & { data?: InstagramProfile[] };
	return raw.data?.[0] ?? raw;
}

function profileFacts(profile: InstagramProfile) {
	// `user_id` is the account that posts; `id` is scoped to the app and is
	// refused by /{id}/media, so it is never a stand-in.
	const rawId = profile.user_id;
	const userId = rawId !== undefined && rawId !== null && rawId !== '' ? String(rawId) : undefined;
	const username = typeof profile.username === 'string' ? profile.username.trim() : undefined;
	const name = typeof profile.name === 'string' ? profile.name.trim() : undefined;
	return {
		userId,
		username: username || undefined,
		displayName: name || username || 'Instagram',
		avatarUrl: profile.profile_picture_url,
		accountType: typeof profile.account_type === 'string' ? profile.account_type : undefined
	};
}

export const PERSONAL_ACCOUNT_MESSAGE =
	"Instagram only lets Business and Creator accounts post through its API — switch the account type in Instagram's settings, then connect again";

export async function instagramExchangeCode(
	args: { appId: string; appSecret: string; code: string; appUrl: string },
	fetchImpl: FetchLike = providerFetch
): Promise<ConnectionCredentials & ConnectionMeta> {
	const tokRes = await fetchImpl('https://api.instagram.com/oauth/access_token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: args.appId,
			client_secret: args.appSecret,
			grant_type: 'authorization_code',
			redirect_uri: instagramCallbackUrl(args.appUrl),
			code: args.code.replace(/#_$/, '')
		})
	});
	if (!tokRes.ok) {
		throw Object.assign(
			new Error(
				`Instagram token exchange failed (${tokRes.status}): ${(await tokRes.text()).slice(0, 300)}`
			),
			{ status: tokRes.status }
		);
	}
	// Documented as `{data: [{access_token, user_id, permissions}]}`; older apps
	// get the same fields at the top level.
	const raw = (await tokRes.json()) as {
		access_token?: string;
		data?: Array<{ access_token?: string }>;
	};
	const shortToken = raw.data?.[0]?.access_token ?? raw.access_token;
	if (!shortToken) throw new Error('Instagram exchange returned no access_token');

	const longRes = await fetchImpl(
		`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(args.appSecret)}&access_token=${encodeURIComponent(shortToken)}`
	);
	if (!longRes.ok) {
		throw Object.assign(
			new Error(
				`Instagram long-lived exchange failed (${longRes.status}): ${(await longRes.text()).slice(0, 300)}`
			),
			{ status: longRes.status }
		);
	}
	const long = (await longRes.json()) as { access_token?: string; expires_in?: number };
	if (!long.access_token) throw new Error('Instagram exchange returned no long-lived token');

	// Unlike Threads, the profile is required: it names the account to publish
	// to, and says whether it is one that can post at all.
	const facts = profileFacts(await fetchProfile(long.access_token, fetchImpl));
	if (facts.accountType && !POSTING_ACCOUNT_TYPES.has(facts.accountType.toUpperCase())) {
		throw new Error(PERSONAL_ACCOUNT_MESSAGE);
	}
	if (!facts.userId) throw new Error('Instagram did not say which account this is');
	return {
		accessToken: long.access_token,
		expiresAt: long.expires_in ? Date.now() + long.expires_in * 1000 : undefined,
		tokenType: 'bearer',
		scopes: SCOPES,
		clientId: args.appId,
		clientSecret: args.appSecret,
		igUserId: facts.userId,
		igUsername: facts.username,
		igAccountType: facts.accountType,
		handle: facts.username ? `@${facts.username}` : undefined,
		displayName: facts.displayName,
		avatarUrl: facts.avatarUrl,
		maxCharacters: INSTAGRAM_MAX_CHARS
	};
}

export async function instagramVerify(
	creds: ConnectionCredentials,
	fetchImpl: FetchLike = providerFetch
): Promise<{
	displayName?: string;
	avatarUrl?: string;
	handle?: string;
	userId?: string;
	username?: string;
}> {
	if (!creds.accessToken) throw new Error('Missing accessToken');
	const facts = profileFacts(await fetchProfile(creds.accessToken, fetchImpl));
	return {
		displayName: facts.displayName,
		avatarUrl: facts.avatarUrl,
		handle: facts.username ? `@${facts.username}` : undefined,
		userId: facts.userId,
		username: facts.username
	};
}

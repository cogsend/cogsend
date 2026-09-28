import { extractFirstUrl } from '$lib/domain/links';
import { joinThreadTexts } from '$lib/domain/thread-segments';
import { validateLinkedinText } from '$lib/domain/validation/text';
import { fetchOgImage, fetchOpenGraph } from '../opengraph';
import type {
	ConnectionCredentials,
	ConnectionMeta,
	FetchLike,
	MediaAttachment,
	NormalizedPost,
	PlatformProvider,
	PublishResult,
	ValidationIssue
} from './types';
import { mediaByteLength, ProviderError, unconfirmedPostError } from './types';
import { LINKEDIN_MAX_IMAGE_BYTES, LINKEDIN_MAX_IMAGES } from '$lib/domain/media-limits';
import { providerFetch } from './timed-fetch';

export const LINKEDIN_MAX_CHARS = 3000;
export { LINKEDIN_MAX_IMAGE_BYTES, LINKEDIN_MAX_IMAGES } from '$lib/domain/media-limits';
// Single mp4 per post; 95MB keeps uploads under the Worker request body limit.
export const LINKEDIN_VIDEO_MIMES = ['video/mp4'];
export const LINKEDIN_MAX_VIDEO_BYTES = 95_000_000;
// LinkedIn versions are YYYYMM and each is supported for at least a year from
// its release, so 202609 is good until at least September 2027. Bump it before
// then (changelog: learn.microsoft.com/linkedin/marketing/integrations/recent-changes).
export const LINKEDIN_VERSION = '202609';
const REFRESH_SKEW_MS = 7 * 24 * 60 * 60 * 1000;

function authorUrn(creds: ConnectionCredentials, meta?: ConnectionMeta): string {
	const urn = creds.personUrn || meta?.personUrn;
	if (urn) return urn.startsWith('urn:li:person:') ? urn : `urn:li:person:${urn}`;
	const sub = creds.openIdSub;
	if (sub) return `urn:li:person:${sub}`;
	throw new ProviderError('LinkedIn credentials require personUrn (reconnect account)', {
		code: 'auth'
	});
}

/**
 * LinkedIn has no threads: a multi-post draft is flattened into one post —
 * non-empty segment texts joined by a blank line, media combined in segment
 * order. Selecting LinkedIn on a thread draft therefore never fails just
 * because the draft threads elsewhere.
 */
function singlePost(content: NormalizedPost): { text: string; media: MediaAttachment[] } {
	const segments = content.thread && content.thread.length > 0 ? content.thread : [content];
	return {
		text: joinThreadTexts(segments.map((s) => s.text)),
		media: segments.flatMap((s) => s.media ?? [])
	};
}

/**
 * `commentary` is LinkedIn "little" text: `\ | { } @ [ ] ( ) < > # * _ ~` are
 * markup, and LinkedIn requires every one of them backslash-escaped even when
 * no mention or template is meant. Unescaped, a single `(` truncates the rest of
 * the post. See https://learn.microsoft.com/linkedin/marketing/community-management/shares/little-text-format
 *
 * A `#` that starts a word is the one exception: `#word` is little's own
 * hashtag element, so escaping it would turn every hashtag into plain text.
 */
export function escapeLittleText(text: string): string {
	return text.replace(/[\\|{}@[\]()<>#*_~]/g, (ch, offset: number) => {
		if (ch === '#') {
			const before = offset === 0 ? '' : text[offset - 1];
			const after = text[offset + 1] ?? '';
			if ((before === '' || /\s/.test(before)) && /[\p{L}\p{N}]/u.test(after)) return ch;
		}
		return `\\${ch}`;
	});
}

/** LinkedIn caps alt text at 4,086 characters; blank means none. */
const LINKEDIN_MAX_ALT_TEXT = 4086;

function linkedinAltText(m: MediaAttachment | undefined): string | undefined {
	const alt = m?.alt?.trim();
	return alt ? alt.slice(0, LINKEDIN_MAX_ALT_TEXT) : undefined;
}

async function loadBytes(m: MediaAttachment): Promise<Uint8Array> {
	if (m.bytes) return m.bytes;
	throw new Error('Media requires bytes');
}

// Best-effort public link: LinkedIn has no deterministic permalink API, but
// /feed/update/{urn} resolves for shares. May change if the post is edited.
export function linkedinPostUrl(urn: string): string | null {
	if (!urn) return null;
	return `https://www.linkedin.com/feed/update/${encodeURIComponent(urn)}/`;
}

function restHeaders(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		'LinkedIn-Version': LINKEDIN_VERSION,
		'X-Restli-Protocol-Version': '2.0.0',
		'Content-Type': 'application/json'
	};
}

// The Images API initializeUpload schema is owner-only (plus optional
// mediaLibraryMetadata). fileSizeBytes/uploadCaptions/uploadThumbnail belong
// to the Videos API — LinkedIn rejects them here with a 400 param validation
// error ("/fileSizeBytes :: unrecognized field found but not allowed").
async function initializeImageUpload(
	token: string,
	ownerUrn: string,
	fetchImpl: FetchLike
): Promise<{ uploadUrl: string; imageUrn: string }> {
	const res = await fetchImpl('https://api.linkedin.com/rest/images?action=initializeUpload', {
		method: 'POST',
		headers: restHeaders(token),
		body: JSON.stringify({
			initializeUploadRequest: {
				owner: ownerUrn
			}
		})
	});
	if (!res.ok)
		throw Object.assign(
			new Error(`LinkedIn image init failed (${res.status}): ${(await res.text()).slice(0, 300)}`),
			{ status: res.status }
		);
	const data = (await res.json()) as {
		value?: { uploadUrl?: string; image?: string };
	};
	const uploadUrl = data.value?.uploadUrl;
	const imageUrn = data.value?.image;
	if (!uploadUrl || !imageUrn) throw new Error('LinkedIn image init returned no uploadUrl/image');
	return { uploadUrl, imageUrn };
}

interface VideoInstruction {
	url: string;
	firstByte: number;
	lastByte: number;
}

// The init response names the instruction list `uploadUrls` or
// `uploadInstructions`, with string or {uploadUrl, firstByte, lastByte}
// entries depending on API version — accept every documented shape.
function normalizeVideoInstructions(value: unknown, fileSize: number): VideoInstruction[] {
	const list = (value as Record<string, unknown> | null) ?? {};
	if (typeof list.uploadUrl === 'string' && list.uploadUrl) {
		return [{ url: list.uploadUrl, firstByte: 0, lastByte: fileSize - 1 }];
	}
	const raw = (list.uploadUrls ?? list.uploadInstructions ?? []) as unknown[];
	const out: VideoInstruction[] = [];
	for (const entry of raw) {
		if (typeof entry === 'string' && entry) {
			out.push({ url: entry, firstByte: 0, lastByte: fileSize - 1 });
		} else if (entry && typeof entry === 'object') {
			const e = entry as Record<string, unknown>;
			const url =
				typeof e.uploadUrl === 'string' ? e.uploadUrl : typeof e.url === 'string' ? e.url : '';
			if (!url) continue;
			const first = typeof e.firstByte === 'number' ? e.firstByte : 0;
			const last = typeof e.lastByte === 'number' ? e.lastByte : fileSize - 1;
			out.push({ url, firstByte: first, lastByte: last });
		}
	}
	// Validate server-supplied ranges: sorted, in-bounds, gapless, full cover.
	// A gap/overlap would upload a corrupt file or slice OOB memory.
	out.sort((a, b) => a.firstByte - b.firstByte);
	let cursor = 0;
	for (const inst of out) {
		if (
			!Number.isInteger(inst.firstByte) ||
			!Number.isInteger(inst.lastByte) ||
			inst.firstByte < 0 ||
			inst.lastByte >= fileSize ||
			inst.lastByte < inst.firstByte ||
			inst.firstByte !== cursor
		) {
			throw new Error('LinkedIn video init returned invalid upload instructions');
		}
		cursor = inst.lastByte + 1;
	}
	if (out.length > 0 && cursor !== fileSize) {
		throw new Error('LinkedIn video init returned incomplete upload instructions');
	}
	return out;
}

async function initializeVideoUpload(
	token: string,
	ownerUrn: string,
	bytes: Uint8Array,
	fetchImpl: FetchLike
): Promise<{ instructions: VideoInstruction[]; uploadToken: string; videoUrn: string }> {
	const res = await fetchImpl('https://api.linkedin.com/rest/videos?action=initializeUpload', {
		method: 'POST',
		headers: restHeaders(token),
		body: JSON.stringify({
			initializeUploadRequest: {
				owner: ownerUrn,
				fileSizeBytes: bytes.length,
				uploadCaptions: false,
				uploadThumbnail: false
			}
		})
	});
	if (!res.ok)
		throw Object.assign(
			new Error(`LinkedIn video init failed (${res.status}): ${(await res.text()).slice(0, 300)}`),
			{ status: res.status }
		);
	const data = (await res.json()) as {
		value?: {
			uploadUrl?: string;
			uploadUrls?: unknown;
			uploadInstructions?: unknown;
			uploadToken?: string;
			video?: string;
		};
	};
	const value = data.value ?? {};
	const instructions = normalizeVideoInstructions(value, bytes.length);
	const videoUrn = value.video ?? '';
	const uploadToken = value.uploadToken ?? '';
	if (!videoUrn || instructions.length === 0) {
		throw new Error('LinkedIn video init returned no upload instructions');
	}
	return { instructions, uploadToken, videoUrn };
}

async function uploadVideoParts(
	bytes: Uint8Array,
	instructions: VideoInstruction[],
	mime: string,
	fetchImpl: FetchLike
): Promise<string[]> {
	const partIds: string[] = [];
	for (const inst of instructions) {
		const slice = bytes.slice(inst.firstByte, inst.lastByte + 1);
		const res = await fetchImpl(inst.url, {
			method: 'PUT',
			headers: { 'Content-Type': mime },
			body: slice as unknown as BodyInit
		});
		if (!res.ok)
			throw Object.assign(
				new Error(
					`LinkedIn video part upload failed (${res.status}): ${(await res.text()).slice(0, 300)}`
				),
				{ status: res.status }
			);
		// Headers.get is case-insensitive; a missing ETag means finalize would
		// fail opaquely — throw here with context instead of pushing ''.
		const etag = res.headers.get('ETag');
		if (!etag) throw new Error('LinkedIn video part upload returned no ETag');
		partIds.push(etag.replace(/^"|"$/g, ''));
	}
	return partIds;
}

async function finalizeVideoUpload(
	token: string,
	videoUrn: string,
	uploadToken: string,
	uploadedPartIds: string[],
	fetchImpl: FetchLike
): Promise<void> {
	const res = await fetchImpl('https://api.linkedin.com/rest/videos?action=finalizeUpload', {
		method: 'POST',
		headers: restHeaders(token),
		body: JSON.stringify({
			finalizeUploadRequest: {
				video: videoUrn,
				uploadToken,
				uploadedPartIds
			}
		})
	});
	if (!res.ok)
		throw Object.assign(
			new Error(
				`LinkedIn video finalize failed (${res.status}): ${(await res.text()).slice(0, 300)}`
			),
			{ status: res.status }
		);
}

async function putImageBytes(
	uploadUrl: string,
	bytes: Uint8Array,
	mime: string,
	fetchImpl: FetchLike
): Promise<void> {
	const res = await fetchImpl(uploadUrl, {
		method: 'PUT',
		headers: { 'Content-Type': mime },
		body: bytes as unknown as BodyInit
	});
	if (!res.ok)
		throw Object.assign(
			new Error(
				`LinkedIn image upload failed (${res.status}): ${(await res.text()).slice(0, 300)}`
			),
			{ status: res.status }
		);
}

async function resolveArticleCard(
	text: string,
	owner: string,
	token: string,
	fetchImpl: FetchLike
): Promise<{ source: string; title: string; description: string; thumbnail?: string } | undefined> {
	// LinkedIn does NOT scrape URLs (docs). Text-only posts with a URL need an
	// explicit article; image/video posts must NOT attach one (content is one-of).
	const url = extractFirstUrl(text || '');
	if (!url) return undefined;
	let og;
	try {
		og = await fetchOpenGraph(url, fetchImpl);
	} catch {
		return undefined;
	}
	const title = (og.title || og.siteName || url).slice(0, 200);
	const description = (og.description || og.title || url).slice(0, 1000);
	if (!title) return undefined;
	let thumbnail: string | undefined;
	if (og.image) {
		try {
			const img = await fetchOgImage(og.image, fetchImpl);
			// Images API: JPEG/PNG/GIF, max 8MB. WebP rejected — skip thumb, keep card.
			const okMime = img && ['image/jpeg', 'image/png', 'image/gif'].includes(img.mime);
			if (img && okMime && img.bytes.length <= LINKEDIN_MAX_IMAGE_BYTES) {
				const init = await initializeImageUpload(token, owner, fetchImpl);
				await putImageBytes(init.uploadUrl, img.bytes, img.mime, fetchImpl);
				thumbnail = init.imageUrn;
			}
		} catch {
			// Thumb optional.
		}
	}
	return { source: url, title, description, ...(thumbnail ? { thumbnail } : {}) };
}

export const linkedinProvider: PlatformProvider = {
	id: 'linkedin',
	capabilities: {
		maxImages: LINKEDIN_MAX_IMAGES,
		maxImageBytes: LINKEDIN_MAX_IMAGE_BYTES,
		supportsCW: false,
		supportsVisibility: false,
		supportsThreads: false
	},

	validate(content: NormalizedPost): ValidationIssue[] {
		const issues: ValidationIssue[] = [];
		// Validate the flattened single post: LinkedIn combines every thread
		// segment into one post, so limits apply to the joined text and the
		// combined media rather than per segment.
		const { text, media } = singlePost(content);
		if (!text && media.length === 0) {
			issues.push({ field: 'text', message: 'Segment needs text or media', code: 'empty' });
		}
		const check = validateLinkedinText(text, LINKEDIN_MAX_CHARS);
		if (!check.ok) {
			issues.push({ field: 'text', message: check.message || 'Text too long', code: 'max_length' });
		}
		const videos = media.filter((m) => (m.mime || '').toLowerCase().startsWith('video/'));
		const images = media.filter((m) => !(m.mime || '').toLowerCase().startsWith('video/'));
		if (images.length > LINKEDIN_MAX_IMAGES) {
			issues.push({
				field: 'media',
				message: `LinkedIn allows max ${LINKEDIN_MAX_IMAGES} images`,
				code: 'max_images'
			});
		}
		if (videos.length > 1) {
			issues.push({
				field: 'media',
				message: 'LinkedIn allows one video per post',
				code: 'max_videos'
			});
		}
		if (videos.length > 0 && images.length > 0) {
			issues.push({
				field: 'media',
				message: 'LinkedIn video posts cannot include images',
				code: 'video_with_images'
			});
		}
		for (const m of videos) {
			if (!LINKEDIN_VIDEO_MIMES.includes((m.mime || '').toLowerCase())) {
				issues.push({ field: 'media', message: 'LinkedIn video must be MP4', code: 'mime' });
			} else if (mediaByteLength(m) > LINKEDIN_MAX_VIDEO_BYTES) {
				issues.push({
					field: 'media',
					message: 'LinkedIn allows max 95MB per video',
					code: 'max_video_bytes'
				});
			}
		}
		for (const m of images) {
			if (mediaByteLength(m) > LINKEDIN_MAX_IMAGE_BYTES) {
				issues.push({
					field: 'media',
					message: 'LinkedIn allows max 8MB per image',
					code: 'max_image_bytes'
				});
			}
			if (m.mime === 'image/webp') {
				issues.push({
					field: 'media',
					message: 'LinkedIn does not accept WebP — use JPEG, PNG, or GIF',
					code: 'mime'
				});
			}
		}
		return issues;
	},

	async publish(content, creds, meta, fetchImpl = providerFetch, opts): Promise<PublishResult> {
		// A checkpoint from an earlier attempt means the post went out (below);
		// only recording it failed. Posting again would publish it twice.
		const resumed = opts?.resume?.segmentIds;
		if (resumed?.length) {
			return {
				remotePostId: resumed[0] || undefined,
				remoteUrl: opts?.resume?.remoteUrl || undefined
			};
		}
		if (!creds.accessToken)
			throw new ProviderError('LinkedIn credentials require accessToken (reconnect)', {
				code: 'auth'
			});
		const owner = authorUrn(creds, meta);
		const { text, media } = singlePost(content);
		if (!text && media.length === 0) throw new Error('Segment needs text or media');

		const token = creds.accessToken;
		const videos = media.filter((m) => (m.mime || '').toLowerCase().startsWith('video/'));
		const images = media.filter((m) => !(m.mime || '').toLowerCase().startsWith('video/'));
		if (images.length > LINKEDIN_MAX_IMAGES)
			throw new Error(`LinkedIn allows max ${LINKEDIN_MAX_IMAGES} images`);
		if (videos.length > 1) throw new Error('LinkedIn allows one video per post');
		if (videos.length > 0 && images.length > 0) {
			throw new Error('LinkedIn video posts cannot include images');
		}
		let videoUrn: string | null = null;
		if (videos.length === 1) {
			const video = videos[0];
			if (!LINKEDIN_VIDEO_MIMES.includes((video.mime || '').toLowerCase())) {
				throw new Error('LinkedIn video must be MP4');
			}
			const bytes = await loadBytes(video);
			if (bytes.length > LINKEDIN_MAX_VIDEO_BYTES)
				throw new Error('LinkedIn allows max 95MB per video');
			const init = await initializeVideoUpload(token, owner, bytes, fetchImpl);
			const partIds = await uploadVideoParts(bytes, init.instructions, video.mime, fetchImpl);
			await finalizeVideoUpload(token, init.videoUrn, init.uploadToken, partIds, fetchImpl);
			videoUrn = init.videoUrn;
		}
		const imageUrns: string[] = [];
		for (const m of images) {
			const bytes = await loadBytes(m);
			if (bytes.length > LINKEDIN_MAX_IMAGE_BYTES)
				throw new Error('LinkedIn allows max 8MB per image');
			const { uploadUrl, imageUrn } = await initializeImageUpload(token, owner, fetchImpl);
			await putImageBytes(uploadUrl, bytes, m.mime, fetchImpl);
			imageUrns.push(imageUrn);
		}

		const body: Record<string, unknown> = {
			author: owner,
			commentary: escapeLittleText(text),
			visibility: 'PUBLIC',
			distribution: {
				feedDistribution: 'MAIN_FEED',
				targetEntities: [],
				thirdPartyDistributionChannels: []
			},
			lifecycleState: 'PUBLISHED',
			isReshareDisabledByAuthor: false
		};
		if (videoUrn) {
			body.content = { video: { id: videoUrn, title: text || undefined } };
		} else if (imageUrns.length === 1) {
			body.content = { media: { id: imageUrns[0], altText: linkedinAltText(images[0]) } };
		} else if (imageUrns.length > 1) {
			body.content = {
				multiImage: {
					images: imageUrns.map((id, i) => ({ id, altText: linkedinAltText(images[i]) }))
				}
			};
		} else {
			// No media: attach article card so the link unfurls with OG image.
			try {
				const article = await resolveArticleCard(text, owner, token, fetchImpl);
				if (article) body.content = { article };
			} catch {
				// Card optional — text-only post still publishes.
			}
		}

		let res: Response;
		try {
			res = await fetchImpl('https://api.linkedin.com/rest/posts', {
				method: 'POST',
				headers: restHeaders(token),
				body: JSON.stringify(body)
			});
		} catch (err) {
			throw unconfirmedPostError('LinkedIn', err);
		}
		if (!res.ok)
			throw Object.assign(
				new Error(`LinkedIn post failed (${res.status}): ${(await res.text()).slice(0, 300)}`),
				{ status: res.status }
			);
		const restId = res.headers.get('x-restli-id') || res.headers.get('X-Restli-Id');
		const data = (await res.json().catch(() => ({}))) as { id?: unknown; urn?: unknown };
		const candidate = restId || data.id || data.urn;
		const urn = typeof candidate === 'string' && candidate.trim() ? candidate : null;
		if (!urn) {
			// The post went out; only its id is missing. Recording the timestamp
			// as the id (which this used to do) invents a value that looks real
			// and can never match the platform, so leave it empty and say so.
			console.error('[linkedin] post accepted without an id; no permalink will be recorded');
		}
		const remoteUrl = urn ? (linkedinPostUrl(urn) ?? undefined) : undefined;
		// Recorded the moment the post exists: if the write that marks the row
		// published is lost, the next attempt resumes from here (above).
		await opts?.checkpoint?.({ segmentIds: [urn ?? ''], remoteUrl: remoteUrl ?? null });
		return { remotePostId: urn ?? undefined, remoteUrl };
	},

	refreshImpossibleReason(creds): string | null {
		if (creds.refreshToken && creds.clientId && creds.clientSecret) return null;
		// Refresh tokens are only issued to approved Marketing Developer Platform
		// apps, so most connections have none and live on a 60-day access token.
		// That token keeps working until it expires: only a token that has
		// actually run out makes a publish pointless.
		if (!creds.expiresAt || creds.expiresAt > Date.now()) return null;
		return 'LinkedIn token expired and cannot be refreshed — reconnect';
	},

	async refreshIfNeeded(creds, fetchImpl = providerFetch): Promise<ConnectionCredentials> {
		if (!creds.refreshToken || !creds.clientId || !creds.clientSecret) return creds;
		if (creds.expiresAt && creds.expiresAt - Date.now() > REFRESH_SKEW_MS) return creds;
		const body = new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: creds.refreshToken,
			client_id: creds.clientId,
			client_secret: creds.clientSecret
		});
		const res = await fetchImpl('https://www.linkedin.com/oauth/v2/accessToken', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body
		});
		if (!res.ok) {
			// Auth rejection (revoked/rotated refresh token): fail loud with 401
			// so publish marks the connection expired. Transients (429/5xx)
			// return creds so the attempt proceeds with the current token.
			if (res.status === 400 || res.status === 401 || res.status === 403) {
				throw new ProviderError(`LinkedIn token refresh rejected (${res.status}) — reconnect`, {
					status: 401,
					code: 'auth'
				});
			}
			return creds;
		}
		const data = (await res.json()) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
		};
		if (!data.access_token) {
			throw new ProviderError('LinkedIn token refresh returned no token — reconnect', {
				status: 401,
				code: 'auth'
			});
		}
		return {
			...creds,
			accessToken: data.access_token,
			refreshToken: data.refresh_token || creds.refreshToken,
			expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : creds.expiresAt
		};
	}
};

// --- OAuth helpers ---

export function linkedinAuthorizeUrl(
	clientId: string,
	appUrl: string,
	state: string,
	scopes = ['openid', 'profile', 'email', 'w_member_social']
): string {
	const redirect = `${appUrl.replace(/\/$/, '')}/api/connections/linkedin/callback`;
	const params = new URLSearchParams({
		response_type: 'code',
		client_id: clientId,
		redirect_uri: redirect,
		scope: scopes.join(' '),
		state
	});
	return `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`;
}

export async function linkedinExchangeCode(
	args: {
		clientId: string;
		clientSecret: string;
		code: string;
		appUrl: string;
	},
	fetchImpl: FetchLike = providerFetch
): Promise<ConnectionCredentials & ConnectionMeta> {
	const redirect = `${args.appUrl.replace(/\/$/, '')}/api/connections/linkedin/callback`;
	const body = new URLSearchParams({
		grant_type: 'authorization_code',
		code: args.code,
		client_id: args.clientId,
		client_secret: args.clientSecret,
		redirect_uri: redirect
	});
	const tokRes = await fetchImpl('https://www.linkedin.com/oauth/v2/accessToken', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body
	});
	if (!tokRes.ok)
		throw Object.assign(
			new Error(
				`LinkedIn token exchange failed (${tokRes.status}): ${(await tokRes.text()).slice(0, 300)}`
			),
			{ status: tokRes.status }
		);
	const tok = (await tokRes.json()) as {
		access_token: string;
		refresh_token?: string;
		expires_in?: number;
		scope?: string;
	};

	const meRes = await fetchImpl('https://api.linkedin.com/v2/userinfo', {
		headers: { Authorization: `Bearer ${tok.access_token}` }
	});
	if (!meRes.ok)
		throw Object.assign(
			new Error(
				`LinkedIn userinfo failed (${meRes.status}): ${(await meRes.text()).slice(0, 300)}`
			),
			{ status: meRes.status }
		);
	const me = (await meRes.json()) as {
		sub?: string;
		name?: string;
		email?: string;
		picture?: string;
	};
	if (!me.sub) throw new Error('LinkedIn userinfo returned no sub');
	const personUrn = `urn:li:person:${me.sub}`;

	return {
		accessToken: tok.access_token,
		refreshToken: tok.refresh_token,
		expiresAt: tok.expires_in ? Date.now() + tok.expires_in * 1000 : undefined,
		tokenType: 'Bearer',
		scopes: tok.scope ? tok.scope.split(' ') : undefined,
		clientId: args.clientId,
		clientSecret: args.clientSecret,
		personUrn,
		openIdSub: me.sub,
		handle: me.email || me.name || me.sub,
		displayName: me.name || me.email || 'LinkedIn',
		avatarUrl: me.picture,
		maxCharacters: LINKEDIN_MAX_CHARS
	};
}

export async function linkedinVerify(
	creds: ConnectionCredentials,
	fetchImpl: FetchLike = providerFetch
): Promise<{ displayName?: string; avatarUrl?: string; handle?: string }> {
	if (!creds.accessToken) throw new Error('Missing accessToken');
	const res = await fetchImpl('https://api.linkedin.com/v2/userinfo', {
		headers: { Authorization: `Bearer ${creds.accessToken}` }
	});
	if (!res.ok)
		throw Object.assign(new Error(`LinkedIn verify failed (${res.status})`), {
			status: res.status
		});
	const me = (await res.json()) as {
		name?: string;
		email?: string;
		picture?: string;
		sub?: string;
	};
	return { displayName: me.name, avatarUrl: me.picture, handle: me.email || me.name || me.sub };
}

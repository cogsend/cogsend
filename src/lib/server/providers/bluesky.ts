import { utf8ByteLength } from '$lib/domain/bytes';
import { extractFirstUrl } from '$lib/domain/links';
import { fetchOgImage } from '../opengraph';
import { fetchLinkCard } from '../x-post-preview';
import { isBlockedInstanceHost } from '$lib/domain/instance-host';
import { validateBlueskyText } from '$lib/domain/validation/text';
import { BLUESKY_MAX_IMAGE_BYTES } from '$lib/domain/media-limits';
import type {
	ConnectionCredentials,
	FetchLike,
	MediaAttachment,
	NormalizedPost,
	PlatformProvider,
	PublishResult,
	ValidationIssue
} from './types';
import {
	mediaByteLength,
	providerErrorForStatus,
	ProviderError,
	PublishPartialError
} from './types';
import { providerFetch } from './timed-fetch';

const DEFAULT_PDS = 'https://bsky.social';

// Validate a user-supplied PDS host. Without this, an authenticated user can
// make the server POST to an arbitrary host/port (`pdsHost` SSRF) and read
// the error body. Mirrors the Mastodon instance check.
export function sanitizeBlueskyPdsHost(raw: string, allowLocal = false): string {
	let u = raw.trim().replace(/\/$/, '');
	if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
	const parsed = new URL(u);
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		throw new Error('PDS URL must be http(s)');
	}
	if (!allowLocal && parsed.protocol !== 'https:') {
		throw new Error('PDS URL must use https');
	}
	if (isBlockedInstanceHost(parsed.hostname, { allowLocal })) {
		throw new Error('PDS host not allowed');
	}
	return `${parsed.protocol}//${parsed.host}`;
}

// Attach the upstream HTTP status so the API layer can map 401/429 instead of
// collapsing everything to 500, and cap remote bodies (log/history hygiene).
// 401/403/429 classify into typed codes (auth/forbidden/rate_limited) so
// publish can decide expiry without regexing messages.
function upstreamError(prefix: string, status: number, body: string): ProviderError {
	return providerErrorForStatus(prefix, status, body);
}

function pds(creds: ConnectionCredentials): string {
	// Stored rows predate validation; re-check on every use (fail closed).
	return sanitizeBlueskyPdsHost(creds.pdsHost || DEFAULT_PDS);
}

export function buildLinkFacets(text: string): Array<{
	index: { byteStart: number; byteEnd: number };
	features: Array<{ $type: string; uri: string }>;
}> {
	const facets: Array<{
		index: { byteStart: number; byteEnd: number };
		features: Array<{ $type: string; uri: string }>;
	}> = [];
	const re = /https?:\/\/[^\s]+/gi;
	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) !== null) {
		const url = match[0].replace(/[.,);:!?]+$/, '');
		const byteStart = utf8ByteLength(text.slice(0, match.index));
		const byteEnd = byteStart + utf8ByteLength(url);
		facets.push({
			index: { byteStart, byteEnd },
			features: [{ $type: 'app.bsky.richtext.facet#link', uri: url }]
		});
	}
	return facets;
}

/** Refresh when an access token has less than this left. */
const ACCESS_JWT_SKEW_MS = 5 * 60_000;

/** The `exp` of a JWT in milliseconds, or null when it cannot be read. */
export function jwtExpiryMs(token: string | undefined): number | null {
	const payload = token?.split('.')[1];
	if (!payload) return null;
	try {
		const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
		const exp = (JSON.parse(json) as { exp?: unknown }).exp;
		return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
	} catch {
		return null;
	}
}

async function ensureSession(
	creds: ConnectionCredentials,
	fetchImpl: FetchLike
): Promise<ConnectionCredentials> {
	if (creds.accessJwt && creds.did) return creds;
	if (!creds.handle || !creds.appPassword) {
		throw new ProviderError('Bluesky credentials require handle and appPassword (or accessJwt)', {
			code: 'auth'
		});
	}
	const res = await fetchImpl(`${pds(creds)}/xrpc/com.atproto.server.createSession`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ identifier: creds.handle, password: creds.appPassword })
	});
	if (!res.ok) {
		throw upstreamError('Bluesky createSession', res.status, await res.text());
	}
	const data = (await res.json()) as {
		accessJwt: string;
		refreshJwt: string;
		did: string;
		handle: string;
	};
	return {
		...creds,
		accessJwt: data.accessJwt,
		refreshJwt: data.refreshJwt,
		did: data.did,
		handle: data.handle
	};
}

async function refreshSession(
	creds: ConnectionCredentials,
	fetchImpl: FetchLike
): Promise<ConnectionCredentials> {
	if (!creds.refreshJwt) {
		return ensureSession({ ...creds, accessJwt: undefined }, fetchImpl);
	}
	const res = await fetchImpl(`${pds(creds)}/xrpc/com.atproto.server.refreshSession`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${creds.refreshJwt}` }
	});
	if (!res.ok) {
		return ensureSession({ ...creds, accessJwt: undefined, refreshJwt: undefined }, fetchImpl);
	}
	const data = (await res.json()) as { accessJwt: string; refreshJwt: string; did: string };
	return { ...creds, accessJwt: data.accessJwt, refreshJwt: data.refreshJwt, did: data.did };
}

async function loadMediaBytes(media: MediaAttachment): Promise<Uint8Array> {
	if (media.bytes) return media.bytes;
	throw new Error('Media requires bytes');
}

async function uploadBlob(
	creds: ConnectionCredentials,
	media: MediaAttachment,
	fetchImpl: FetchLike
) {
	const bytes = await loadMediaBytes(media);
	const res = await fetchImpl(`${pds(creds)}/xrpc/com.atproto.repo.uploadBlob`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${creds.accessJwt}`,
			'Content-Type': media.mime
		},
		body: bytes as unknown as BodyInit
	});
	if (!res.ok) {
		throw upstreamError('Bluesky uploadBlob', res.status, await res.text());
	}
	const data = (await res.json()) as {
		blob: { $type: string; ref: { $link: string }; mimeType: string; size: number };
	};
	return data.blob;
}

async function createPostRecord(
	creds: ConnectionCredentials,
	post: {
		text: string;
		createdAt: string;
		facets?: ReturnType<typeof buildLinkFacets>;
		embed?: unknown;
		reply?: { root: { uri: string; cid: string }; parent: { uri: string; cid: string } };
	},
	fetchImpl: FetchLike,
	rkey?: string
): Promise<{ uri?: string; cid?: string }> {
	const res = await fetchImpl(`${pds(creds)}/xrpc/com.atproto.repo.createRecord`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${creds.accessJwt}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			repo: creds.did,
			collection: 'app.bsky.feed.post',
			// A record key we choose, so a retry lands on the same key: the PDS
			// refuses the duplicate instead of creating a second post, and the
			// refusal is turned back into "it is already published" below.
			...(rkey ? { rkey } : {}),
			record: { $type: 'app.bsky.feed.post', ...post }
		})
	});
	if (!res.ok) {
		const detail = await res.text();
		// A retry whose first attempt landed but lost its response. The PDS
		// does not say so in a recognisable way — a taken key surfaces as a
		// generic 500 from the repository layer — so ask whether our key holds
		// a record. It is derived from this target and segment, so a record
		// there is this post. 401 is left alone: the caller refreshes and
		// retries, and a lookup with the same token would only fail too.
		if (rkey && res.status !== 401) {
			const uri = `at://${creds.did}/app.bsky.feed.post/${rkey}`;
			const cid = await resolveRecordCid(creds, uri, fetchImpl).catch(() => null);
			if (cid) return { uri, cid };
		}
		throw upstreamError('Bluesky createRecord', res.status, detail);
	}
	// Validated rather than cast: the record went out whatever the body says,
	// and a missing uri is reported to the caller so it can decide (a reply
	// chain cannot continue without one, but the post itself is published).
	const data = (await res.json().catch(() => ({}))) as { uri?: unknown; cid?: unknown };
	const uri = typeof data.uri === 'string' && data.uri ? data.uri : undefined;
	const cid = typeof data.cid === 'string' && data.cid ? data.cid : undefined;
	if (!uri || !cid)
		console.error('[bluesky] createRecord answered without a record uri/cid', {
			uri: uri ?? null,
			cid: cid ?? null
		});
	return { uri, cid };
}

async function resolveRecordCid(
	creds: ConnectionCredentials,
	uri: string,
	fetchImpl: FetchLike
): Promise<string> {
	const parts = uri.replace('at://', '').split('/');
	const repo = parts[0];
	const rkey = parts[parts.length - 1];
	const collection = parts.slice(1, -1).join('/');
	const url =
		`${pds(creds)}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(repo)}` +
		`&collection=${encodeURIComponent(collection)}&rkey=${encodeURIComponent(rkey)}`;
	const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${creds.accessJwt}` } });
	if (!res.ok) {
		throw upstreamError('Bluesky checkpoint lookup', res.status, await res.text());
	}
	const data = (await res.json()) as { cid?: string };
	if (!data.cid) throw new Error('Bluesky checkpoint lookup returned no record id');
	return data.cid;
}

function publicUrl(uri: string, handle?: string): string {
	const parts = uri.replace('at://', '').split('/');
	const rkey = parts[parts.length - 1];
	const actor = handle || parts[0];
	return `https://bsky.app/profile/${actor}/post/${rkey}`;
}

async function resolveExternalEmbed(
	text: string,
	session: ConnectionCredentials,
	fetchImpl: FetchLike
): Promise<unknown | undefined> {
	// One embed per post: images win, external card only when no media. That is
	// the convention bsky.app and every other composer follows.
	const url = extractFirstUrl(text || '');
	if (!url) return undefined;
	let og;
	try {
		og = await fetchLinkCard(url, fetchImpl);
	} catch {
		return undefined;
	}
	const title = (og.title || og.siteName || url).slice(0, 300);
	const description = (og.description || og.title || url).slice(0, 1000);
	if (!title || !description) return undefined;
	let thumb;
	if (og.image) {
		try {
			const img = await fetchOgImage(og.image, fetchImpl);
			// Lexicon: external thumb blob image/* max 1MB. Exclude SVG
			// (vector, PDS rejects it as a raster thumb — skip, keep card).
			if (
				img &&
				img.bytes.length <= 1000000 &&
				img.mime.startsWith('image/') &&
				img.mime !== 'image/svg+xml'
			) {
				thumb = await uploadBlob(session, { bytes: img.bytes, mime: img.mime }, fetchImpl);
			}
		} catch {
			// Thumb is optional — card without image still renders.
		}
	}
	return {
		$type: 'app.bsky.embed.external',
		external: { uri: url, title, description, ...(thumb ? { thumb } : {}) }
	};
}

async function publishOne(
	content: NormalizedPost,
	creds: ConnectionCredentials,
	fetchImpl: FetchLike,
	reply?: { root: { uri: string; cid: string }; parent: { uri: string; cid: string } },
	rkey?: string
): Promise<{ uri?: string; cid?: string }> {
	let session = await ensureSession(creds, fetchImpl);
	const media = content.media ?? [];
	let embed: unknown;
	if (media.length > 0) {
		const images = [];
		for (const m of media.slice(0, 4)) {
			if ((m.mime || '').toLowerCase().startsWith('video/')) {
				throw new Error('Bluesky does not support video — post it to LinkedIn');
			}
			const blob = await uploadBlob(session, m, fetchImpl);
			images.push({
				alt: m.alt || '',
				image: blob,
				...(m.width && m.height ? { aspectRatio: { width: m.width, height: m.height } } : {})
			});
		}
		embed = { $type: 'app.bsky.embed.images', images };
	} else {
		try {
			embed = await resolveExternalEmbed(content.text || '', session, fetchImpl);
		} catch {
			embed = undefined;
		}
	}
	const facets = buildLinkFacets(content.text);
	try {
		return await createPostRecord(
			session,
			{
				text: content.text,
				createdAt: new Date().toISOString(),
				facets: facets.length ? facets : undefined,
				embed,
				reply
			},
			fetchImpl,
			rkey
		);
	} catch (err) {
		// Only an expired token justifies a refresh + single retry. Retrying on
		// 400/429/500 masks the real error and burns an extra PDS round trip.
		if ((err as { status?: number } | null)?.status !== 401) throw err;
		session = await refreshSession(session, fetchImpl);
		Object.assign(creds, session);
		return createPostRecord(
			session,
			{
				text: content.text,
				createdAt: new Date().toISOString(),
				facets: facets.length ? facets : undefined,
				embed,
				reply
			},
			fetchImpl,
			rkey
		);
	}
}

export const blueskyProvider: PlatformProvider = {
	id: 'bluesky',
	capabilities: {
		maxImages: 4,
		maxImageBytes: BLUESKY_MAX_IMAGE_BYTES,
		supportsCW: false,
		supportsVisibility: false,
		supportsThreads: true
	},

	validate(content: NormalizedPost): ValidationIssue[] {
		const issues: ValidationIssue[] = [];
		const segments = content.thread && content.thread.length > 0 ? content.thread : [content];
		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i];
			const hasMedia = (seg.media?.length ?? 0) > 0;
			if (!seg.text?.trim() && !hasMedia) {
				issues.push({
					field: `thread[${i}]`,
					message: 'Segment needs text or media',
					code: 'empty'
				});
			}
			const textCheck = validateBlueskyText(seg.text || '');
			if (!textCheck.ok && (seg.text || '').length > 0) {
				issues.push({
					field: `thread[${i}].text`,
					message: textCheck.message || 'Text too long',
					code: 'max_length'
				});
			}
			if ((seg.media?.length ?? 0) > 4) {
				issues.push({
					field: `thread[${i}].media`,
					message: 'Bluesky allows max 4 images',
					code: 'max_images'
				});
			}
			for (const m of seg.media ?? []) {
				if ((m.mime || '').toLowerCase().startsWith('video/')) {
					issues.push({
						field: `thread[${i}].media`,
						message: 'Bluesky does not support video — post it to LinkedIn',
						code: 'no_video'
					});
				} else if (mediaByteLength(m) > BLUESKY_MAX_IMAGE_BYTES) {
					issues.push({
						field: `thread[${i}].media`,
						message: 'Bluesky allows max 2MB per image',
						code: 'max_image_bytes'
					});
				}
			}
		}
		return issues;
	},

	async publish(content, creds, _meta, fetchImpl = providerFetch, opts): Promise<PublishResult> {
		const segments = content.thread && content.thread.length > 0 ? content.thread : [content];
		const resumeIds = opts?.resume?.segmentIds ?? [];
		const resumeCids = opts?.resume?.segmentCids ?? [];
		const startAt = Math.min(resumeIds.length, segments.length);
		const segmentIds = resumeIds.slice(0, startAt);
		const segmentCids = resumeCids.slice(0, startAt);
		// Old checkpoints may lack record CIDs; resolve the real ones so reply
		// references stay valid instead of sending a fabricated id.
		if (segmentIds.some((_, i) => !segmentCids[i])) {
			const session = await ensureSession(creds, fetchImpl);
			for (let i = 0; i < segmentIds.length; i++) {
				if (!segmentCids[i])
					segmentCids[i] = await resolveRecordCid(session, segmentIds[i], fetchImpl);
			}
		}
		const cidAt = (i: number): string => {
			const cid = segmentCids[i];
			if (!cid) throw new Error('Bluesky checkpoint is missing record ids; cannot resume safely');
			return cid;
		};
		let root: { uri: string; cid: string } | null = segmentIds[0]
			? { uri: segmentIds[0], cid: cidAt(0) }
			: null;
		let parent: { uri: string; cid: string } | null = segmentIds.at(-1)
			? { uri: segmentIds[segmentIds.length - 1], cid: cidAt(segmentCids.length - 1) }
			: null;

		for (let i = startAt; i < segments.length; i++) {
			try {
				const reply = root && parent ? { root, parent } : undefined;
				// The rkey is derived from the target and the segment, so the
				// retry of a lost response hits the same key instead of creating a
				// second post. It must be a TID: posts declare `"key": "tid"` and
				// the PDS refuses any other record key.
				const result = await publishOne(segments[i], creds, fetchImpl, reply, opts?.recordKey?.(i));
				// The count matters even when the ids are missing: the checkpoint
				// is what stops a retry from reposting a segment.
				segmentIds.push(result.uri ?? '');
				segmentCids.push(result.cid ?? '');
				if (result.uri && result.cid) {
					const record = { uri: result.uri, cid: result.cid };
					if (!root) root = record;
					parent = record;
				} else if (i < segments.length - 1) {
					// A reply needs the parent's uri: stop here with what was
					// posted, so the retry resumes after this segment rather than
					// posting it a second time.
					throw new PublishPartialError(
						'Bluesky accepted the post but returned no record id — the rest of the thread cannot be linked',
						{
							segmentIds: [...segmentIds],
							segmentCids: [...segmentCids],
							remoteUrl: opts?.resume?.remoteUrl ?? null
						}
					);
				}
				await opts?.checkpoint?.({
					segmentIds: [...segmentIds],
					segmentCids: [...segmentCids],
					remoteUrl: opts?.resume?.remoteUrl || publicUrl(segmentIds[0], creds.handle)
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (segmentIds.length) {
					throw new PublishPartialError(message, {
						segmentIds,
						segmentCids,
						remoteUrl: opts?.resume?.remoteUrl || publicUrl(segmentIds[0], creds.handle)
					});
				}
				throw err;
			}
			if (i < segments.length - 1) await new Promise((r) => setTimeout(r, 50));
		}

		const first = segmentIds[0];
		return {
			remotePostId: first || undefined,
			remoteUrl: first ? opts?.resume?.remoteUrl || publicUrl(first, creds.handle) : undefined,
			segmentIds,
			segmentCids
		};
	},

	async refreshIfNeeded(creds, fetchImpl = providerFetch) {
		// Refreshing rotates the refresh token and costs a call, so only do it
		// when the access token is close to running out. A token whose expiry
		// cannot be read is refreshed, as every publish used to.
		const exp = jwtExpiryMs(creds.accessJwt);
		if (creds.did && exp !== null && exp - Date.now() > ACCESS_JWT_SKEW_MS) return creds;
		return refreshSession(creds, fetchImpl);
	}
};

export async function blueskyCreateSession(
	handle: string,
	appPassword: string,
	pdsHost = DEFAULT_PDS,
	fetchImpl: FetchLike = providerFetch
): Promise<ConnectionCredentials & { displayName?: string; avatarUrl?: string }> {
	const host = sanitizeBlueskyPdsHost(pdsHost);
	const res = await fetchImpl(`${host}/xrpc/com.atproto.server.createSession`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ identifier: handle, password: appPassword })
	});
	if (!res.ok) {
		throw upstreamError('Bluesky login', res.status, await res.text());
	}
	const data = (await res.json()) as {
		accessJwt: string;
		refreshJwt: string;
		did: string;
		handle: string;
	};

	let displayName = data.handle;
	let avatarUrl: string | undefined;
	try {
		const profRes = await fetchImpl(
			`${host}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(data.did)}`,
			{ headers: { Authorization: `Bearer ${data.accessJwt}` } }
		);
		if (profRes.ok) {
			const profile = (await profRes.json()) as {
				displayName?: string;
				avatar?: string;
				handle?: string;
			};
			if (profile.displayName) displayName = profile.displayName;
			else if (profile.handle) displayName = profile.handle;
			if (profile.avatar) avatarUrl = profile.avatar;
		}
	} catch {
		/* optional */
	}

	return {
		handle: data.handle,
		appPassword,
		accessJwt: data.accessJwt,
		refreshJwt: data.refreshJwt,
		did: data.did,
		pdsHost: host,
		displayName,
		avatarUrl
	};
}

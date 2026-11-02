import { extractFirstUrl } from '#lib/domain/links.js';
import { fetchOgImage } from '../opengraph';
import { fetchLinkCard } from '../x-post-preview';
import { isBlockedInstanceHost } from '#lib/domain/instance-host.js';
import { validateBlueskyText } from '#lib/domain/validation/text.js';
import { blueskyRichText, type BlueskyLinkFacet } from '#lib/domain/bluesky-links.js';
import { BLUESKY_MAX_IMAGE_BYTES } from '#lib/domain/media-limits.js';
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
import {
	mediaByteLength,
	processingError,
	providerErrorForStatus,
	ProviderError,
	PublishPartialError,
	resumedVideoState
} from './types';
import {
	fixedLengthBody,
	isVideoAttachment,
	pollVideo,
	requireMediaReader,
	segmentVideo,
	videoValidation
} from './video';
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
		facets?: BlueskyLinkFacet[];
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

type PublishOpts = Parameters<PlatformProvider['publish']>[4];
type BlobRef = { $type: string; ref: { $link: string }; mimeType: string; size: number };

const VIDEO_SERVICE = 'https://video.bsky.app';
const VIDEO_SERVICE_DID = 'did:web:video.bsky.app';
const VIDEO_JOB_POLLS = 6;
const VIDEO_JOB_POLL_MS = 2000;

/**
 * The host of the account's own PDS. A bsky.social login goes through an
 * entryway that is not the PDS itself, and the video service hands the upload
 * on to the PDS with a token addressed to it, so the DID document decides.
 */
async function pdsServiceHost(creds: ConnectionCredentials, fetchImpl: FetchLike): Promise<string> {
	const fallback = new URL(pds(creds)).host;
	const did = creds.did ?? '';
	try {
		let docUrl: string | null = null;
		if (did.startsWith('did:plc:')) docUrl = `https://plc.directory/${encodeURIComponent(did)}`;
		else if (did.startsWith('did:web:')) {
			docUrl = `${sanitizeBlueskyPdsHost(decodeURIComponent(did.slice(8)))}/.well-known/did.json`;
		}
		if (!docUrl) return fallback;
		const res = await fetchImpl(docUrl);
		if (!res.ok) return fallback;
		const doc = (await res.json()) as {
			service?: { id?: string; type?: string; serviceEndpoint?: string }[];
		};
		const entry = doc.service?.find(
			(s) => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer'
		);
		return entry?.serviceEndpoint
			? new URL(sanitizeBlueskyPdsHost(entry.serviceEndpoint)).host
			: fallback;
	} catch {
		return fallback;
	}
}

async function serviceAuth(
	creds: ConnectionCredentials,
	aud: string,
	lxm: string,
	fetchImpl: FetchLike
): Promise<string> {
	const exp = Math.floor(Date.now() / 1000) + 30 * 60;
	const ask = (session: ConnectionCredentials) =>
		fetchImpl(
			`${pds(session)}/xrpc/com.atproto.server.getServiceAuth?aud=${encodeURIComponent(aud)}&lxm=${encodeURIComponent(lxm)}&exp=${exp}`,
			{ headers: { Authorization: `Bearer ${session.accessJwt}` } }
		);
	let res = await ask(creds);
	if (res.status === 401) {
		Object.assign(creds, await refreshSession(creds, fetchImpl));
		res = await ask(creds);
	}
	if (!res.ok) throw upstreamError('Bluesky getServiceAuth', res.status, await res.text());
	const data = (await res.json()) as { token?: string };
	if (!data.token) throw new Error('Bluesky getServiceAuth returned no token');
	return data.token;
}

interface VideoJob {
	state?: string;
	blob?: BlobRef;
	error?: string;
	message?: string;
}

function jobFailure(job: VideoJob): ProviderError {
	return new ProviderError(
		`Bluesky could not process the video: ${job.message || job.error || 'unknown error'}`,
		{ code: 'forbidden' }
	);
}

/**
 * The video service transcodes before the post may reference the blob, which
 * takes longer than a request is worth waiting: the job id is parked and a
 * later run asks again (processingError). Daily limits and an unverified email
 * are refused up front by getUploadLimits, with Bluesky's own words.
 */
async function uploadVideo(
	creds: ConnectionCredentials,
	video: MediaAttachment,
	segmentIndex: number,
	fetchImpl: FetchLike,
	opts: PublishOpts
): Promise<BlobRef> {
	if (!video.storageKey) throw new Error('Bluesky video is missing its storage key');
	const storageKey = video.storageKey;
	const callsLeft = opts?.callsLeft ?? (() => Infinity);
	const resumed = resumedVideoState(opts?.resume, segmentIndex, storageKey);
	let jobId = typeof resumed?.jobId === 'string' ? resumed.jobId : '';
	if (!jobId) {
		const limitsToken = await serviceAuth(
			creds,
			VIDEO_SERVICE_DID,
			'app.bsky.video.getUploadLimits',
			fetchImpl
		);
		const limitsRes = await fetchImpl(`${VIDEO_SERVICE}/xrpc/app.bsky.video.getUploadLimits`, {
			headers: { Authorization: `Bearer ${limitsToken}` }
		});
		if (limitsRes.ok) {
			const limits = (await limitsRes.json()) as {
				canUpload?: boolean;
				message?: string;
				error?: string;
			};
			if (limits.canUpload === false) {
				throw new ProviderError(
					`Bluesky will not take a video from this account right now: ${limits.message || limits.error || 'upload limit reached'}`,
					{ code: 'forbidden' }
				);
			}
		}
		const pdsHost = await pdsServiceHost(creds, fetchImpl);
		const uploadToken = await serviceAuth(
			creds,
			`did:web:${pdsHost}`,
			'com.atproto.repo.uploadBlob',
			fetchImpl
		);
		const stored = await requireMediaReader(opts?.mediaReader).open(storageKey);
		if (!stored) throw new Error('The video file is missing from storage — attach it again');
		const res = await fetchImpl(
			`${VIDEO_SERVICE}/xrpc/app.bsky.video.uploadVideo?did=${encodeURIComponent(creds.did ?? '')}&name=${encodeURIComponent(storageKey)}`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${uploadToken}`,
					'Content-Type': video.mime,
					'Content-Length': String(stored.size)
				},
				body: fixedLengthBody(stored.body, stored.size),
				duplex: 'half'
			} as RequestInit
		);
		const answer = (await res.json().catch(() => ({}))) as VideoJob & {
			jobId?: string;
			jobStatus?: VideoJob & { jobId?: string };
		};
		const job = answer.jobStatus ?? answer;
		// The same file uploaded before: the service answers with that job.
		if (!res.ok && job.error !== 'already_exists') {
			throw upstreamError('Bluesky uploadVideo', res.status, JSON.stringify(answer).slice(0, 300));
		}
		if (job.blob) return job.blob;
		if (job.state === 'JOB_STATE_FAILED') throw jobFailure(job);
		jobId = job.jobId ?? answer.jobId ?? '';
		if (!jobId) throw new Error('Bluesky uploadVideo returned no job');
	}
	const job = jobId;
	const blob = await pollVideo(
		{
			polls: VIDEO_JOB_POLLS,
			delayMs: VIDEO_JOB_POLL_MS,
			reserve: 6,
			callsLeft,
			timeLeft: opts?.timeLeft
		},
		async () => {
			const res = await fetchImpl(
				`${VIDEO_SERVICE}/xrpc/app.bsky.video.getJobStatus?jobId=${encodeURIComponent(job)}`
			);
			if (!res.ok) return null;
			const status = ((await res.json()) as { jobStatus?: VideoJob }).jobStatus ?? {};
			if (status.blob) return status.blob;
			if (status.state === 'JOB_STATE_FAILED') throw jobFailure(status);
			return null;
		}
	);
	if (blob) return blob;
	throw processingError('Bluesky', { segment: segmentIndex, storageKey, state: { jobId } });
}

async function publishOne(
	content: NormalizedPost,
	creds: ConnectionCredentials,
	fetchImpl: FetchLike,
	reply?: { root: { uri: string; cid: string }; parent: { uri: string; cid: string } },
	rkey?: string,
	video?: { segmentIndex: number; opts: PublishOpts }
): Promise<{ uri?: string; cid?: string }> {
	let session = await ensureSession(creds, fetchImpl);
	const media = content.media ?? [];
	const single = segmentVideo(media);
	let embed: unknown;
	if (single) {
		const blob = await uploadVideo(
			session,
			single,
			video?.segmentIndex ?? 0,
			fetchImpl,
			video?.opts
		);
		embed = {
			$type: 'app.bsky.embed.video',
			video: blob,
			...(single.alt ? { alt: single.alt } : {}),
			...(single.width && single.height
				? { aspectRatio: { width: single.width, height: single.height } }
				: {})
		};
	} else if (media.length > 0) {
		const images = [];
		for (const m of media.slice(0, 4)) {
			if (isVideoAttachment(m)) throw new Error('Videos cannot mix with images on the same post');
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
	// The link card above reads the full URL; the record gets the short text.
	const { text, facets } = blueskyRichText(content.text || '', { shortenLinks: true });
	try {
		return await createPostRecord(
			session,
			{
				text,
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
				text,
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

/** `shortenLinks` says whether the links will be posted short, as publishOne does. */
export function validateBlueskyPost(
	content: NormalizedPost,
	meta: ConnectionMeta | undefined,
	{ shortenLinks }: { shortenLinks: boolean }
): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	const segments = content.thread && content.thread.length > 0 ? content.thread : [content];
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		issues.push(...videoValidation('bluesky', seg.media, meta, `thread[${i}].media`));
		const hasMedia = (seg.media?.length ?? 0) > 0;
		if (!seg.text?.trim() && !hasMedia) {
			issues.push({
				field: `thread[${i}]`,
				message: 'Segment needs text or media',
				code: 'empty'
			});
		}
		const textCheck = validateBlueskyText(seg.text || '', { shortenLinks });
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
			if (isVideoAttachment(m)) {
				continue;
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

	validate: (content, meta) => validateBlueskyPost(content, meta, { shortenLinks: true }),

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
				const result = await publishOne(
					segments[i],
					creds,
					fetchImpl,
					reply,
					opts?.recordKey?.(i),
					{
						segmentIndex: i,
						opts
					}
				);
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
						remoteUrl: opts?.resume?.remoteUrl || publicUrl(segmentIds[0], creds.handle),
						cause: err
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

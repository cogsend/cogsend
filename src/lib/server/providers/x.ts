import { validateXText } from '$lib/domain/validation/text';
import { mediaByteLength } from './types';
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
import { ProviderError, PublishPartialError, unconfirmedPostError } from './types';
import { X_MAX_GIF_BYTES, X_MAX_IMAGE_BYTES } from '$lib/domain/media-limits';
import { providerFetch } from './timed-fetch';

export const X_MAX_CHARS = 280;
export const X_MAX_IMAGES = 4;
export { X_MAX_GIF_BYTES, X_MAX_IMAGE_BYTES } from '$lib/domain/media-limits';
const X_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
// APPEND chunks: server max is 8MB; docs recommend <=5MB.
const X_UPLOAD_CHUNK_BYTES = 5_000_000;
// STATUS poll budget: honor check_after_secs (capped) up to ~30s total.
const X_MEDIA_POLL_ATTEMPTS = 10;
const X_MEDIA_POLL_MAX_WAIT_MS = 5_000;
// Access tokens live 2h; refresh proactively so scheduled ticks never race expiry.
const REFRESH_SKEW_MS = 5 * 60 * 1000;

const X_API = 'https://api.x.com';
const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';

export const X_SCOPES = [
	'tweet.read',
	'tweet.write',
	'users.read',
	'offline.access',
	'media.write'
];

function xUserId(creds: ConnectionCredentials, meta?: ConnectionMeta): string {
	const id = creds.xUserId || meta?.xUserId;
	if (id) return id;
	throw new ProviderError('X credentials require user id (reconnect account)', { code: 'auth' });
}

function xUsername(creds: ConnectionCredentials, meta?: ConnectionMeta): string | undefined {
	const u = creds.xUsername || meta?.handle?.replace(/^@/, '');
	return u || undefined;
}

export function xPostUrl(postId: string, username?: string): string | null {
	if (!postId) return null;
	if (username && /^[A-Za-z0-9_]{1,15}$/.test(username)) {
		return `https://x.com/${username}/status/${encodeURIComponent(postId)}`;
	}
	return `https://x.com/i/status/${encodeURIComponent(postId)}`;
}

function isGif(m: MediaAttachment): boolean {
	return (m.mime || '').toLowerCase() === 'image/gif';
}

function isVideo(m: MediaAttachment): boolean {
	return (m.mime || '').toLowerCase().startsWith('video/');
}

function validateSegmentMedia(media: MediaAttachment[]): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	if (media.length > X_MAX_IMAGES) {
		issues.push({
			field: 'media',
			message: `X allows max ${X_MAX_IMAGES} photos per post`,
			code: 'max_images'
		});
	}
	const videos = media.filter(isVideo);
	if (videos.length > 0) {
		issues.push({
			field: 'media',
			message: 'X video is not supported yet — post it to LinkedIn',
			code: 'no_video'
		});
	}
	const gifs = media.filter(isGif);
	if (gifs.length > 1) {
		issues.push({
			field: 'media',
			message: 'X allows one GIF per post, on its own',
			code: 'max_gifs'
		});
	}
	if (gifs.length === 1 && media.length > 1) {
		issues.push({
			field: 'media',
			message: 'X allows one GIF per post, on its own',
			code: 'gif_with_images'
		});
	}
	for (const m of media) {
		if (isVideo(m)) continue;
		if (!X_IMAGE_MIMES.has((m.mime || '').toLowerCase())) {
			issues.push({
				field: 'media',
				message: 'X images must be JPEG, PNG, GIF, or WebP',
				code: 'mime'
			});
		} else {
			const cap = isGif(m) ? X_MAX_GIF_BYTES : X_MAX_IMAGE_BYTES;
			if (mediaByteLength(m) > cap) {
				issues.push({
					field: 'media',
					message: isGif(m) ? 'X allows max 15MB per GIF' : 'X allows max 5MB per image',
					code: 'max_image_bytes'
				});
			}
		}
	}
	return issues;
}

function countCashtags(text: string): number {
	const found = text.match(/\$[A-Za-z]{1,6}\b/g) || [];
	return new Set(found.map((t) => t.toUpperCase())).size;
}

// --- PKCE helpers (Web/Workers-compatible, no node:crypto) ---

function base64Url(bytes: Uint8Array): string {
	let bin = '';
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateCodeVerifier(): string {
	const bytes = new Uint8Array(32);
	globalThis.crypto.getRandomValues(bytes);
	return base64Url(bytes);
}

export async function codeChallenge(verifier: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(verifier)
	);
	return base64Url(new Uint8Array(digest));
}

// --- OAuth helpers ---

export function xAuthorizeUrl(
	clientId: string,
	appUrl: string,
	state: string,
	challenge: string
): string {
	const redirect = `${appUrl.replace(/\/$/, '')}/api/connections/x/callback`;
	const params = new URLSearchParams({
		response_type: 'code',
		client_id: clientId,
		redirect_uri: redirect,
		scope: X_SCOPES.join(' '),
		state,
		code_challenge: challenge,
		code_challenge_method: 'S256'
	});
	return `${X_AUTHORIZE_URL}?${params.toString()}`;
}

function basicHeader(clientId: string, clientSecret: string | undefined): Record<string, string> {
	if (!clientSecret) return {};
	// Standard base64 (not url-safe) for the Authorization header.
	const bin = `${clientId}:${clientSecret}`;
	const bytes = new TextEncoder().encode(bin);
	let raw = '';
	for (let i = 0; i < bytes.length; i++) raw += String.fromCharCode(bytes[i]);
	return { Authorization: `Basic ${btoa(raw)}` };
}

type XTokenResponse = {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	scope?: string;
	token_type?: string;
};

async function requestToken(
	body: URLSearchParams,
	clientSecret: string | undefined,
	clientId: string,
	fetchImpl: FetchLike
): Promise<XTokenResponse> {
	const res = await fetchImpl(`${X_API}/2/oauth2/token`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			...basicHeader(clientId, clientSecret)
		},
		body
	});
	if (!res.ok) {
		throw Object.assign(
			new Error(`X token request failed (${res.status}): ${(await res.text()).slice(0, 300)}`),
			{ status: res.status }
		);
	}
	return (await res.json()) as XTokenResponse;
}

type XMe = {
	data?: {
		id?: string;
		username?: string;
		name?: string;
		profile_image_url?: string;
	};
};

async function fetchMe(
	accessToken: string,
	fetchImpl: FetchLike
): Promise<{ id: string; username?: string; name?: string; avatarUrl?: string }> {
	const res = await fetchImpl(`${X_API}/2/users/me?user.fields=profile_image_url,verified`, {
		headers: { Authorization: `Bearer ${accessToken}` }
	});
	if (!res.ok) {
		throw Object.assign(
			new Error(`X profile lookup failed (${res.status}): ${(await res.text()).slice(0, 300)}`),
			{ status: res.status }
		);
	}
	const me = ((await res.json()) as XMe).data ?? {};
	if (!me.id) throw new Error('X profile lookup returned no user id');
	return { id: me.id, username: me.username, name: me.name, avatarUrl: me.profile_image_url };
}

export async function xExchangeCode(
	args: {
		clientId: string;
		clientSecret?: string;
		code: string;
		codeVerifier: string;
		appUrl: string;
	},
	fetchImpl: FetchLike = providerFetch
): Promise<ConnectionCredentials & ConnectionMeta> {
	if (!args.codeVerifier) throw new Error('X connect session expired — try connecting again');
	const redirect = `${args.appUrl.replace(/\/$/, '')}/api/connections/x/callback`;
	const body = new URLSearchParams({
		grant_type: 'authorization_code',
		code: args.code,
		redirect_uri: redirect,
		code_verifier: args.codeVerifier,
		client_id: args.clientId
	});
	const tok = await requestToken(body, args.clientSecret, args.clientId, fetchImpl);
	if (!tok.access_token) throw new Error('X token exchange returned no access token');
	if (!tok.refresh_token) {
		throw new Error('X issued no refresh token (offline.access scope required) — reconnect');
	}
	const me = await fetchMe(tok.access_token, fetchImpl);
	const handle = me.username ? `@${me.username}` : undefined;
	return {
		accessToken: tok.access_token,
		refreshToken: tok.refresh_token,
		expiresAt: tok.expires_in ? Date.now() + tok.expires_in * 1000 : undefined,
		tokenType: tok.token_type || 'Bearer',
		scopes: tok.scope ? tok.scope.split(' ') : [...X_SCOPES],
		clientId: args.clientId,
		...(args.clientSecret ? { clientSecret: args.clientSecret } : {}),
		xUserId: me.id,
		xUsername: me.username,
		handle,
		displayName: me.name || handle || 'X',
		avatarUrl: me.avatarUrl,
		maxCharacters: X_MAX_CHARS
	};
}

export async function xVerify(
	creds: ConnectionCredentials,
	fetchImpl: FetchLike = providerFetch
): Promise<{ displayName?: string; avatarUrl?: string; handle?: string }> {
	if (!creds.accessToken) throw new Error('Missing accessToken');
	const me = await fetchMe(creds.accessToken, fetchImpl);
	const handle = me.username ? `@${me.username}` : undefined;
	return { displayName: me.name || handle, avatarUrl: me.avatarUrl, handle };
}

/**
 * The oauth_pending row stores clientSecretEnc for the app secret, but X's
 * PKCE flow also needs the per-attempt code_verifier at callback time.
 * Pack both into that column as JSON (no schema migration, no wider blast
 * radius). Unpacks old plain-secret rows as secret-only so a callback that
 * races a deploy still fails with a clear "reconnect" message.
 */
export function packXPendingSecret(clientSecret: string, codeVerifier: string): string {
	return JSON.stringify({ v: 1, secret: clientSecret, verifier: codeVerifier });
}

export function unpackXPendingSecret(decrypted: string): {
	clientSecret: string;
	codeVerifier?: string;
} {
	try {
		const parsed = JSON.parse(decrypted) as { v?: number; secret?: string; verifier?: string };
		if (parsed && typeof parsed.secret === 'string') {
			return { clientSecret: parsed.secret, codeVerifier: parsed.verifier };
		}
	} catch {
		// Not JSON: legacy plain-secret row.
	}
	return { clientSecret: decrypted };
}

// --- Media upload (v2 chunked) ---

async function loadBytes(m: MediaAttachment): Promise<Uint8Array> {
	if (m.bytes) return m.bytes;
	throw new Error('Media requires bytes');
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function processingState(payload: unknown): {
	state?: string;
	checkAfterSecs?: number;
	error?: { message?: string };
} {
	const root = (payload ?? {}) as Record<string, unknown>;
	const data = (root.data ?? root) as Record<string, unknown>;
	const info = (data.processing_info ?? {}) as Record<string, unknown>;
	return {
		state: typeof info.state === 'string' ? info.state : undefined,
		checkAfterSecs: typeof info.check_after_secs === 'number' ? info.check_after_secs : undefined,
		error: (info.error ?? undefined) as { message?: string } | undefined
	};
}

async function uploadOneMedia(
	token: string,
	m: MediaAttachment,
	fetchImpl: FetchLike
): Promise<string> {
	const bytes = await loadBytes(m);
	const mediaType = (m.mime || 'image/jpeg').toLowerCase().split(';')[0].trim();
	const mediaCategory = isGif(m) ? 'tweet_gif' : 'tweet_image';

	const initRes = await fetchImpl(`${X_API}/2/media/upload/initialize`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			media_type: mediaType,
			total_bytes: bytes.length,
			media_category: mediaCategory
		})
	});
	if (!initRes.ok) {
		throw Object.assign(
			new Error(`X media init failed (${initRes.status}): ${(await initRes.text()).slice(0, 300)}`),
			{ status: initRes.status }
		);
	}
	const initData = (await initRes.json()) as { data?: { id?: string }; id?: string };
	const mediaId = initData.data?.id ?? initData.id;
	if (!mediaId) throw new Error('X media init returned no media id');

	const totalChunks = Math.max(1, Math.ceil(bytes.length / X_UPLOAD_CHUNK_BYTES));
	for (let i = 0; i < totalChunks; i++) {
		const slice = bytes.slice(i * X_UPLOAD_CHUNK_BYTES, (i + 1) * X_UPLOAD_CHUNK_BYTES);
		const form = new FormData();
		form.append('segment_index', String(i));
		form.append('media', new Blob([slice as BlobPart], { type: mediaType }), 'upload');
		const appRes = await fetchImpl(`${X_API}/2/media/upload/${mediaId}/append`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}` },
			body: form
		});
		if (!appRes.ok) {
			throw Object.assign(
				new Error(
					`X media upload failed (${appRes.status}): ${(await appRes.text()).slice(0, 300)}`
				),
				{ status: appRes.status }
			);
		}
	}

	const finRes = await fetchImpl(`${X_API}/2/media/upload/${mediaId}/finalize`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!finRes.ok) {
		throw Object.assign(
			new Error(
				`X media finalize failed (${finRes.status}): ${(await finRes.text()).slice(0, 300)}`
			),
			{ status: finRes.status }
		);
	}
	const finJson = (await finRes.json().catch(() => ({}))) as unknown;
	let proc = processingState(finJson);
	for (let attempt = 0; attempt < X_MEDIA_POLL_ATTEMPTS; attempt++) {
		if (!proc.state || proc.state === 'succeeded') break;
		if (proc.state === 'failed') {
			throw new Error(
				`X media processing failed${proc.error?.message ? `: ${proc.error.message}` : ''}`
			);
		}
		await sleep(Math.min((proc.checkAfterSecs ?? 1) * 1000, X_MEDIA_POLL_MAX_WAIT_MS));
		const stRes = await fetchImpl(
			`${X_API}/2/media/upload?command=STATUS&media_id=${encodeURIComponent(mediaId)}`,
			{ headers: { Authorization: `Bearer ${token}` } }
		);
		if (!stRes.ok) {
			throw Object.assign(
				new Error(`X media status failed (${stRes.status}): ${(await stRes.text()).slice(0, 300)}`),
				{ status: stRes.status }
			);
		}
		proc = processingState(await stRes.json().catch(() => ({})));
	}
	if (proc.state && proc.state !== 'succeeded') {
		throw new Error('X media is still processing — try again in a minute');
	}

	// Alt text is best-effort: it must never fail the post.
	if (m.alt?.trim()) {
		const alt = m.alt.trim().slice(0, 1000);
		for (const shape of [
			{ media_id: mediaId, alt_text: { text: alt } },
			{ id: mediaId, alt_text: { text: alt } }
		]) {
			try {
				const metaRes = await fetchImpl(`${X_API}/2/media/metadata`, {
					method: 'POST',
					headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
					body: JSON.stringify(shape)
				});
				if (metaRes.ok) break;
			} catch {
				break;
			}
		}
	}

	return mediaId;
}

// --- Provider ---

export const xProvider: PlatformProvider = {
	id: 'x',
	capabilities: {
		maxImages: X_MAX_IMAGES,
		maxImageBytes: X_MAX_IMAGE_BYTES,
		supportsCW: false,
		supportsVisibility: false,
		supportsThreads: true
	},

	validate(content: NormalizedPost): ValidationIssue[] {
		const issues: ValidationIssue[] = [];
		const segments = content.thread && content.thread.length > 0 ? content.thread : [content];
		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i];
			const segMedia = seg.media ?? [];
			const hasMedia = segMedia.length > 0;
			if (!seg.text?.trim() && !hasMedia) {
				issues.push({
					field: `thread[${i}]`,
					message: 'Segment needs text or media',
					code: 'empty'
				});
			}
			const check = validateXText(seg.text || '', X_MAX_CHARS);
			if (!check.ok) {
				issues.push({
					field: `thread[${i}].text`,
					message: check.message || 'Text too long',
					code: 'max_length'
				});
			}
			for (const mi of validateSegmentMedia(segMedia)) {
				issues.push({ ...mi, field: `thread[${i}].${mi.field ?? 'media'}` });
			}
			if (countCashtags(seg.text || '') > 1) {
				issues.push({
					field: `thread[${i}].text`,
					message: 'X allows max 1 cashtag (e.g. $AAPL) per post',
					code: 'max_cashtags'
				});
			}
		}
		return issues;
	},

	async publish(content, creds, meta, fetchImpl = providerFetch, opts): Promise<PublishResult> {
		if (!creds.accessToken)
			throw new ProviderError('X credentials require accessToken (reconnect)', { code: 'auth' });
		xUserId(creds, meta);
		const username = xUsername(creds, meta);
		const token = creds.accessToken;
		const segments = content.thread && content.thread.length > 0 ? content.thread : [content];
		const resumeIds = opts?.resume?.segmentIds ?? [];
		const startAt = Math.min(resumeIds.length, segments.length);
		const segmentIds = resumeIds.slice(0, startAt);
		let replyTo = segmentIds.at(-1);
		let firstUrl = opts?.resume?.remoteUrl || undefined;

		for (let i = startAt; i < segments.length; i++) {
			try {
				const seg = segments[i];
				const segMedia = (seg.media ?? []).slice(0, X_MAX_IMAGES);
				for (const m of segMedia) {
					if (isVideo(m)) throw new Error('X video is not supported yet — post it to LinkedIn');
				}
				const text = (seg.text || '').trim();
				if (!text && segMedia.length === 0) throw new Error('Segment needs text or media');

				const mediaIds: string[] = [];
				for (const m of segMedia) {
					mediaIds.push(await uploadOneMedia(token, m, fetchImpl));
				}

				const body: Record<string, unknown> = {};
				if (text) body.text = text;
				if (mediaIds.length) body.media = { media_ids: mediaIds };
				if (replyTo) body.reply = { in_reply_to_tweet_id: replyTo };

				let res: Response;
				try {
					res = await fetchImpl(`${X_API}/2/tweets`, {
						method: 'POST',
						headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
						body: JSON.stringify(body)
					});
				} catch (err) {
					throw unconfirmedPostError('X', err);
				}
				if (!res.ok) {
					throw Object.assign(
						new Error(`X post failed (${res.status}): ${(await res.text()).slice(0, 300)}`),
						{ status: res.status }
					);
				}
				// A 2xx is a posted tweet even when its body cannot be read: retrying
				// it for want of an id would post it twice.
				const data = (await res.json().catch(() => ({}))) as { data?: { id?: unknown } };
				const id = typeof data.data?.id === 'string' ? data.data.id : '';
				segmentIds.push(id);
				if (id && !firstUrl) firstUrl = xPostUrl(id, username) ?? undefined;
				await opts?.checkpoint?.({
					segmentIds: [...segmentIds],
					remoteUrl: firstUrl ?? opts?.resume?.remoteUrl ?? null
				});
				if (id) {
					replyTo = id;
				} else if (i < segments.length - 1) {
					// A reply needs the parent's id: stop here with what was posted,
					// so the retry resumes after this segment rather than reposting.
					throw new PublishPartialError(
						'X accepted the post but returned no id — the rest of the thread cannot be linked',
						{
							segmentIds: [...segmentIds],
							remoteUrl: firstUrl ?? opts?.resume?.remoteUrl ?? null
						}
					);
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (segmentIds.length) {
					throw new PublishPartialError(message, {
						segmentIds,
						remoteUrl: firstUrl ?? opts?.resume?.remoteUrl ?? null
					});
				}
				throw err;
			}
			if (i < segments.length - 1) await sleep(300);
		}

		return {
			remotePostId: segmentIds[0] || undefined,
			remoteUrl: firstUrl,
			segmentIds
		};
	},

	refreshImpossibleReason(creds): string | null {
		if (creds.refreshToken && creds.clientId) return null;
		// Without refresh material the token still works until it runs out, so
		// only a token that has actually expired makes a publish pointless.
		if (!creds.expiresAt || creds.expiresAt > Date.now()) return null;
		return 'X token expired and cannot be refreshed (incomplete credentials) — reconnect';
	},

	async refreshIfNeeded(creds, fetchImpl = providerFetch): Promise<ConnectionCredentials> {
		if (!creds.refreshToken) return creds;
		if (creds.expiresAt && creds.expiresAt - Date.now() > REFRESH_SKEW_MS) return creds;
		if (!creds.clientId) return creds;
		const body = new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: creds.refreshToken,
			client_id: creds.clientId
		});
		let tok: XTokenResponse;
		try {
			tok = await requestToken(body, creds.clientSecret, creds.clientId, fetchImpl);
		} catch (err) {
			const status = (err as { status?: number } | null)?.status;
			if (status === 400 || status === 401 || status === 403) {
				throw new ProviderError(`X token refresh rejected (${status}) — reconnect`, {
					status: 401,
					code: 'auth'
				});
			}
			return creds;
		}
		if (!tok.access_token) {
			throw new ProviderError('X token refresh returned no token — reconnect', {
				status: 401,
				code: 'auth'
			});
		}
		return {
			...creds,
			accessToken: tok.access_token,
			refreshToken: tok.refresh_token || creds.refreshToken,
			expiresAt: tok.expires_in ? Date.now() + tok.expires_in * 1000 : creds.expiresAt,
			scopes: tok.scope ? tok.scope.split(' ') : creds.scopes
		};
	}
};

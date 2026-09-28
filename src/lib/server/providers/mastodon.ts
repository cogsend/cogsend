import { isBlockedInstanceHost } from '$lib/domain/instance-host';
import { validatePollConfig } from '$lib/domain/poll';
import { validateMastodonText } from '$lib/domain/validation/text';
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
import { ProviderError, PublishPartialError } from './types';
import { providerFetch } from './timed-fetch';

function normalizeInstance(url: string, allowLocal: boolean): string {
	let u = url.trim();
	if (!u.startsWith('http://') && !u.startsWith('https://')) u = `https://${u}`;
	const parsed = new URL(u);
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		throw new Error('Instance URL must be http(s)');
	}
	// Credentials travel as bearer tokens: never allow cleartext http outside
	// explicitly local development.
	if (!allowLocal && parsed.protocol !== 'https:') {
		throw new Error('Instance URL must use https');
	}
	if (isBlockedInstanceHost(parsed.hostname, { allowLocal })) {
		throw new Error('Instance host not allowed');
	}
	return `${parsed.protocol}//${parsed.host}`.replace(/\/$/, '');
}

export function sanitizeMastodonInstanceUrl(url: string, allowLocal = false): string {
	return normalizeInstance(url, allowLocal);
}
/** Redirect answers are followed by hand so every hop is re-checked:
 *  `redirect: 'follow'` would let an instance that passed the hostname check
 *  bounce a token-bearing request to an internal address the check never saw.
 *  Cross-origin hops drop the Authorization header (the Fetch spec does the
 *  same), and a 303 — or a 301/302 answering a POST — becomes a GET. */
const MAX_INSTANCE_REDIRECTS = 5;

function guardRedirects(fetchImpl: FetchLike, allowLocal: boolean): FetchLike {
	return async (input, init) => {
		// Every Mastodon call builds a URL string. A Request carries its own
		// method/body, so leave one with the platform's own redirect handling.
		if (typeof input !== 'string' && !(input instanceof URL)) return fetchImpl(input, init);
		let current = typeof input === 'string' ? input : input.toString();
		let method = (init?.method ?? 'GET').toUpperCase();
		let body = init?.body;
		const headers = new Headers(init?.headers);
		for (let hop = 0; hop <= MAX_INSTANCE_REDIRECTS; hop++) {
			const res = await fetchImpl(current, {
				...init,
				method,
				body,
				headers,
				redirect: 'manual'
			});
			const isRedirect =
				res.status === 301 ||
				res.status === 302 ||
				res.status === 303 ||
				res.status === 307 ||
				res.status === 308;
			if (!isRedirect) return res;
			if (res.body) await res.body.cancel().catch(() => {});
			if (hop === MAX_INSTANCE_REDIRECTS) break;
			const location = res.headers.get('location');
			if (!location) throw new Error('Mastodon redirect without location');
			let next: URL;
			try {
				next = new URL(location, current);
			} catch {
				throw new Error('Mastodon redirect is not a valid URL');
			}
			if (next.protocol !== 'https:' && !(allowLocal && next.protocol === 'http:')) {
				throw new Error('Instance host not allowed');
			}
			if (isBlockedInstanceHost(next.hostname, { allowLocal })) {
				throw new Error('Instance host not allowed');
			}
			if (next.origin !== new URL(current).origin) headers.delete('authorization');
			current = next.toString();
			if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
				if (method !== 'GET' && method !== 'HEAD') body = undefined;
				method = 'GET';
			}
		}
		throw new Error('Mastodon redirect limit exceeded');
	};
}

function loadMediaBytes(media: MediaAttachment): Uint8Array {
	if (media.bytes) return media.bytes;
	throw new Error('Media requires bytes or storageKey');
}

// POST /api/v2/media answers 202 while the full-size file is still processing
// (url is null until done), and a status referencing such an id fails
// upstream. GET /api/v1/media/:id reports 206 while processing and 200 once
// usable, so poll instead of burning an attempt and a retry on "media not
// processed".
const MEDIA_PROCESS_POLL_ATTEMPTS = 10;
const MEDIA_PROCESS_POLL_MS = 2000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function uploadMedia(
	instanceUrl: string,
	token: string,
	media: MediaAttachment,
	fetchImpl: FetchLike
): Promise<string> {
	const bytes = loadMediaBytes(media);
	const form = new FormData();
	form.append('file', new Blob([bytes as BlobPart], { type: media.mime }), 'upload');
	if (media.alt) form.append('description', media.alt);
	const res = await fetchImpl(`${instanceUrl}/api/v2/media`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}` },
		body: form
	});
	if (!res.ok) {
		throw Object.assign(
			new Error(
				`Mastodon media upload failed (${res.status}): ${(await res.text()).slice(0, 300)}`
			),
			{ status: res.status }
		);
	}
	const data = (await res.json()) as { id: string };
	if (res.status !== 202) return data.id;
	// 202: the full-size file is still processing; wait until it is usable.
	await waitForMastodonMedia(instanceUrl, token, data.id, fetchImpl);
	return data.id;
}

/**
 * Wait for an asynchronously processed media attachment to become usable.
 * `GET /api/v1/media/:id` answers 206 while processing and 200 once ready, and
 * a status created in between fails upstream — polling here trades a short
 * wait for a burned attempt and a user-visible failure.
 */
export async function waitForMastodonMedia(
	instanceUrl: string,
	token: string,
	mediaId: string,
	fetchImpl: FetchLike,
	opts: { attempts?: number; delayMs?: number } = {}
): Promise<void> {
	const attempts = opts.attempts ?? MEDIA_PROCESS_POLL_ATTEMPTS;
	const delayMs = opts.delayMs ?? MEDIA_PROCESS_POLL_MS;
	for (let attempt = 0; attempt < attempts; attempt++) {
		await sleep(delayMs);
		const poll = await fetchImpl(`${instanceUrl}/api/v1/media/${encodeURIComponent(mediaId)}`, {
			headers: { Authorization: `Bearer ${token}` }
		});
		if (poll.status === 200) return;
		if (poll.status === 206) continue;
		if (!poll.ok) {
			throw Object.assign(
				new Error(
					`Mastodon media processing failed (${poll.status}): ${(await poll.text()).slice(0, 300)}`
				),
				{ status: poll.status }
			);
		}
		return;
	}
	throw new Error('Mastodon is still processing the uploaded image — retry in a moment');
}

async function postStatus(
	instanceUrl: string,
	token: string,
	params: {
		status: string;
		media_ids?: string[];
		in_reply_to_id?: string;
		visibility?: string;
		spoiler_text?: string;
		poll?: { options: string[]; expires_in: number; multiple?: boolean; hide_totals?: boolean };
	},
	fetchImpl: FetchLike,
	idempotencyKey?: string
): Promise<{ id?: string; url?: string }> {
	const res = await fetchImpl(`${instanceUrl}/api/v1/statuses`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			// Mastodon deduplicates statuses by this header for an hour, so a
			// retry after a lost response returns the original status instead of
			// posting the same text twice.
			...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
		},
		body: JSON.stringify(params)
	});
	if (!res.ok) {
		throw Object.assign(
			new Error(
				`Mastodon status create failed (${res.status}): ${(await res.text()).slice(0, 300)}`
			),
			{ status: res.status }
		);
	}
	return (await res.json()) as { id: string; url: string };
}

export const mastodonProvider: PlatformProvider = {
	id: 'mastodon',
	capabilities: {
		maxImages: 4,
		maxImageBytes: 16_000_000,
		supportsCW: true,
		supportsVisibility: true,
		supportsThreads: true
	},

	validate(content: NormalizedPost, meta?: ConnectionMeta): ValidationIssue[] {
		const issues: ValidationIssue[] = [];
		const max = meta?.maxCharacters ?? 500;
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
			// The instance counts the content warning toward the limit too, so a
			// post that fits the body alone can still be refused at publish.
			const check = validateMastodonText(
				[seg.options?.spoilerText, seg.text].filter(Boolean).join('\n'),
				max
			);
			if (!check.ok) {
				issues.push({
					field: `thread[${i}].text`,
					message: check.message || 'Text too long',
					code: 'max_length'
				});
			}
			if ((seg.media?.length ?? 0) > 4) {
				issues.push({
					field: `thread[${i}].media`,
					message: 'Mastodon allows max 4 images',
					code: 'max_images'
				});
			}
			for (const m of seg.media ?? []) {
				if ((m.mime || '').toLowerCase().startsWith('video/')) {
					issues.push({
						field: `thread[${i}].media`,
						message: 'Mastodon video is not supported yet — post it to LinkedIn',
						code: 'no_video'
					});
				} else if (mediaByteLength(m) > 16_000_000) {
					issues.push({
						field: `thread[${i}].media`,
						message: 'Mastodon allows max 16MB per image',
						code: 'max_image_bytes'
					});
				}
			}
			// Polls ride on the first post only; every segment shares options.
			if (i === 0 && seg.options?.poll) {
				const poll = validatePollConfig(seg.options.poll);
				if (!poll.ok) {
					issues.push({
						field: `thread[${i}].poll`,
						message: poll.error,
						code: 'invalid_poll'
					});
				} else if (hasMedia) {
					issues.push({
						field: `thread[${i}].poll`,
						message: 'Mastodon polls cannot be combined with images',
						code: 'poll_with_media'
					});
				}
			}
		}
		return issues;
	},

	async publish(content, creds, _meta, fetchImpl = providerFetch, opts): Promise<PublishResult> {
		if (!creds.accessToken || !creds.instanceUrl) {
			throw new ProviderError('Mastodon credentials require accessToken and instanceUrl', {
				code: 'auth'
			});
		}
		// The caller decides (publish.ts passes APP_URL locality). Defaulting to
		// false keeps SSRF blocking on: never assume "local is fine".
		const allowLocal = opts?.allowLocalHosts ?? false;
		const instanceUrl = normalizeInstance(creds.instanceUrl, allowLocal);
		const guarded = guardRedirects(fetchImpl, allowLocal);
		const segments = content.thread && content.thread.length > 0 ? content.thread : [content];
		const resumeIds = opts?.resume?.segmentIds ?? [];
		const startAt = Math.min(resumeIds.length, segments.length);
		const segmentIds = resumeIds.slice(0, startAt);
		let replyTo = segmentIds.at(-1);
		let firstUrl = opts?.resume?.remoteUrl || undefined;

		for (let i = startAt; i < segments.length; i++) {
			try {
				const seg = segments[i];
				const mediaIds: string[] = [];
				for (const m of (seg.media ?? []).slice(0, 4)) {
					if ((m.mime || '').toLowerCase().startsWith('video/')) {
						throw new Error('Mastodon video is not supported yet — post it to LinkedIn');
					}
					mediaIds.push(await uploadMedia(instanceUrl, creds.accessToken, m, guarded));
				}
				const pollOptions = i === 0 ? (seg.options?.poll ?? content.options?.poll) : undefined;
				const pollCheck = pollOptions ? validatePollConfig(pollOptions) : null;
				if (pollOptions && !pollCheck?.ok) {
					throw new Error(pollCheck?.error ?? 'Invalid poll');
				}
				const result = await postStatus(
					instanceUrl,
					creds.accessToken,
					{
						status: seg.text || '',
						media_ids: mediaIds.length ? mediaIds : undefined,
						in_reply_to_id: replyTo,
						visibility: seg.options?.visibility || content.options?.visibility || 'public',
						spoiler_text: seg.options?.spoilerText || content.options?.spoilerText || undefined,
						poll: pollCheck?.ok
							? {
									options: pollCheck.config.options,
									expires_in: pollCheck.config.expiresIn,
									multiple: pollCheck.config.multiple,
									hide_totals: pollCheck.config.hideTotals
								}
							: undefined
					},
					guarded,
					opts?.idempotencyKey?.(i)
				);
				// The count matters even when the id is missing: the checkpoint is
				// what stops a retry from reposting a segment.
				segmentIds.push(result.id ?? '');
				if (!firstUrl) firstUrl = result.url;
				await opts?.checkpoint?.({
					segmentIds: [...segmentIds],
					remoteUrl: firstUrl ?? opts?.resume?.remoteUrl ?? null
				});
				if (result.id) {
					replyTo = result.id;
				} else if (i < segments.length - 1) {
					// A reply needs the parent's id: stop here with what was posted,
					// so the retry resumes after this segment rather than reposting.
					throw new PublishPartialError(
						'Mastodon accepted the status but returned no id — the rest of the thread cannot be linked',
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
			if (i < segments.length - 1) await new Promise((r) => setTimeout(r, 50));
		}

		return {
			remotePostId: segmentIds[0] || undefined,
			remoteUrl: firstUrl || undefined,
			segmentIds
		};
	}
};

export async function mastodonRegisterApp(
	instanceUrl: string,
	appUrl: string,
	fetchImpl: FetchLike = providerFetch,
	allowLocal = false
): Promise<{ clientId: string; clientSecret: string; instanceUrl: string }> {
	const base = normalizeInstance(instanceUrl, allowLocal);
	const guarded = guardRedirects(fetchImpl, allowLocal);
	const res = await guarded(`${base}/api/v1/apps`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			client_name: 'CogSend',
			redirect_uris: `${appUrl.replace(/\/$/, '')}/api/connections/mastodon/callback`,
			scopes: 'read write:statuses write:media',
			website: appUrl
		})
	});
	if (!res.ok) {
		throw Object.assign(
			new Error(
				`Mastodon app register failed (${res.status}): ${(await res.text()).slice(0, 300)}`
			),
			{ status: res.status }
		);
	}
	const data = (await res.json()) as { client_id: string; client_secret: string };
	return { clientId: data.client_id, clientSecret: data.client_secret, instanceUrl: base };
}

/**
 * `verify_credentials` with the same host check, redirect guard and timeout
 * as publishing: the request carries the account's token, and a stored
 * instance that redirects must not be able to hand it to another host. The
 * caller reads the status (401/403 means the token is gone).
 */
export async function mastodonVerifyCredentials(
	instanceUrl: string,
	accessToken: string,
	fetchImpl: FetchLike = providerFetch,
	allowLocal = false
): Promise<Response> {
	const base = normalizeInstance(instanceUrl, allowLocal);
	return guardRedirects(fetchImpl, allowLocal)(`${base}/api/v1/accounts/verify_credentials`, {
		headers: { Authorization: `Bearer ${accessToken}` }
	});
}

export function mastodonAuthorizeUrl(
	instanceUrl: string,
	clientId: string,
	appUrl: string,
	state: string,
	allowLocal = false
): string {
	const base = normalizeInstance(instanceUrl, allowLocal);
	const redirect = `${appUrl.replace(/\/$/, '')}/api/connections/mastodon/callback`;
	const params = new URLSearchParams({
		client_id: clientId,
		scope: 'read write:statuses write:media',
		redirect_uri: redirect,
		response_type: 'code',
		state
	});
	return `${base}/oauth/authorize?${params.toString()}`;
}

export async function mastodonExchangeCode(
	instanceUrl: string,
	clientId: string,
	clientSecret: string,
	code: string,
	appUrl: string,
	fetchImpl: FetchLike = providerFetch,
	allowLocal = false
): Promise<ConnectionCredentials & ConnectionMeta> {
	const base = normalizeInstance(instanceUrl, allowLocal);
	const redirect = `${appUrl.replace(/\/$/, '')}/api/connections/mastodon/callback`;
	const guarded = guardRedirects(fetchImpl, allowLocal);
	const body = new URLSearchParams({
		grant_type: 'authorization_code',
		code,
		client_id: clientId,
		client_secret: clientSecret,
		redirect_uri: redirect,
		scope: 'read write:statuses write:media'
	});
	const res = await guarded(`${base}/oauth/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body
	});
	if (!res.ok) {
		throw Object.assign(
			new Error(
				`Mastodon token exchange failed (${res.status}): ${(await res.text()).slice(0, 300)}`
			),
			{ status: res.status }
		);
	}
	const token = (await res.json()) as { access_token: string };

	const meRes = await guarded(`${base}/api/v1/accounts/verify_credentials`, {
		headers: { Authorization: `Bearer ${token.access_token}` }
	});
	if (!meRes.ok)
		throw Object.assign(new Error(`Mastodon verify_credentials failed (${meRes.status})`), {
			status: meRes.status
		});
	const me = (await meRes.json()) as {
		username: string;
		display_name: string;
		avatar: string;
		acct: string;
	};

	let maxCharacters = 500;
	try {
		const inst = await guarded(`${base}/api/v2/instance`);
		if (inst.ok) {
			const info = (await inst.json()) as {
				configuration?: { statuses?: { max_characters?: number } };
			};
			maxCharacters = info.configuration?.statuses?.max_characters ?? 500;
		}
	} catch {
		/* fallback 500 */
	}

	return {
		accessToken: token.access_token,
		clientId,
		clientSecret,
		instanceUrl: base,
		handle: me.acct || me.username,
		displayName: me.display_name || me.username,
		avatarUrl: me.avatar,
		maxCharacters
	};
}

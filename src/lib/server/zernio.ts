import { ZERNIO_API_BASE } from '#lib/domain/zernio.js';
import { ProviderError, type FetchLike } from './providers/types';
import { providerFetch } from './providers/timed-fetch';

export interface ZernioProfile {
	_id: string;
	name: string;
	isDefault?: boolean;
}

export interface ZernioAccount {
	_id: string;
	platform: string;
	profileId: string | { _id: string; name?: string };
	username?: string;
	displayName?: string;
	profilePicture?: string | null;
	profileUrl?: string;
	isActive?: boolean;
	needsReconnection?: boolean;
	enabled?: boolean;
}

export interface ZernioPlatformEntry {
	platform: string;
	accountId: string | { _id: string };
	status?: string;
	platformPostId?: string;
	platformPostUrl?: string;
	errorMessage?: string;
	errorCategory?: string;
}

export interface ZernioPost {
	_id: string;
	status?: string;
	metadata?: { cogsendRequestId?: string };
	platforms?: ZernioPlatformEntry[];
}

export function zernioProfileId(account: ZernioAccount): string {
	return typeof account.profileId === 'string' ? account.profileId : account.profileId._id;
}

export function zernioEntryAccountId(entry: ZernioPlatformEntry): string {
	return typeof entry.accountId === 'string' ? entry.accountId : entry.accountId._id;
}

function apiMessageFrom(body: string): string | null {
	try {
		const parsed = JSON.parse(body) as { error?: unknown };
		return typeof parsed.error === 'string' && parsed.error ? parsed.error : null;
	} catch {
		return null;
	}
}

function apiCodeFrom(body: string): string | null {
	try {
		const parsed = JSON.parse(body) as { code?: unknown };
		return typeof parsed.code === 'string' ? parsed.code : null;
	} catch {
		return null;
	}
}

/** Zernio no longer holds a live token for the account: reconnecting it there is the fix. */
export function isZernioAccountDead(account: {
	needsReconnection?: boolean;
	isActive?: boolean;
}): boolean {
	return account.needsReconnection === true || account.isActive === false;
}

/**
 * 401 is the key: expire the connection. 429 and 5xx come back later. Every
 * other 4xx (validation, the billing gate, a missing permission, the 24-hour
 * duplicate rejection) is a refusal the same request cannot get past, so it is
 * non-retryable without expiring the connection: `forbidden` is the code that
 * carries exactly that pair of decisions through publish.ts.
 */
export function zernioHttpError(prefix: string, status: number, body: string): ProviderError {
	const reason = apiMessageFrom(body) ?? body.slice(0, 300);
	const detail = body.slice(0, 2000);
	if (status === 401) {
		return new ProviderError(`Zernio ${prefix} failed (401): ${reason}`, {
			status,
			code: 'auth',
			detail
		});
	}
	if (status === 429) {
		return new ProviderError(`Zernio ${prefix} failed (429): ${reason}`, {
			status,
			code: 'rate_limited',
			detail
		});
	}
	if (status >= 500) {
		return new ProviderError(`Zernio ${prefix} failed (${status}): ${reason}`, {
			status,
			code: 'upstream',
			detail
		});
	}
	// These two get their own sentences: humanizeError turns "already scheduled"
	// (Zernio's 409 wording) into CogSend's own schedule clash and "403" into a
	// platform policy refusal, both of which send the reader somewhere wrong.
	if (status === 409) {
		return new ProviderError(
			'Zernio refused a duplicate: the same content was posted to this account in the last 24 hours',
			{ status, code: 'forbidden', detail }
		);
	}
	if (status === 403) {
		const code = apiCodeFrom(body);
		if (code === 'ACCOUNT_DISCONNECTED') {
			return new ProviderError(`Zernio: ${reason}`, { status, code: 'auth', detail });
		}
		const keyProblem = code === 'insufficient_permissions' || /read-only/i.test(reason);
		return new ProviderError(
			keyProblem
				? `Zernio refused this request: ${reason}. The API key may be read-only or lack the publishing group`
				: `Zernio refused this request: ${reason}`,
			{ status, code: 'forbidden', detail }
		);
	}
	return new ProviderError(`Zernio ${prefix} failed (${status}): ${reason}`, {
		status,
		code: 'forbidden',
		detail
	});
}

/**
 * Zernio checks the key's write permission and its publishing group before it
 * reads the body, and a dryRun with no TikTok target is refused as a 400 after
 * those checks without creating anything. So the answer says whether this key
 * can publish: resolves for a usable key, throws the 401/403 for one that cannot.
 */
export async function probePublishAccess(opts: {
	apiKey: string;
	fetchImpl?: FetchLike;
}): Promise<void> {
	const fetchImpl = opts.fetchImpl ?? providerFetch;
	const res = await fetchImpl(`${ZERNIO_API_BASE}/v1/posts`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${opts.apiKey}`,
			Accept: 'application/json',
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ dryRun: true, platforms: [] })
	});
	if (res.status === 401 || res.status === 403) {
		throw zernioHttpError('publish check', res.status, await res.text());
	}
}

export function zernioApiMessage(err: unknown): string {
	if (err instanceof ProviderError && err.detail) {
		const own = apiMessageFrom(err.detail);
		if (own) return own;
	}
	return err instanceof Error ? err.message : String(err);
}

async function request<T>(opts: {
	apiKey: string;
	path: string;
	method?: 'GET' | 'POST';
	body?: unknown;
	headers?: Record<string, string>;
	prefix: string;
	fetchImpl?: FetchLike;
}): Promise<T> {
	const fetchImpl = opts.fetchImpl ?? providerFetch;
	const res = await fetchImpl(`${ZERNIO_API_BASE}${opts.path}`, {
		method: opts.method ?? 'GET',
		headers: {
			Authorization: `Bearer ${opts.apiKey}`,
			Accept: 'application/json',
			...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
			...(opts.headers ?? {})
		},
		...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) })
	});
	if (!res.ok) throw zernioHttpError(opts.prefix, res.status, await res.text());
	return (await res.json()) as T;
}

export async function listProfiles(opts: {
	apiKey: string;
	fetchImpl?: FetchLike;
}): Promise<ZernioProfile[]> {
	const data = await request<{ profiles?: ZernioProfile[] }>({
		...opts,
		path: '/v1/profiles',
		prefix: 'list profiles'
	});
	return data.profiles ?? [];
}

export async function listAccounts(opts: {
	apiKey: string;
	profileId?: string;
	platform?: string;
	fetchImpl?: FetchLike;
}): Promise<ZernioAccount[]> {
	// No page/limit: Zernio then answers with every account in one response,
	// and paginating would cap the page at 100.
	const params = new URLSearchParams();
	if (opts.profileId) params.set('profileId', opts.profileId);
	if (opts.platform) params.set('platform', opts.platform);
	const data = await request<{ accounts?: ZernioAccount[] }>({
		apiKey: opts.apiKey,
		fetchImpl: opts.fetchImpl,
		path: `/v1/accounts?${params}`,
		prefix: 'list accounts'
	});
	return data.accounts ?? [];
}

export async function connectUrl(opts: {
	apiKey: string;
	platform: string;
	profileId: string;
	redirectUrl: string;
	fetchImpl?: FetchLike;
}): Promise<string> {
	const params = new URLSearchParams({ profileId: opts.profileId, redirect_url: opts.redirectUrl });
	const data = await request<{ authUrl?: string }>({
		apiKey: opts.apiKey,
		fetchImpl: opts.fetchImpl,
		path: `/v1/connect/${encodeURIComponent(opts.platform)}?${params}`,
		prefix: 'connect'
	});
	if (!data.authUrl) throw new ProviderError('Zernio connect returned no authorization URL');
	return data.authUrl;
}

function unwrapPost(data: { post?: ZernioPost; postId?: string } | ZernioPost): ZernioPost {
	// An idempotent retry that lands while the first request is still saving
	// answers 202 with only the id; the poll reads the rest.
	if ('postId' in data && typeof data.postId === 'string' && data.postId) {
		return { _id: data.postId };
	}
	const post = 'post' in data && data.post ? data.post : (data as ZernioPost);
	if (!post || typeof post._id !== 'string') throw new ProviderError('Zernio returned no post');
	return post;
}

export async function createPost(opts: {
	apiKey: string;
	body: Record<string, unknown>;
	requestId: string;
	fetchImpl?: FetchLike;
}): Promise<ZernioPost> {
	return unwrapPost(
		await request({
			apiKey: opts.apiKey,
			fetchImpl: opts.fetchImpl,
			path: '/v1/posts',
			method: 'POST',
			body: opts.body,
			headers: { 'x-request-id': opts.requestId },
			prefix: 'create post'
		})
	);
}

export async function getPost(opts: {
	apiKey: string;
	postId: string;
	fetchImpl?: FetchLike;
}): Promise<ZernioPost> {
	return unwrapPost(
		await request({
			apiKey: opts.apiKey,
			fetchImpl: opts.fetchImpl,
			path: `/v1/posts/${encodeURIComponent(opts.postId)}`,
			prefix: 'read post'
		})
	);
}

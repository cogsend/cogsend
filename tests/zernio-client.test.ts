import { describe, expect, it } from 'vitest';
import {
	connectUrl,
	createPost,
	getPost,
	listAccounts,
	listProfiles,
	probePublishAccess,
	zernioApiMessage,
	zernioHttpError
} from '#lib/server/zernio.js';
import { humanizeError } from '#lib/domain/human-error.js';
import { ProviderError, type FetchLike } from '#lib/server/providers/types.js';

function mockFetch(
	handlers: Record<string, (req: Request) => Response | Promise<Response>>,
	seen: Request[] = []
): FetchLike {
	return async (input, init) => {
		const url =
			typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		const req = new Request(url, init);
		seen.push(req);
		for (const [key, handler] of Object.entries(handlers)) {
			if (url.includes(key)) return handler(req);
		}
		return new Response(`unmocked ${url}`, { status: 404 });
	};
}

describe('zernio client', () => {
	it('sends the key as a bearer token and unwraps list envelopes', async () => {
		const seen: Request[] = [];
		const fetchImpl = mockFetch(
			{
				'/v1/profiles': () => Response.json({ profiles: [{ _id: 'p1', name: 'Brand' }] }),
				'/v1/accounts?': () =>
					Response.json({ accounts: [{ _id: 'a1', platform: 'twitter', profileId: 'p1' }] })
			},
			seen
		);
		expect(await listProfiles({ apiKey: 'zk_1', fetchImpl })).toEqual([
			{ _id: 'p1', name: 'Brand' }
		]);
		const accounts = await listAccounts({
			apiKey: 'zk_1',
			profileId: 'p1',
			platform: 'twitter',
			fetchImpl
		});
		expect(accounts.map((a) => a._id)).toEqual(['a1']);
		expect(seen.every((r) => r.headers.get('authorization') === 'Bearer zk_1')).toBe(true);
		const accountsUrl = new URL(seen[1].url);
		expect(accountsUrl.searchParams.get('profileId')).toBe('p1');
		expect(accountsUrl.searchParams.get('platform')).toBe('twitter');
		// Zernio paginates only when page and limit arrive together, and caps
		// limit at 100; sending neither returns every account in one answer.
		expect(accountsUrl.searchParams.has('limit')).toBe(false);
		expect(accountsUrl.searchParams.has('page')).toBe(false);
	});

	it('asks for a connect URL with the redirect and returns Zernio’s authUrl', async () => {
		const seen: Request[] = [];
		const fetchImpl = mockFetch(
			{ '/v1/connect/twitter': () => Response.json({ authUrl: 'https://x.com/oauth?x=1' }) },
			seen
		);
		const url = await connectUrl({
			apiKey: 'zk_1',
			platform: 'twitter',
			profileId: 'p1',
			redirectUrl: 'https://cog.example/api/connections/zernio/callback?pending=abc.def',
			fetchImpl
		});
		expect(url).toBe('https://x.com/oauth?x=1');
		const asked = new URL(seen[0].url);
		expect(asked.searchParams.get('profileId')).toBe('p1');
		expect(asked.searchParams.get('redirect_url')).toBe(
			'https://cog.example/api/connections/zernio/callback?pending=abc.def'
		);
	});

	it('creates a post with the request id and reads one back', async () => {
		const seen: Request[] = [];
		const fetchImpl = mockFetch(
			{
				'/v1/posts/post-1': () => Response.json({ post: { _id: 'post-1', status: 'published' } }),
				'/v1/posts': () => Response.json({ post: { _id: 'post-1', status: 'publishing' } })
			},
			seen
		);
		const created = await createPost({
			apiKey: 'zk_1',
			body: { content: 'hi', platforms: [], publishNow: true },
			requestId: 'target-0',
			fetchImpl
		});
		expect(created._id).toBe('post-1');
		expect(seen[0].method).toBe('POST');
		expect(seen[0].headers.get('x-request-id')).toBe('target-0');
		expect(await seen[0].json()).toEqual({ content: 'hi', platforms: [], publishNow: true });
		expect((await getPost({ apiKey: 'zk_1', postId: 'post-1', fetchImpl })).status).toBe(
			'published'
		);
	});

	it('accepts a bare post object as well as a { post } envelope', async () => {
		const fetchImpl = mockFetch({
			'/v1/posts/bare': () => Response.json({ _id: 'bare', status: 'failed' })
		});
		expect((await getPost({ apiKey: 'zk_1', postId: 'bare', fetchImpl })).status).toBe('failed');
	});

	it('classifies HTTP failures so publish.ts can decide expiry and retry', () => {
		const body = JSON.stringify({ error: 'Invalid API key', type: 'authentication_error' });
		const auth = zernioHttpError('create post', 401, body);
		expect(auth).toBeInstanceOf(ProviderError);
		expect(auth.code).toBe('auth');
		expect(auth.retryable).toBe(false);
		expect(zernioHttpError('create post', 429, '{}').code).toBe('rate_limited');
		expect(zernioHttpError('create post', 503, 'down').code).toBe('upstream');
		expect(zernioHttpError('create post', 503, 'down').retryable).toBe(true);
		// 409 is a permanent refusal: Zernio saw this exact content on this
		// account in the last 24 hours. Retrying cannot change that.
		const dup = zernioHttpError('create post', 409, JSON.stringify({ error: 'Duplicate post' }));
		expect(dup.code).toBe('forbidden');
		expect(dup.retryable).toBe(false);
		expect(dup.message).toContain('24 hours');
		for (const status of [400, 402, 403, 404]) {
			expect(zernioHttpError('create post', status, '{}').retryable).toBe(false);
		}
	});

	it('words a duplicate rejection and a refused key so the Posts page cannot mistranslate them', () => {
		// humanizeError reads "already scheduled" as CogSend's own schedule clash
		// and "403" as a platform policy refusal; Zernio's refusals must not
		// land on either sentence.
		const dup = zernioHttpError(
			'create post',
			409,
			JSON.stringify({
				error:
					'This exact content is already scheduled, publishing, or was posted to this account within the last 24 hours.'
			})
		);
		expect(humanizeError(dup.message)).not.toMatch(/already scheduled/i);
		expect(humanizeError(dup.message)).toMatch(/24 hours/);
		const readOnly = zernioHttpError(
			'create post',
			403,
			JSON.stringify({ error: 'Read-only key' })
		);
		expect(humanizeError(readOnly.message)).toMatch(/read-only|publishing group/i);
		expect(readOnly.status).toBe(403);
	});

	it('treats an account Zernio has disconnected as a dead credential, not a key problem', () => {
		// Found live: the reply is a 403, and the key hint sent the reader to the
		// wrong place while the row stayed "active".
		const err = zernioHttpError(
			'create post',
			403,
			JSON.stringify({
				error:
					'Account 696e (bluesky "me.bsky.social") is disconnected and cannot be posted to. The platform token expired or was revoked. Please reconnect the account.',
				code: 'ACCOUNT_DISCONNECTED'
			})
		);
		expect(err.code).toBe('auth');
		expect(err.message).toMatch(/reconnect/i);
		expect(err.message).not.toMatch(/read-only|publishing group/i);
		const other = zernioHttpError(
			'create post',
			403,
			JSON.stringify({ error: 'One or more accounts do not belong to this user' })
		);
		expect(other.code).toBe('forbidden');
		expect(other.message).not.toMatch(/read-only|publishing group/i);
		const scoped = zernioHttpError(
			'create post',
			403,
			JSON.stringify({ error: 'This key cannot publish', code: 'insufficient_permissions' })
		);
		expect(scoped.message).toMatch(/publishing group/);
	});

	it('adopts the post id of an idempotent 202 (still saving) instead of failing', async () => {
		const fetchImpl = mockFetch({
			'/v1/posts': () =>
				Response.json(
					{ postId: 'post-again', message: 'Post is being processed (idempotent retry)' },
					{ status: 202 }
				)
		});
		const created = await createPost({
			apiKey: 'zk_1',
			body: {},
			requestId: 'r',
			fetchImpl
		});
		expect(created._id).toBe('post-again');
	});

	it('probes whether a key may publish without creating anything', async () => {
		const seen: Request[] = [];
		const usable = mockFetch(
			{
				'/v1/posts': () =>
					Response.json({ error: 'dryRun is only supported for TikTok' }, { status: 400 })
			},
			seen
		);
		await expect(
			probePublishAccess({ apiKey: 'zk_1', fetchImpl: usable })
		).resolves.toBeUndefined();
		expect(seen[0].method).toBe('POST');
		expect(await seen[0].json()).toEqual({ dryRun: true, platforms: [] });
		const readOnly = mockFetch({
			'/v1/posts': () => Response.json({ error: 'Read-only key' }, { status: 403 })
		});
		await expect(
			probePublishAccess({ apiKey: 'zk_ro', fetchImpl: readOnly })
		).rejects.toMatchObject({
			status: 403
		});
		const dead = mockFetch({
			'/v1/posts': () => Response.json({ error: 'Invalid API key' }, { status: 401 })
		});
		await expect(probePublishAccess({ apiKey: 'zk_x', fetchImpl: dead })).rejects.toMatchObject({
			code: 'auth'
		});
	});

	it('surfaces Zernio’s own sentence for the dialog', () => {
		const err = zernioHttpError(
			'list accounts',
			403,
			JSON.stringify({ error: 'This key cannot access accounts', code: 'insufficient_permissions' })
		);
		expect(zernioApiMessage(err)).toBe('This key cannot access accounts');
		expect(zernioApiMessage(new Error('boom'))).toBe('boom');
	});
});

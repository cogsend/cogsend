import { describe, expect, it } from 'vitest';
import {
	buildZernioPostBody,
	ZERNIO_MAX_POLLS,
	zernioProviderFor
} from '#lib/server/providers/zernio.js';
import { providerFor, estimateKeyFor } from '#lib/server/providers/index.js';
import { ProviderError, PublishPartialError, type FetchLike } from '#lib/server/providers/types.js';

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

const creds = { zernioApiKey: 'zk_1', zernioAccountId: 'acc-1' };
const mediaUrlFor = (key: string) => `https://media.example/${key}`;
const fast = { pollIntervalMs: 0, maxPolls: 3 };

describe('buildZernioPostBody', () => {
	it('sends a single post with its media as public URLs', async () => {
		const body = await buildZernioPostBody({
			platform: 'x',
			accountId: 'acc-1',
			content: {
				text: 'hello',
				media: [
					{ storageKey: 'k1', mime: 'image/png', alt: 'a cat' },
					{ storageKey: 'k2', mime: 'image/gif' },
					{ storageKey: 'k3', mime: 'video/mp4' }
				]
			},
			mediaUrlFor
		});
		expect(body).toEqual({
			content: 'hello',
			mediaItems: [
				{ type: 'image', url: 'https://media.example/k1', mimeType: 'image/png', altText: 'a cat' },
				{ type: 'gif', url: 'https://media.example/k2', mimeType: 'image/gif' },
				{ type: 'video', url: 'https://media.example/k3', mimeType: 'video/mp4' }
			],
			platforms: [{ platform: 'twitter', accountId: 'acc-1' }],
			publishNow: true
		});
	});

	it('sends a thread as threadItems on X, Threads and Bluesky', async () => {
		for (const [platform, zernio] of [
			['x', 'twitter'],
			['threads', 'threads'],
			['bluesky', 'bluesky']
		] as const) {
			const body = await buildZernioPostBody({
				platform,
				accountId: 'acc-1',
				content: {
					text: 'one',
					thread: [
						{ text: 'one' },
						{ text: 'two', media: [{ storageKey: 'k', mime: 'image/jpeg' }] }
					]
				},
				mediaUrlFor
			});
			expect(body.content).toBe('one');
			expect(body).not.toHaveProperty('mediaItems');
			expect(body.platforms).toEqual([
				{
					platform: zernio,
					accountId: 'acc-1',
					platformSpecificData: {
						threadItems: [
							{ content: 'one', mediaItems: [] },
							{
								content: 'two',
								mediaItems: [
									{ type: 'image', url: 'https://media.example/k', mimeType: 'image/jpeg' }
								]
							}
						]
					}
				}
			]);
		}
	});

	it('flattens a thread into one LinkedIn post, like the direct provider', async () => {
		const body = await buildZernioPostBody({
			platform: 'linkedin',
			accountId: 'acc-1',
			content: {
				text: 'one',
				thread: [
					{ text: 'one', media: [{ storageKey: 'k1', mime: 'image/png' }] },
					{ text: 'two', media: [{ storageKey: 'k2', mime: 'image/png' }] }
				]
			},
			mediaUrlFor
		});
		expect(body.content).toBe('one\n\ntwo');
		expect((body.mediaItems as unknown[]).length).toBe(2);
		expect(body.platforms).toEqual([{ platform: 'linkedin', accountId: 'acc-1' }]);
	});

	it('sends Instagram the JPEG copy of a PNG, and a JPEG as it is', async () => {
		const body = await buildZernioPostBody({
			platform: 'instagram',
			accountId: 'acc-1',
			content: {
				text: 'one',
				thread: [
					{ text: 'one', media: [{ storageKey: 'k1', mime: 'image/png', hasJpegCopy: true }] },
					{ text: 'two', media: [{ storageKey: 'k2', mime: 'image/jpeg' }] }
				]
			},
			mediaUrlFor: (key, variant) => `https://media.example/${variant ? `${variant}/` : ''}${key}`
		});
		expect(body.content).toBe('one\n\ntwo');
		expect(body.mediaItems).toEqual([
			{ type: 'image', url: 'https://media.example/jpeg/k1', mimeType: 'image/jpeg' },
			{ type: 'image', url: 'https://media.example/k2', mimeType: 'image/jpeg' }
		]);
		expect(body.platforms).toEqual([{ platform: 'instagram', accountId: 'acc-1' }]);
	});

	it('refuses to build without a media signer, like Threads', async () => {
		await expect(
			buildZernioPostBody({
				platform: 'x',
				accountId: 'acc-1',
				content: { text: 'x', media: [{ storageKey: 'k', mime: 'image/png' }] }
			})
		).rejects.toThrow(/media/i);
	});
});

describe('zernioProviderFor', () => {
	it('keeps the direct platform’s id, capabilities and validation', () => {
		const x = zernioProviderFor('x');
		expect(x.id).toBe('x');
		expect(x.capabilities.supportsThreads).toBe(true);
		expect(x.validate({ text: 'a'.repeat(281) }).some((i) => i.code === 'max_length')).toBe(true);
		expect(zernioProviderFor('linkedin').capabilities.supportsThreads).toBe(false);
		expect(zernioProviderFor('x')).toBe(zernioProviderFor('x'));
	});

	it('creates, checkpoints the Zernio post id, polls to published', async () => {
		const seen: Request[] = [];
		let polls = 0;
		const fetchImpl = mockFetch(
			{
				'/v1/posts/post-1': () => {
					polls += 1;
					return Response.json({
						post: {
							_id: 'post-1',
							platforms: [
								polls < 2
									? { platform: 'twitter', accountId: 'acc-1', status: 'publishing' }
									: {
											platform: 'twitter',
											accountId: 'acc-1',
											status: 'published',
											platformPostId: '1234',
											platformPostUrl: 'https://x.com/u/status/1234'
										}
							]
						}
					});
				},
				'/v1/posts': () =>
					Response.json({
						post: {
							_id: 'post-1',
							platforms: [{ platform: 'twitter', accountId: 'acc-1', status: 'pending' }]
						}
					})
			},
			seen
		);
		const checkpoints: unknown[] = [];
		const result = await zernioProviderFor('x', fast).publish(
			{ text: 'hello' },
			creds,
			undefined,
			fetchImpl,
			{
				mediaUrlFor,
				checkpoint: (state) => {
					checkpoints.push(state);
				},
				idempotencyKey: (i) => `target-1:${i}`
			}
		);
		expect(seen[0].headers.get('x-request-id')).toBe('target-1-0');
		expect(checkpoints[0]).toEqual({ segmentIds: ['post-1'], remoteUrl: null });
		expect(result).toEqual({
			remotePostId: '1234',
			remoteUrl: 'https://x.com/u/status/1234',
			segmentIds: ['post-1']
		});
	});

	it('gives up after the poll window with a partial error carrying the post id', async () => {
		let polls = 0;
		const fetchImpl = mockFetch({
			'/v1/posts/post-1': () => {
				polls += 1;
				return Response.json({
					post: {
						_id: 'post-1',
						platforms: [{ platform: 'twitter', accountId: 'acc-1', status: 'publishing' }]
					}
				});
			},
			'/v1/posts': () => Response.json({ post: { _id: 'post-1', platforms: [] } })
		});
		const err = await zernioProviderFor('x', fast)
			.publish({ text: 'hello' }, creds, undefined, fetchImpl, { mediaUrlFor })
			.catch((e) => e);
		expect(err).toBeInstanceOf(PublishPartialError);
		expect((err as PublishPartialError).segmentIds).toEqual(['post-1']);
		expect(polls).toBe(fast.maxPolls);
		expect(ZERNIO_MAX_POLLS).toBe(8);
	});

	it('a create replay is polled, not re-created: resume skips the create', async () => {
		const seen: Request[] = [];
		const fetchImpl = mockFetch(
			{
				'/v1/posts/post-1': () =>
					Response.json({
						post: {
							_id: 'post-1',
							platforms: [
								{
									platform: 'twitter',
									accountId: 'acc-1',
									status: 'published',
									platformPostId: '99',
									platformPostUrl: 'https://x.com/u/status/99'
								}
							]
						}
					})
			},
			seen
		);
		const result = await zernioProviderFor('x', fast).publish(
			{ text: 'hello' },
			creds,
			undefined,
			fetchImpl,
			{ mediaUrlFor, resume: { segmentIds: ['post-1'] } }
		);
		expect(seen.every((r) => r.method === 'GET')).toBe(true);
		expect(result.remotePostId).toBe('99');
	});

	it('a resumed poll that finds failed parks with Zernio’s reason', async () => {
		const fetchImpl = mockFetch({
			'/v1/posts/post-1': () =>
				Response.json({
					post: {
						_id: 'post-1',
						platforms: [
							{
								platform: 'twitter',
								accountId: 'acc-1',
								status: 'failed',
								errorMessage: 'Tweet text is too long',
								errorCategory: 'user_content'
							}
						]
					}
				})
		});
		const err = await zernioProviderFor('x', fast)
			.publish({ text: 'hello' }, creds, undefined, fetchImpl, {
				mediaUrlFor,
				resume: { segmentIds: ['post-1'] }
			})
			.catch((e) => e);
		expect(err).toBeInstanceOf(ProviderError);
		expect((err as ProviderError).message).toContain('Tweet text is too long');
		expect((err as ProviderError).code).toBe('forbidden');
		expect((err as ProviderError).retryable).toBe(false);
	});

	it('maps Zernio failure categories onto expiry and retry decisions', async () => {
		const attempt = async (errorCategory: string) => {
			const fetchImpl = mockFetch({
				'/v1/posts/post-1': () =>
					Response.json({
						post: {
							_id: 'post-1',
							platforms: [
								{ platform: 'twitter', accountId: 'acc-1', status: 'failed', errorCategory }
							]
						}
					})
			});
			const outcome: unknown = await zernioProviderFor('x', fast)
				.publish({ text: 'hello' }, creds, undefined, fetchImpl, {
					mediaUrlFor,
					resume: { segmentIds: ['post-1'] }
				})
				.catch((e) => e);
			if (!(outcome instanceof ProviderError)) throw new Error('expected a ProviderError');
			return outcome;
		};
		expect((await attempt('auth_expired')).code).toBe('auth');
		expect((await attempt('platform_error')).code).toBe('upstream');
		expect((await attempt('system_error')).retryable).toBe(true);
		expect((await attempt('user_abuse')).retryable).toBe(false);
	});

	it('requires the Zernio credentials on the row', async () => {
		await expect(
			zernioProviderFor('x', fast).publish({ text: 'hello' }, {}, undefined, mockFetch({}), {
				mediaUrlFor
			})
		).rejects.toMatchObject({ code: 'auth' });
	});
});

describe('zernioProviderFor: a dead resume point is cleared', () => {
	const resumed = (entry: Record<string, unknown> | null, getStatus = 200) => {
		const checkpoints: unknown[] = [];
		const fetchImpl = mockFetch({
			'/v1/posts/post-1': () =>
				entry === null
					? new Response('{"error":"Not found"}', { status: getStatus })
					: Response.json({ post: { _id: 'post-1', platforms: [entry] } })
		});
		const run = zernioProviderFor('x', fast)
			.publish({ text: 'hello' }, creds, undefined, fetchImpl, {
				mediaUrlFor,
				resume: { segmentIds: ['post-1'] },
				checkpoint: (state) => {
					checkpoints.push(state);
				}
			})
			.catch((e: unknown) => e);
		return { run, checkpoints };
	};

	it('on failed: empties the checkpoint before throwing, so the next attempt creates anew', async () => {
		const { run, checkpoints } = resumed({
			platform: 'twitter',
			accountId: 'acc-1',
			status: 'failed',
			errorCategory: 'platform_error',
			errorMessage: 'X is down'
		});
		const err = await run;
		expect(err).toBeInstanceOf(ProviderError);
		expect((err as ProviderError).code).toBe('upstream');
		expect(checkpoints).toEqual([{ segmentIds: [], remoteUrl: null }]);
	});

	it('platform_rate_limit is retried on backoff, not parked', async () => {
		const err = await resumed({
			platform: 'twitter',
			accountId: 'acc-1',
			status: 'failed',
			errorCategory: 'platform_rate_limit'
		}).run;
		expect((err as ProviderError).code).toBe('rate_limited');
	});

	it('a post cancelled in Zernio is terminal and clears the checkpoint', async () => {
		const { run, checkpoints } = resumed({
			platform: 'twitter',
			accountId: 'acc-1',
			status: 'cancelled'
		});
		const err = await run;
		expect(err).toBeInstanceOf(ProviderError);
		expect((err as ProviderError).retryable).toBe(false);
		expect((err as ProviderError).message).toMatch(/cancelled/i);
		expect(checkpoints).toEqual([{ segmentIds: [], remoteUrl: null }]);
	});

	it('a post that no longer exists in Zernio clears the checkpoint; a blip keeps it', async () => {
		const gone = resumed(null, 404);
		expect((await gone.run) as ProviderError).toMatchObject({ retryable: false });
		expect(gone.checkpoints).toEqual([{ segmentIds: [], remoteUrl: null }]);
		const blip = resumed(null, 503);
		expect((await blip.run) as ProviderError).toMatchObject({ retryable: true });
		expect(blip.checkpoints).toEqual([]);
	});
});

describe('zernioProviderFor: a create whose answer was lost', () => {
	// Found live: a Threads thread create outlived the request timeout, Zernio
	// published it anyway, and the retry's 409 duplicate reported a live post as
	// failed. Zernio's duplicate check runs before its x-request-id replay.
	const duplicate = () =>
		Response.json(
			{
				error:
					'This exact content is already scheduled, publishing, or was posted to this account within the last 24 hours.',
				details: { accountId: 'acc-1', platform: 'twitter', existingPostId: 'post-ours' }
			},
			{ status: 409 }
		);
	const existing = (cogsendRequestId: string) => () =>
		Response.json({
			post: {
				_id: 'post-ours',
				metadata: { cogsendRequestId, usageCounted: true },
				platforms: [
					{
						platform: 'twitter',
						accountId: 'acc-1',
						status: 'published',
						platformPostId: '77',
						platformPostUrl: 'https://x.com/u/status/77'
					}
				]
			}
		});

	it('tags every create with the request id, so the post can be recognised later', async () => {
		const seen: Request[] = [];
		const fetchImpl = mockFetch(
			{
				'/v1/posts/p': existing('target-9-0'),
				'/v1/posts': () => Response.json({ post: { _id: 'p', platforms: [] } })
			},
			seen
		);
		await zernioProviderFor('x', fast).publish({ text: 'hi' }, creds, undefined, fetchImpl, {
			mediaUrlFor,
			idempotencyKey: (i) => `target-9:${i}`
		});
		expect(((await seen[0].json()) as { metadata?: unknown }).metadata).toEqual({
			cogsendRequestId: 'target-9-0'
		});
	});

	it('adopts its own post from a duplicate 409 and polls it', async () => {
		const checkpoints: unknown[] = [];
		const result = await zernioProviderFor('x', fast).publish(
			{ text: 'hi' },
			creds,
			undefined,
			mockFetch({ '/v1/posts/post-ours': existing('target-9-0'), '/v1/posts': duplicate }),
			{
				mediaUrlFor,
				idempotencyKey: (i) => `target-9:${i}`,
				checkpoint: (s) => {
					checkpoints.push(s);
				}
			}
		);
		expect(checkpoints[0]).toEqual({ segmentIds: ['post-ours'], remoteUrl: null });
		expect(result.remotePostId).toBe('77');
	});

	it('still refuses a real duplicate: someone else’s post with the same text', async () => {
		const err = await zernioProviderFor('x', fast)
			.publish(
				{ text: 'hi' },
				creds,
				undefined,
				mockFetch({ '/v1/posts/post-ours': existing('another-target-0'), '/v1/posts': duplicate }),
				{ mediaUrlFor, idempotencyKey: (i) => `target-9:${i}` }
			)
			.catch((e) => e);
		expect(err).toBeInstanceOf(ProviderError);
		expect((err as ProviderError).message).toMatch(/24 hours/);
		expect((err as ProviderError).retryable).toBe(false);
	});
});

describe('providerFor', () => {
	it('routes on the meta marker, not the platform column', () => {
		expect(providerFor({ platform: 'x', metaJson: '{"provider":"zernio"}' })).toBe(
			zernioProviderFor('x')
		);
		expect(providerFor({ platform: 'x', metaJson: '{}' }).id).toBe('x');
		expect(providerFor({ platform: 'x', metaJson: '{}' })).not.toBe(zernioProviderFor('x'));
		expect(estimateKeyFor({ platform: 'x', metaJson: '{"provider":"zernio"}' })).toBe('zernio');
		expect(estimateKeyFor({ platform: 'x', metaJson: null })).toBe('x');
	});
});

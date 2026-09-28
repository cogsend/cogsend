import { describe, expect, it } from 'vitest';
import {
	escapeLittleText,
	linkedinPostUrl,
	linkedinProvider
} from '$lib/server/providers/linkedin';
import {
	isThreadsPermalink,
	threadsAuthorizeUrl,
	threadsPostUrl,
	threadsProvider,
	threadsUpstreamError
} from '$lib/server/providers/threads';
import { PublishPartialError } from '$lib/server/providers/types';
import type { FetchLike } from '$lib/server/providers/types';
import { validateLinkedinText, validateThreadsText } from '$lib/domain/validation/text';
import { captureConsole, loggedLines } from './console-spy';

function mockFetch(
	handlers: Record<string, (req: Request) => Promise<Response> | Response>
): FetchLike {
	return async (input, init) => {
		const url =
			typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		for (const [key, handler] of Object.entries(handlers)) {
			if (url.includes(key)) return handler(new Request(url, init));
		}
		return new Response(`No mock for ${url}`, { status: 404 });
	};
}

describe('linkedin validation', () => {
	it('accepts 3000 chars, rejects 3001', () => {
		expect(validateLinkedinText('a'.repeat(3000)).ok).toBe(true);
		const over = validateLinkedinText('a'.repeat(3001));
		expect(over.ok).toBe(false);
	});

	it('accepts threads: they are flattened into one post', () => {
		const issues = linkedinProvider.validate({
			text: 'a',
			thread: [{ text: 'a' }, { text: 'b', media: [{ mime: 'image/png', size: 10 }] }]
		});
		expect(issues).toEqual([]);
	});

	it('applies length and image limits to the flattened post', () => {
		// Each segment fits, but the joined text exceeds LinkedIn's 3000.
		const long = linkedinProvider.validate({
			text: '',
			thread: [{ text: 'a'.repeat(2000) }, { text: 'b'.repeat(1500) }]
		});
		expect(long.some((i) => i.code === 'max_length')).toBe(true);
		// Media is combined across segments, so the 4-image cap is per post.
		const image = { bytes: new Uint8Array([1]), mime: 'image/png', size: 10 };
		const many = linkedinProvider.validate({
			text: '',
			thread: [
				{ text: 'a', media: [image, image, image] },
				{ text: 'b', media: [image, image] }
			]
		});
		expect(many.some((i) => i.code === 'max_images')).toBe(true);
	});

	it('rejects webp/oversize media', () => {
		const webp = linkedinProvider.validate({
			text: 'hi',
			media: [{ bytes: new Uint8Array([1]), mime: 'image/webp', size: 10 }]
		});
		expect(webp.some((i) => i.code === 'mime')).toBe(true);
		const big = linkedinProvider.validate({
			text: 'hi',
			media: [{ bytes: new Uint8Array([1]), mime: 'image/png', size: 9_000_000 }]
		});
		expect(big.some((i) => i.code === 'max_image_bytes')).toBe(true);
	});
});

describe('linkedinProvider.publish', () => {
	it('flattens a thread into a single post with combined media', async () => {
		const posts: Record<string, unknown>[] = [];
		const fetchImpl = mockFetch({
			'/rest/images?action=initializeUpload': async () =>
				Response.json({
					value: { uploadUrl: 'https://upload.test/img', image: 'urn:li:image:IMG1' }
				}),
			'upload.test/img': () => new Response('', { status: 201 }),
			'/rest/posts': async (req) => {
				posts.push((await req.json()) as Record<string, unknown>);
				return new Response(JSON.stringify({ id: 'urn:li:share:thread' }), {
					status: 201,
					headers: { 'x-restli-id': 'urn:li:share:thread', 'Content-Type': 'application/json' }
				});
			}
		});
		const result = await linkedinProvider.publish(
			{
				text: 'first',
				thread: [
					{ text: 'first' },
					{
						text: 'second',
						media: [{ bytes: new Uint8Array([1, 2]), mime: 'image/png', size: 2 }]
					}
				]
			},
			{ accessToken: 'tok', personUrn: 'urn:li:person:abc' },
			undefined,
			fetchImpl
		);
		expect(result.remotePostId).toBe('urn:li:share:thread');
		expect(posts).toHaveLength(1);
		expect(posts[0].commentary).toBe('first\n\nsecond');
		expect(posts[0].content).toEqual({ media: { id: 'urn:li:image:IMG1', altText: undefined } });
		expect((posts[0].content as { media: object }).media).not.toHaveProperty('title');
	});

	it('refuses more than four combined images', async () => {
		const image = { bytes: new Uint8Array([1]), mime: 'image/png', size: 2 };
		const fetchImpl = mockFetch({
			'/rest/images?action=initializeUpload': async () =>
				Response.json({
					value: { uploadUrl: 'https://upload.test/img', image: 'urn:li:image:IMG1' }
				}),
			'upload.test/img': () => new Response('', { status: 201 }),
			'/rest/posts': async () => Response.json({ id: 'x' }, { status: 201 })
		});
		await expect(
			linkedinProvider.publish(
				{ text: 'a', media: [image, image, image, image, image] },
				{ accessToken: 'tok', personUrn: 'urn:li:person:abc' },
				undefined,
				fetchImpl
			)
		).rejects.toThrow(/max 4 images/i);
	});

	it('uploads image then creates post', async () => {
		const seen: string[] = [];
		const fetchImpl = mockFetch({
			'/rest/images?action=initializeUpload': async (req) => {
				const body = await req.json();
				expect(body.initializeUploadRequest.owner).toBe('urn:li:person:abc');
				// Images API takes owner only. fileSizeBytes/uploadCaptions/
				// uploadThumbnail are Videos API fields; LinkedIn rejects them
				// with a 400 param validation error.
				expect(Object.keys(body.initializeUploadRequest)).toEqual(['owner']);
				return Response.json({
					value: { uploadUrl: 'https://upload.test/img', image: 'urn:li:image:IMG1' }
				});
			},
			'upload.test/img': () => {
				seen.push('put');
				return new Response('', { status: 201 });
			},
			'/rest/posts': async (req) => {
				const body = await req.json();
				expect(body.author).toBe('urn:li:person:abc');
				expect(body.commentary).toBe('Hello LinkedIn');
				expect(body.content.media.id).toBe('urn:li:image:IMG1');
				return new Response(JSON.stringify({ id: 'urn:li:share:123' }), {
					status: 201,
					headers: { 'x-restli-id': 'urn:li:share:123', 'Content-Type': 'application/json' }
				});
			}
		});
		const result = await linkedinProvider.publish(
			{
				text: 'Hello LinkedIn',
				media: [{ bytes: new Uint8Array([1, 2]), mime: 'image/png', size: 2 }]
			},
			{ accessToken: 'tok', personUrn: 'urn:li:person:abc' },
			undefined,
			fetchImpl
		);
		expect(result.remotePostId).toBe('urn:li:share:123');
		expect(seen).toEqual(['put']);
	});

	it('uploads video in parts, finalizes, then posts', async () => {
		const puts: string[] = [];
		const fetchImpl = mockFetch({
			'/rest/videos?action=initializeUpload': async (req) => {
				const body = await req.json();
				expect(body.initializeUploadRequest.owner).toBe('urn:li:person:abc');
				expect(body.initializeUploadRequest.fileSizeBytes).toBe(10);
				return Response.json({
					value: {
						uploadInstructions: [
							{ uploadUrl: 'https://upload.test/vid-p1', firstByte: 0, lastByte: 4 },
							{ uploadUrl: 'https://upload.test/vid-p2', firstByte: 5, lastByte: 9 }
						],
						uploadToken: 'tok-vid',
						video: 'urn:li:video:VID1'
					}
				});
			},
			'upload.test/vid-p': (req) => {
				puts.push(req.url);
				return new Response('', {
					status: 201,
					headers: { ETag: `"etag-${puts.length}"` }
				});
			},
			'/rest/videos?action=finalizeUpload': async (req) => {
				const body = await req.json();
				expect(body.finalizeUploadRequest).toEqual({
					video: 'urn:li:video:VID1',
					uploadToken: 'tok-vid',
					uploadedPartIds: ['etag-1', 'etag-2']
				});
				return new Response('', { status: 200 });
			},
			'/rest/posts': async (req) => {
				const body = await req.json();
				expect(body.content.video.id).toBe('urn:li:video:VID1');
				return new Response(JSON.stringify({ id: 'urn:li:share:vid' }), {
					status: 201,
					headers: { 'x-restli-id': 'urn:li:share:vid', 'Content-Type': 'application/json' }
				});
			}
		});
		const result = await linkedinProvider.publish(
			{
				text: 'watch this',
				media: [
					{ bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), mime: 'video/mp4', size: 10 }
				]
			},
			{ accessToken: 'tok', personUrn: 'urn:li:person:abc' },
			undefined,
			fetchImpl
		);
		expect(result.remotePostId).toBe('urn:li:share:vid');
		expect(puts).toHaveLength(2);
	});

	it('rejects mixed video+images and non-mp4', async () => {
		const issues = linkedinProvider.validate({
			text: 'x',
			media: [
				{ mime: 'video/mp4', size: 10 },
				{ mime: 'image/png', size: 10 }
			]
		});
		expect(issues.some((i) => i.code === 'video_with_images')).toBe(true);
		const bad = linkedinProvider.validate({
			text: 'x',
			media: [{ mime: 'video/webm', size: 10 }]
		});
		expect(bad.some((i) => i.code === 'mime')).toBe(true);
	});

	it('creates text-only post', async () => {
		const fetchImpl = mockFetch({
			'/rest/posts': async (req) => {
				const body = await req.json();
				expect(body.content).toBeUndefined();
				return new Response(JSON.stringify({ id: 'urn:li:share:9' }), {
					status: 201,
					headers: { 'x-restli-id': 'urn:li:share:9', 'Content-Type': 'application/json' }
				});
			}
		});
		const result = await linkedinProvider.publish(
			{ text: 'text only' },
			{ accessToken: 'tok', personUrn: 'abc' },
			undefined,
			fetchImpl
		);
		expect(result.remotePostId).toBe('urn:li:share:9');
	});

	it('records the post the moment LinkedIn accepts it', async () => {
		const recorded: Array<{ segmentIds: string[]; remoteUrl?: string | null }> = [];
		const result = await linkedinProvider.publish(
			{ text: 'checkpointed' },
			{ accessToken: 'tok', personUrn: 'abc' },
			undefined,
			mockFetch({
				'/rest/posts': async () =>
					new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:7' } })
			}),
			{ checkpoint: (state) => void recorded.push(state) }
		);
		expect(result.remotePostId).toBe('urn:li:share:7');
		expect(recorded).toEqual([
			{ segmentIds: ['urn:li:share:7'], remoteUrl: result.remoteUrl ?? null }
		]);
	});

	it('does not post again when an earlier attempt already went out', async () => {
		const result = await linkedinProvider.publish(
			{ text: 'already live' },
			{ accessToken: 'tok', personUrn: 'abc' },
			undefined,
			async () => {
				throw new Error('a resumed LinkedIn post must not reach the network');
			},
			{
				resume: {
					segmentIds: ['urn:li:share:7'],
					remoteUrl: 'https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A7/'
				}
			}
		);
		expect(result).toEqual({
			remotePostId: 'urn:li:share:7',
			remoteUrl: 'https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A7/'
		});
	});

	it('says a post may be live when LinkedIn never answers', async () => {
		const err = await linkedinProvider
			.publish(
				{ text: 'no answer' },
				{ accessToken: 'tok', personUrn: 'abc' },
				undefined,
				async () => {
					throw Object.assign(new Error('Provider request timed out'), { status: 504 });
				}
			)
			.catch((e: unknown) => e);
		expect(err).toMatchObject({ code: 'unconfirmed', retryable: false });
		expect((err as Error).message).toMatch(/LinkedIn did not confirm the post/);
	});

	it('does not invent a post id when LinkedIn omits one', async () => {
		// The post is out; only its id is missing. A timestamp used to stand in
		// for it, which looks like a real id, never matches the platform, and
		// hides that the permalink is unknown.
		const logged = captureConsole();
		const fetchImpl = mockFetch({
			'/rest/posts': async () =>
				new Response(JSON.stringify({}), {
					status: 201,
					headers: { 'Content-Type': 'application/json' }
				})
		});
		const result = await linkedinProvider.publish(
			{ text: 'no id in the answer' },
			{ accessToken: 'tok', personUrn: 'abc' },
			undefined,
			fetchImpl
		);
		expect(result.remotePostId).toBeUndefined();
		expect(result.remoteUrl).toBeUndefined();
		// Whoever reads the post later needs to know the permalink is unknown.
		expect(loggedLines(logged).join('\n')).toContain('[linkedin] post accepted without an id');
	});
});

describe('threads validation', () => {
	it('accepts 500 chars, rejects 501', () => {
		expect(validateThreadsText('a'.repeat(500)).ok).toBe(true);
		expect(validateThreadsText('a'.repeat(501)).ok).toBe(false);
	});

	it('accepts multi-post threads; rejects oversized and non-JPEG/PNG images, >5 links', () => {
		expect(threadsProvider.validate({ text: 'a', thread: [{ text: 'a' }, { text: 'b' }] })).toEqual(
			[]
		);
		expect(threadsProvider.capabilities.supportsThreads).toBe(true);
		expect(
			threadsProvider
				.validate({
					text: 'hi',
					media: [
						{ mime: 'image/png', size: 10 },
						{ mime: 'image/gif', size: 10 }
					]
				})
				.some((i) => i.code === 'bad_image_type')
		).toBe(true);
		expect(
			threadsProvider
				.validate({ text: 'hi', media: [{ mime: 'image/png', size: 9_000_000 }] })
				.some((i) => i.code === 'max_image_bytes')
		).toBe(true);
		expect(
			threadsProvider.validate({
				text: 'ok',
				media: [{ mime: 'image/png', size: 10 }]
			}).length
		).toBe(0);
		expect(threadsProvider.validate({ text: '', media: [] }).some((i) => i.code === 'empty')).toBe(
			true
		);
		expect(
			threadsProvider.validate({ text: '', media: [{ mime: 'image/png', size: 10 }] }).length
		).toBe(0);
		const manyLinks = [
			'https://a.com',
			'https://b.com',
			'https://c.com',
			'https://d.com',
			'https://e.com',
			'https://f.com'
		].join(' ');
		expect(threadsProvider.validate({ text: manyLinks }).some((i) => i.code === 'max_links')).toBe(
			true
		);
	});
});

describe('post permalinks', () => {
	it('builds best-effort public urls from shortcodes', () => {
		expect(linkedinPostUrl('urn:li:share:123')).toBe(
			'https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A123/'
		);
		expect(linkedinPostUrl('')).toBeNull();
		expect(threadsPostUrl('DdHkaqrEruo', { threadsUsername: 'someone' })).toBe(
			'https://www.threads.net/@someone/post/DdHkaqrEruo'
		);
		expect(threadsPostUrl('DdHkaqrEruo', { handle: '@someone' })).toBe(
			'https://www.threads.net/@someone/post/DdHkaqrEruo'
		);
		expect(threadsPostUrl('DdHkaqrEruo', {})).toBeNull();
		expect(threadsPostUrl('', { threadsUsername: 'someone' })).toBeNull();
	});

	it('accepts real permalinks and rejects numeric media-id urls', () => {
		expect(isThreadsPermalink('https://www.threads.com/@testuser/post/DdHkaqrEruo')).toBe(true);
		expect(isThreadsPermalink('https://www.threads.net/@testuser/post/DdHkaqrEruo/')).toBe(true);
		expect(isThreadsPermalink('https://www.threads.net/@testuser/post/18021145505922992')).toBe(
			false
		);
		expect(isThreadsPermalink('https://example.com/@testuser/post/DdHkaqrEruo')).toBe(false);
		expect(isThreadsPermalink('http://www.threads.com/@testuser/post/DdHkaqrEruo')).toBe(false);
		expect(isThreadsPermalink('not a url')).toBe(false);
		expect(isThreadsPermalink(null)).toBe(false);
		expect(isThreadsPermalink(undefined)).toBe(false);
	});

	it('threads publish stores the API permalink, not the media id', async () => {
		const fetchImpl = mockFetch({
			'fields=permalink': async () =>
				Response.json({
					permalink: 'https://www.threads.com/@someone/post/DdHkaqrEruo',
					shortcode: 'DdHkaqrEruo'
				}),
			'/threads_publish': async () => Response.json({ id: 'media-42' }),
			'/threads': async () => Response.json({ id: 'c-1' })
		});
		const result = await threadsProvider.publish(
			{ text: 'hi' },
			{ accessToken: 'tok', threadsUserId: '123', threadsUsername: 'someone' },
			undefined,
			fetchImpl
		);
		expect(result.remotePostId).toBe('media-42');
		expect(result.remoteUrl).toBe('https://www.threads.com/@someone/post/DdHkaqrEruo');
	});

	it('falls back to the shortcode when the permalink is omitted', async () => {
		const fetchImpl = mockFetch({
			'fields=permalink': async () => Response.json({ shortcode: 'DdHkaqrEruo' }),
			'/threads_publish': async () => Response.json({ id: 'media-42' }),
			'/threads': async () => Response.json({ id: 'c-1' })
		});
		const result = await threadsProvider.publish(
			{ text: 'hi' },
			{ accessToken: 'tok', threadsUserId: '123', threadsUsername: 'someone' },
			undefined,
			fetchImpl
		);
		expect(result.remoteUrl).toBe('https://www.threads.net/@someone/post/DdHkaqrEruo');
	});

	it('stores no link when the lookup yields nothing', async () => {
		const fetchImpl = mockFetch({
			'fields=permalink': async () => new Response('{"error":{"code":100}}', { status: 400 }),
			'/threads_publish': async () => Response.json({ id: 'media-42' }),
			'/threads': async () => Response.json({ id: 'c-1' })
		});
		const result = await threadsProvider.publish(
			{ text: 'hi' },
			{ accessToken: 'tok', threadsUserId: '123', threadsUsername: 'someone' },
			undefined,
			fetchImpl
		);
		expect(result.remoteUrl).toBeUndefined();
	});

	it('retries transient lookup failures before giving up', async () => {
		let calls = 0;
		const fetchImpl = mockFetch({
			'fields=permalink': async () => {
				calls += 1;
				if (calls === 1) return new Response('upstream', { status: 500 });
				return Response.json({
					permalink: 'https://www.threads.com/@someone/post/DdHkaqrEruo'
				});
			},
			'/threads_publish': async () => Response.json({ id: 'media-42' }),
			'/threads': async () => Response.json({ id: 'c-1' })
		});
		const result = await threadsProvider.publish(
			{ text: 'hi' },
			{ accessToken: 'tok', threadsUserId: '123', threadsUsername: 'someone' },
			undefined,
			fetchImpl
		);
		expect(calls).toBe(2);
		expect(result.remoteUrl).toBe('https://www.threads.com/@someone/post/DdHkaqrEruo');
	});
});

describe('threads permalinks on resume', () => {
	const root = 'https://www.threads.com/@someone/post/DdHkaqrEruo';
	const creds = { accessToken: 'tok', threadsUserId: '123', threadsUsername: 'someone' };
	const threadContent = () => ({
		text: 'first',
		thread: [{ text: 'first' }, { text: 'second' }]
	});

	it('resolves the root link, not the segment published next', async () => {
		const seen: string[] = [];
		const fetchImpl = mockFetch({
			'fields=permalink': async (req) => {
				seen.push(req.url);
				return Response.json(
					req.url.includes('media-1')
						? { permalink: root }
						: { permalink: 'https://www.threads.com/@someone/post/SecondSegment' }
				);
			},
			'/threads_publish': async () => Response.json({ id: 'media-2' }),
			'/threads': async () => Response.json({ id: 'c-9' })
		});
		const result = await threadsProvider.publish(threadContent(), creds, undefined, fetchImpl, {
			resume: { segmentIds: ['media-1'], remoteUrl: null }
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]).toContain('media-1');
		expect(result.remoteUrl).toBe(root);
	});

	it('keeps a real stored permalink when the lookup fails', async () => {
		const fetchImpl = mockFetch({
			'fields=permalink': async () => new Response('nope', { status: 404 }),
			'/threads_publish': async () => Response.json({ id: 'media-2' }),
			'/threads': async () => Response.json({ id: 'c-9' })
		});
		const result = await threadsProvider.publish(threadContent(), creds, undefined, fetchImpl, {
			resume: { segmentIds: ['media-1'], remoteUrl: root }
		});
		expect(result.remoteUrl).toBe(root);
	});

	it('drops a pre-fix numeric url instead of reusing it', async () => {
		const fetchImpl = mockFetch({
			'fields=permalink': async () => new Response('nope', { status: 404 }),
			'/threads_publish': async () => Response.json({ id: 'media-2' }),
			'/threads': async () => Response.json({ id: 'c-9' })
		});
		const result = await threadsProvider.publish(threadContent(), creds, undefined, fetchImpl, {
			resume: {
				segmentIds: ['media-1'],
				remoteUrl: 'https://www.threads.net/@someone/post/18021145505922992'
			}
		});
		expect(result.remoteUrl).toBeUndefined();
	});

	it('carries the resolved permalink into a partial failure', async () => {
		let np = 0;
		const fetchImpl = mockFetch({
			'fields=permalink': async () => Response.json({ permalink: root }),
			'/threads_publish': async () => {
				np += 1;
				if (np > 1) return new Response('boom', { status: 500 });
				return Response.json({ id: 'media-1' });
			},
			'/threads': async () => Response.json({ id: `c-${np + 1}` })
		});
		try {
			await threadsProvider.publish(threadContent(), creds, undefined, fetchImpl);
			expect.unreachable('second segment should fail');
		} catch (err) {
			expect(err).toBeInstanceOf(PublishPartialError);
			expect((err as PublishPartialError).segmentIds).toEqual(['media-1']);
			expect((err as PublishPartialError).remoteUrl).toBe(root);
		}
	});
});

describe('threadsProvider.publish', () => {
	it('creates container then publishes', async () => {
		const calls: string[] = [];
		const fetchImpl = mockFetch({
			'/threads_publish': async () => {
				calls.push('publish');
				return Response.json({ id: 'media-1' });
			},
			'/threads': async (req) => {
				const body = await req.text();
				expect(body).toContain('media_type=TEXT');
				calls.push('container');
				return Response.json({ id: 'container-1' });
			}
		});
		const result = await threadsProvider.publish(
			{ text: 'Hello Threads' },
			{ accessToken: 'tok', threadsUserId: '123' },
			undefined,
			fetchImpl
		);
		expect(result.remotePostId).toBe('media-1');
		expect(calls).toEqual(['container', 'publish']);
	});

	it('posts a single image with caption', async () => {
		const bodies: string[] = [];
		const fetchImpl = mockFetch({
			'/threads_publish': async () => Response.json({ id: 'img-post' }),
			'/threads': async (req) => {
				bodies.push(await req.text());
				return Response.json({ id: 'c-img' });
			}
		});
		const result = await threadsProvider.publish(
			{
				text: 'look',
				media: [{ storageKey: 'k1', mime: 'image/png', size: 100 }]
			},
			{ accessToken: 'tok', threadsUserId: '123' },
			undefined,
			fetchImpl,
			{ mediaUrlFor: (key: string) => `https://cdn.test/${key}?sig=s` }
		);
		expect(result.remotePostId).toBe('img-post');
		expect(bodies).toHaveLength(1);
		expect(bodies[0]).toContain('media_type=IMAGE');
		expect(bodies[0]).toContain('image_url=');
		expect(bodies[0]).toContain('text=look');
	});

	it('posts a carousel for multiple images after every child is FINISHED', async () => {
		const bodies: string[] = [];
		const events: string[] = [];
		let n = 0;
		const fetchImpl = mockFetch({
			'/threads_publish': async () => {
				events.push('publish');
				return Response.json({ id: 'car-post' });
			},
			'fields=status': async (req) => {
				events.push(`status:${new URL(req.url).pathname.split('/').pop()}`);
				return Response.json({ status: 'FINISHED' });
			},
			'/threads': async (req) => {
				const body = await req.text();
				bodies.push(body);
				n += 1;
				events.push(body.includes('media_type=CAROUSEL') ? 'parent' : `child-${n}`);
				return Response.json({ id: `child-${n}` });
			}
		});
		const result = await threadsProvider.publish(
			{
				text: 'gallery',
				media: [
					{ storageKey: 'k1', mime: 'image/jpeg', size: 100 },
					{ storageKey: 'k2', mime: 'image/png', size: 100 }
				]
			},
			{ accessToken: 'tok', threadsUserId: '123' },
			undefined,
			fetchImpl,
			{ mediaUrlFor: (key: string) => `https://cdn.test/${key}` }
		);
		expect(result.remotePostId).toBe('car-post');
		expect(bodies).toHaveLength(3);
		expect(bodies[0]).toContain('is_carousel_item=true');
		expect(bodies[2]).toContain('media_type=CAROUSEL');
		expect(bodies[2]).toContain('children=child-1%2Cchild-2');
		// The parent may only be created once both children are FINISHED.
		const parentAt = events.indexOf('parent');
		expect(parentAt).toBeGreaterThan(events.indexOf('status:child-1'));
		expect(parentAt).toBeGreaterThan(events.indexOf('status:child-2'));
	});

	it('waits for a processing carousel child before creating the parent', async () => {
		const bodies: string[] = [];
		let n = 0;
		const reads = new Map<string, number>();
		const fetchImpl = mockFetch({
			'/threads_publish': async () => Response.json({ id: 'car-post' }),
			'fields=status': async (req) => {
				const id = new URL(req.url).pathname.split('/').pop() ?? '';
				const count = (reads.get(id) ?? 0) + 1;
				reads.set(id, count);
				// child-2 reports IN_PROGRESS on its first read only; the
				// parent (child-3) and child-1 are always ready.
				const status = id === 'child-2' && count === 1 ? 'IN_PROGRESS' : 'FINISHED';
				return Response.json({ status });
			},
			'/threads': async (req) => {
				bodies.push(await req.text());
				n += 1;
				return Response.json({ id: `child-${n}` });
			}
		});
		const result = await threadsProvider.publish(
			{
				text: 'gallery',
				media: [
					{ storageKey: 'k1', mime: 'image/jpeg', size: 100 },
					{ storageKey: 'k2', mime: 'image/png', size: 100 }
				]
			},
			{ accessToken: 'tok', threadsUserId: '123' },
			undefined,
			fetchImpl,
			{ mediaUrlFor: (key: string) => `https://cdn.test/${key}` }
		);
		expect(result.remotePostId).toBe('car-post');
		expect(bodies).toHaveLength(3);
		expect(bodies[2]).toContain('media_type=CAROUSEL');
		expect(reads.get('child-2')).toBe(2);
	}, 15000);

	it('recreates a carousel child whose media download failed', async () => {
		const bodies: string[] = [];
		let n = 0;
		const fetchImpl = mockFetch({
			'/threads_publish': async () => Response.json({ id: 'car-post' }),
			'fields=status': async (req) => {
				const id = new URL(req.url).pathname.split('/').pop() ?? '';
				if (id === 'child-1') {
					return Response.json({
						status: 'ERROR',
						error_message: 'media download has failed'
					});
				}
				return Response.json({ status: 'FINISHED' });
			},
			'/threads': async (req) => {
				bodies.push(await req.text());
				n += 1;
				return Response.json({ id: `child-${n}` });
			}
		});
		const result = await threadsProvider.publish(
			{
				text: 'gallery',
				media: [
					{ storageKey: 'k1', mime: 'image/jpeg', size: 100 },
					{ storageKey: 'k2', mime: 'image/png', size: 100 }
				]
			},
			{ accessToken: 'tok', threadsUserId: '123' },
			undefined,
			fetchImpl,
			{ mediaUrlFor: (key: string) => `https://cdn.test/${key}` }
		);
		expect(result.remotePostId).toBe('car-post');
		// child-1, child-2, recreated child-3, CAROUSEL parent child-4.
		expect(bodies).toHaveLength(4);
		expect(bodies[2]).toContain('is_carousel_item=true');
		expect(bodies[3]).toContain('media_type=CAROUSEL');
		expect(bodies[3]).toContain('children=child-3%2Cchild-2');
	}, 15000);

	it('recreates a carousel child whose container expired', async () => {
		const bodies: string[] = [];
		let n = 0;
		const fetchImpl = mockFetch({
			'/threads_publish': async () => Response.json({ id: 'car-post' }),
			'fields=status': async (req) => {
				const id = new URL(req.url).pathname.split('/').pop() ?? '';
				if (id === 'child-2') return Response.json({ status: 'EXPIRED' });
				return Response.json({ status: 'FINISHED' });
			},
			'/threads': async (req) => {
				bodies.push(await req.text());
				n += 1;
				return Response.json({ id: `child-${n}` });
			}
		});
		const result = await threadsProvider.publish(
			{
				text: 'gallery',
				media: [
					{ storageKey: 'k1', mime: 'image/jpeg', size: 100 },
					{ storageKey: 'k2', mime: 'image/png', size: 100 }
				]
			},
			{ accessToken: 'tok', threadsUserId: '123' },
			undefined,
			fetchImpl,
			{ mediaUrlFor: (key: string) => `https://cdn.test/${key}` }
		);
		expect(result.remotePostId).toBe('car-post');
		// child-1, child-2, recreated child-3, CAROUSEL parent child-4.
		expect(bodies).toHaveLength(4);
		expect(bodies[3]).toContain('media_type=CAROUSEL');
		expect(bodies[3]).toContain('children=child-1%2Cchild-3');
	}, 15000);

	it('fails a carousel child that errors for content reasons', async () => {
		const bodies: string[] = [];
		let n = 0;
		const fetchImpl = mockFetch({
			'/threads_publish': async () => Response.json({ id: 'car-post' }),
			'fields=status': async (req) => {
				const id = new URL(req.url).pathname.split('/').pop() ?? '';
				if (id === 'child-1') {
					return Response.json({
						status: 'ERROR',
						error_message: 'The image format is not supported'
					});
				}
				return Response.json({ status: 'FINISHED' });
			},
			'/threads': async (req) => {
				bodies.push(await req.text());
				n += 1;
				return Response.json({ id: `child-${n}` });
			}
		});
		await expect(
			threadsProvider.publish(
				{
					text: 'gallery',
					media: [
						{ storageKey: 'k1', mime: 'image/jpeg', size: 100 },
						{ storageKey: 'k2', mime: 'image/png', size: 100 }
					]
				},
				{ accessToken: 'tok', threadsUserId: '123' },
				undefined,
				fetchImpl,
				{ mediaUrlFor: (key: string) => `https://cdn.test/${key}` }
			)
		).rejects.toThrow(/image format is not supported/i);
		// No CAROUSEL parent was ever created.
		expect(bodies.some((b) => b.includes('media_type=CAROUSEL'))).toBe(false);
	});

	it('retries a carousel parent rejected with 4279004 using fresh children', async () => {
		const bodies: string[] = [];
		let n = 0;
		let parentAttempts = 0;
		const fetchImpl = mockFetch({
			'/threads_publish': async () => Response.json({ id: 'car-post' }),
			'fields=status': async () => Response.json({ status: 'FINISHED' }),
			'/threads': async (req) => {
				const body = await req.text();
				bodies.push(body);
				if (body.includes('media_type=CAROUSEL')) {
					parentAttempts += 1;
					if (parentAttempts === 1) {
						return Response.json(
							{
								error: {
									message: 'Invalid parameter',
									code: 100,
									error_subcode: 4279004,
									error_user_msg: 'The children with IDs 1 are invalid, non-existent or expired.'
								}
							},
							{ status: 400 }
						);
					}
					return Response.json({ id: `child-${n}` });
				}
				n += 1;
				return Response.json({ id: `child-${n}` });
			}
		});
		const result = await threadsProvider.publish(
			{
				text: 'gallery',
				media: [
					{ storageKey: 'k1', mime: 'image/jpeg', size: 100 },
					{ storageKey: 'k2', mime: 'image/png', size: 100 }
				]
			},
			{ accessToken: 'tok', threadsUserId: '123' },
			undefined,
			fetchImpl,
			{ mediaUrlFor: (key: string) => `https://cdn.test/${key}` }
		);
		expect(result.remotePostId).toBe('car-post');
		expect(parentAttempts).toBe(2);
		// The retry recreated the children instead of reusing the rejected ids.
		const parents = bodies.filter((b) => b.includes('media_type=CAROUSEL'));
		expect(parents).toHaveLength(2);
		expect(parents[0]).toContain('children=child-1%2Cchild-2');
		expect(parents[1]).toContain('children=child-3%2Cchild-4');
	}, 15000);
});

describe('threads profile resolution', () => {
	it('exchange prefers name for displayName and stores real username', async () => {
		const seen: string[] = [];
		const fetchImpl = mockFetch({
			'/oauth/access_token': async () =>
				Response.json({ access_token: 'short-tok', user_id: '12345678901234560' }),
			'/access_token': async () => Response.json({ access_token: 'long-tok', expires_in: 5184000 }),
			'graph.threads.net': async (req: Request) => {
				seen.push(req.url);
				return Response.json({
					id: '12345678901234560',
					username: 'testuser',
					name: 'Test User',
					threads_profile_picture_url: 'https://cdn.test/pic.jpg'
				});
			}
		});
		const { threadsExchangeCode } = await import('$lib/server/providers/threads');
		const out = await threadsExchangeCode(
			{ appId: 'app', appSecret: 'sec', code: 'CODE', appUrl: 'https://app.test' },
			fetchImpl
		);
		expect(seen.some((u) => u.includes('fields=') && u.includes('name'))).toBe(true);
		expect(out.threadsUserId).toBe('12345678901234560');
		expect(out.threadsUsername).toBe('testuser');
		expect(out.handle).toBe('@testuser');
		expect(out.displayName).toBe('Test User');
		expect(out.avatarUrl).toBe('https://cdn.test/pic.jpg');
		expect(out.scopes).toEqual([
			'threads_basic',
			'threads_content_publish',
			'threads_manage_replies'
		]);
	});

	it('requests the reply scope in the authorize URL', () => {
		const url = new URL(threadsAuthorizeUrl('app', 'https://app.test', 'state'));
		expect(url.searchParams.get('scope')).toBe(
			'threads_basic,threads_content_publish,threads_manage_replies'
		);
	});

	it('exchange falls back without storing numeric username', async () => {
		const fetchImpl = mockFetch({
			'/oauth/access_token': async () =>
				Response.json({ access_token: 'short-tok', user_id: 12345678901234560 }),
			'/access_token': async () => Response.json({ access_token: 'long-tok' }),
			'graph.threads.net': async () => new Response('denied', { status: 400 })
		});
		const { threadsExchangeCode } = await import('$lib/server/providers/threads');
		const out = await threadsExchangeCode(
			{ appId: 'app', appSecret: 'sec', code: 'CODE', appUrl: 'https://app.test' },
			fetchImpl
		);
		expect(out.threadsUserId).toBe('12345678901234560');
		expect(out.threadsUsername).toBeUndefined();
		expect(out.handle).toBe('@12345678901234560');
		expect(out.displayName).toBe('Threads');
		expect(out.avatarUrl).toBeUndefined();
	});

	it('stores the profile id when the OAuth user_id is not publishable', async () => {
		const fetchImpl = mockFetch({
			'/oauth/access_token': async () =>
				Response.json({ access_token: 'short-tok', user_id: '12345678901234560' }),
			'/access_token': async () => Response.json({ access_token: 'long-tok', expires_in: 5184000 }),
			'graph.threads.net': async (req: Request) => {
				// The OAuth-derived id is rejected; the /me fallback resolves.
				if (req.url.includes('/12345678901234560')) return new Response('nope', { status: 400 });
				return Response.json({ id: '999', username: 'testuser', name: 'Test User' });
			}
		});
		const { threadsExchangeCode } = await import('$lib/server/providers/threads');
		const out = await threadsExchangeCode(
			{ appId: 'app', appSecret: 'sec', code: 'CODE', appUrl: 'https://app.test' },
			fetchImpl
		);
		expect(out.threadsUserId).toBe('999');
		expect(out.handle).toBe('@testuser');
	});

	it('verify returns name and heals numeric rows', async () => {
		const fetchImpl = mockFetch({
			'graph.threads.net': async () =>
				Response.json({
					id: '12345678901234560',
					username: 'testuser',
					name: 'Test User',
					threads_profile_picture_url: 'https://cdn.test/pic.jpg'
				})
		});
		const { threadsVerify } = await import('$lib/server/providers/threads');
		const info = await threadsVerify(
			{ accessToken: 'tok', threadsUserId: '12345678901234560' },
			fetchImpl
		);
		expect(info.displayName).toBe('Test User');
		expect(info.handle).toBe('@testuser');
		expect(info.avatarUrl).toBe('https://cdn.test/pic.jpg');
		expect(info.userId).toBe('12345678901234560');
	});

	it('postUrl skips numeric fallback but prefers healed handle', async () => {
		const { threadsPostUrl } = await import('$lib/server/providers/threads');
		expect(
			threadsPostUrl('DdHkaqrEruo', {
				threadsUserId: '12345678901234560',
				threadsUsername: '12345678901234560',
				handle: '@12345678901234560'
			})
		).toBeNull();
		expect(
			threadsPostUrl('DdHkaqrEruo', {
				threadsUserId: '12345678901234560',
				threadsUsername: '12345678901234560',
				handle: '@testuser'
			})
		).toBe('https://www.threads.net/@testuser/post/DdHkaqrEruo');
	});
});

describe('threads multi-post threads', () => {
	function formParams(body: string): Record<string, string> {
		return Object.fromEntries(new URLSearchParams(body)) as Record<string, string>;
	}

	it('chains text segments via reply_to_id', async () => {
		const containers: Record<string, string>[] = [];
		const creations: Record<string, string>[] = [];
		let nc = 0;
		let np = 0;
		const fetchImpl = mockFetch({
			'fields=permalink': async () =>
				Response.json({ permalink: 'https://www.threads.com/@someone/post/DdHkaqrEruo' }),
			'/threads_publish': async (req) => {
				creations.push(formParams(await req.text()));
				np += 1;
				return Response.json({ id: `media-${np}` });
			},
			'/threads': async (req) => {
				containers.push(formParams(await req.text()));
				nc += 1;
				return Response.json({ id: `c-${nc}` });
			}
		});
		const result = await threadsProvider.publish(
			{ text: 'first', thread: [{ text: 'first' }, { text: 'second' }] },
			{ accessToken: 'tok', threadsUserId: '123', threadsUsername: 'someone' },
			undefined,
			fetchImpl
		);
		expect(result.remotePostId).toBe('media-1');
		expect(result.segmentIds).toEqual(['media-1', 'media-2']);
		expect(result.remoteUrl).toBe('https://www.threads.com/@someone/post/DdHkaqrEruo');
		expect(containers).toHaveLength(2);
		expect(containers[0].media_type).toBe('TEXT');
		expect(containers[0].text).toBe('first');
		expect(containers[0].reply_to_id).toBeUndefined();
		expect(containers[1].text).toBe('second');
		expect(containers[1].reply_to_id).toBe('media-1');
		expect(creations.map((c) => c.creation_id)).toEqual(['c-1', 'c-2']);
	});
	it('checkpoints every segment as it lands', async () => {
		const checkpoints: string[][] = [];
		let np = 0;
		const fetchImpl = mockFetch({
			'/threads_publish': async () => Response.json({ id: `media-${++np}` }),
			'/threads': async () => Response.json({ id: `c-${np + 1}` })
		});
		await threadsProvider.publish(
			{ text: 'first', thread: [{ text: 'first' }, { text: 'second' }] },
			{ accessToken: 'tok', threadsUserId: '123', threadsUsername: 'someone' },
			undefined,
			fetchImpl,
			{
				checkpoint: (state) => {
					checkpoints.push([...state.segmentIds]);
				}
			}
		);
		expect(checkpoints).toEqual([['media-1'], ['media-1', 'media-2']]);
	});

	it('attaches reply_to_id to media segments and keeps carousel children clean', async () => {
		const containers: Record<string, string>[] = [];
		let nc = 0;
		let np = 0;
		const fetchImpl = mockFetch({
			'/threads_publish': async () => {
				np += 1;
				return Response.json({ id: `media-${np}` });
			},
			'fields=status': async () => Response.json({ status: 'FINISHED' }),
			'/threads': async (req) => {
				containers.push(formParams(await req.text()));
				nc += 1;
				return Response.json({ id: `c-${nc}` });
			}
		});
		const result = await threadsProvider.publish(
			{
				text: 'first',
				thread: [
					{ text: 'first' },
					{
						text: 'gallery reply',
						media: [
							{ storageKey: 'k1', mime: 'image/jpeg', size: 100 },
							{ storageKey: 'k2', mime: 'image/png', size: 100 }
						]
					}
				]
			},
			{ accessToken: 'tok', threadsUserId: '123' },
			undefined,
			fetchImpl,
			{ mediaUrlFor: (key: string) => `https://cdn.test/${key}` }
		);
		expect(result.segmentIds).toEqual(['media-1', 'media-2']);
		// 1 TEXT container + 2 carousel children + 1 CAROUSEL parent.
		expect(containers).toHaveLength(4);
		expect(containers[1].is_carousel_item).toBe('true');
		expect(containers[1].reply_to_id).toBeUndefined();
		expect(containers[2].is_carousel_item).toBe('true');
		expect(containers[2].reply_to_id).toBeUndefined();
		expect(containers[3].media_type).toBe('CAROUSEL');
		expect(containers[3].reply_to_id).toBe('media-1');
		expect(containers[3].text).toBe('gallery reply');
	});

	it('resumes after the last published segment', async () => {
		const containers: Record<string, string>[] = [];
		const fetchImpl = mockFetch({
			'fields=permalink': async () =>
				Response.json({ permalink: 'https://www.threads.com/@someone/post/DdHkaqrEruo' }),
			'/threads_publish': async () => Response.json({ id: 'media-2' }),
			'/threads': async (req) => {
				containers.push(formParams(await req.text()));
				return Response.json({ id: 'c-9' });
			}
		});
		const result = await threadsProvider.publish(
			{ text: 'first', thread: [{ text: 'first' }, { text: 'second' }] },
			{ accessToken: 'tok', threadsUserId: '123', threadsUsername: 'someone' },
			undefined,
			fetchImpl,
			{
				resume: {
					segmentIds: ['media-1'],
					remoteUrl: 'https://www.threads.com/@someone/post/DdHkaqrEruo'
				}
			}
		);
		expect(containers).toHaveLength(1);
		expect(containers[0].text).toBe('second');
		expect(containers[0].reply_to_id).toBe('media-1');
		expect(result.remotePostId).toBe('media-1');
		expect(result.segmentIds).toEqual(['media-1', 'media-2']);
		expect(result.remoteUrl).toBe('https://www.threads.com/@someone/post/DdHkaqrEruo');
	});

	it('publishes once the container status is FINISHED', async () => {
		const fetchImpl = mockFetch({
			'fields=status': async () => Response.json({ status: 'FINISHED', id: 'c-1' }),
			'/threads_publish': async () => Response.json({ id: 'media-1' }),
			'/threads': async () => Response.json({ id: 'c-1' })
		});
		const result = await threadsProvider.publish(
			{ text: 'hi' },
			{ accessToken: 'tok', threadsUserId: '123' },
			undefined,
			fetchImpl
		);
		expect(result.remotePostId).toBe('media-1');
	});

	it('waits while the container is IN_PROGRESS, then publishes', async () => {
		let polls = 0;
		const fetchImpl = mockFetch({
			'fields=status': async () => {
				polls += 1;
				if (polls < 2) return Response.json({ status: 'IN_PROGRESS', id: 'c-1' });
				return Response.json({ status: 'FINISHED', id: 'c-1' });
			},
			'/threads_publish': async () => Response.json({ id: 'media-1' }),
			'/threads': async () => Response.json({ id: 'c-1' })
		});
		const result = await threadsProvider.publish(
			{ text: 'hi' },
			{ accessToken: 'tok', threadsUserId: '123' },
			undefined,
			fetchImpl
		);
		expect(result.remotePostId).toBe('media-1');
		expect(polls).toBe(2);
	});

	it('surfaces container processing errors without partial progress', async () => {
		const fetchImpl = mockFetch({
			'fields=status': async () =>
				Response.json({ status: 'ERROR', id: 'c-1', error_message: 'FAILED_PROCESSING' }),
			'/threads_publish': async () => Response.json({ id: 'media-1' }),
			'/threads': async () => Response.json({ id: 'c-1' })
		});
		await expect(
			threadsProvider.publish(
				{ text: 'hi' },
				{ accessToken: 'tok', threadsUserId: '123' },
				undefined,
				fetchImpl
			)
		).rejects.toThrow(/container error/);
	});

	it('throws partial progress when a later segment fails', async () => {
		let np = 0;
		const fetchImpl = mockFetch({
			'/threads_publish': async () => {
				np += 1;
				if (np > 1) return new Response('boom', { status: 500 });
				return Response.json({ id: 'media-1' });
			},
			'/threads': async () => Response.json({ id: `c-${np + 1}` })
		});
		try {
			await threadsProvider.publish(
				{ text: 'first', thread: [{ text: 'first' }, { text: 'second' }] },
				{ accessToken: 'tok', threadsUserId: '123' },
				undefined,
				fetchImpl
			);
			expect.unreachable('second segment should fail');
		} catch (err) {
			expect(err).toBeInstanceOf(PublishPartialError);
			expect((err as PublishPartialError).segmentIds).toEqual(['media-1']);
		}
	});
});

describe('threadsUpstreamError', () => {
	const permissionBody = JSON.stringify({
		error: {
			message:
				"Unsupported post request. Object with ID '12345678901234560' does not exist, cannot be loaded due to missing permissions, or does not support this operation",
			type: 'OAuthException',
			code: 200,
			trace_id: 'abc123'
		}
	});

	it('maps Meta permission envelopes to auth and keeps the full body', () => {
		const err = threadsUpstreamError('Threads container', 400, permissionBody);
		expect(err.code).toBe('auth');
		expect(err.status).toBe(400);
		expect(err.retryable).toBe(false);
		expect(err.message).toBe(
			`Threads container failed (400): ${permissionBody.slice(0, 300)} [meta 200]`
		);
		expect(err.detail).toBe(permissionBody);
	});

	it('never maps code-100 envelopes to auth, even with permission boilerplate', () => {
		const body = JSON.stringify({
			error: {
				message:
					"Unsupported post request. Object with ID '1' does not exist, cannot be loaded due to missing permissions, or does not support this operation",
				type: 'THApiException',
				code: 100,
				error_subcode: 33
			}
		});
		const err = threadsUpstreamError('Threads container', 400, body);
		expect(err.code).toBeUndefined();
		expect(err.message).toContain('[meta 100.33]');
		expect(err.detail).toBe(body);
	});

	it('maps permission text without a code, and invalid-token code 190', () => {
		const textOnly = threadsUpstreamError(
			'Threads container',
			400,
			'missing permissions for this object'
		);
		expect(textOnly.code).toBe('auth');
		const invalidToken = threadsUpstreamError(
			'Threads publish',
			400,
			JSON.stringify({ error: { message: 'Invalid OAuth access token', code: 190 } })
		);
		expect(invalidToken.code).toBe('auth');
		expect(invalidToken.message).toContain('[meta 190]');
	});

	it('leaves non-permission 400s unclassified but still captures detail', () => {
		const err = threadsUpstreamError(
			'Threads container',
			400,
			JSON.stringify({ error: { message: 'Invalid parameter', code: 100 } })
		);
		expect(err.code).toBeUndefined();
		expect(err.detail).toContain('Invalid parameter');
		const plain = threadsUpstreamError('Threads container', 400, 'not json at all');
		expect(plain.code).toBeUndefined();
		expect(plain.detail).toBe('not json at all');
	});

	it('preserves 401/403/429 coding from the shared helper', () => {
		expect(threadsUpstreamError('Threads publish', 401, 'expired').code).toBe('auth');
		expect(threadsUpstreamError('Threads publish', 403, 'policy').code).toBe('forbidden');
		expect(threadsUpstreamError('Threads publish', 429, 'slow').code).toBe('rate_limited');
	});
});

describe('threads publish preflight', () => {
	const FULL_GRANTS = ['threads_basic', 'threads_content_publish', 'threads_manage_replies'];

	function preflightFetch(debugBody: unknown, debugStatus = 200, seen: string[] = []): FetchLike {
		return mockFetch({
			debug_token: async () => {
				seen.push('debug');
				return new Response(JSON.stringify(debugBody), { status: debugStatus });
			},
			'/threads_publish': async () => {
				seen.push('publish');
				return Response.json({ id: 'media-1' });
			},
			'/threads': async () => {
				seen.push('container');
				return Response.json({ id: 'c-1' });
			}
		});
	}

	const creds = { accessToken: 'tok', threadsUserId: '123', threadsUsername: 'someone' };

	function debugData(overrides: Record<string, unknown> = {}): unknown {
		return {
			data: {
				is_valid: true,
				user_id: '123',
				scopes: FULL_GRANTS,
				...overrides
			}
		};
	}

	it('rejects invalid tokens before touching containers', async () => {
		const seen: string[] = [];
		await expect(
			threadsProvider.publish(
				{ text: 'hi' },
				creds,
				undefined,
				preflightFetch(debugData({ is_valid: false }), 200, seen)
			)
		).rejects.toThrow(/no longer valid.*reconnect/);
		expect(seen).toEqual(['debug']);
	});

	it('publishes as the user the token belongs to when the stored id is stale', async () => {
		const urls: string[] = [];
		const fetchImpl: FetchLike = async (input) => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			urls.push(url);
			if (url.includes('/me?fields=')) return Response.json({ id: '999', username: 'someone' });
			if (url.includes('debug_token')) return Response.json(debugData({ user_id: '999' }));
			if (url.includes('/threads_publish')) return Response.json({ id: 'media-1' });
			if (url.includes('/threads')) return Response.json({ id: 'c-1' });
			return new Response(`unmocked ${url}`, { status: 404 });
		};
		const result = await threadsProvider.publish({ text: 'hi' }, creds, undefined, fetchImpl);
		expect(result.remotePostId).toBe('media-1');
		// Both calls target the token's own user, never the stale stored id.
		expect(urls.some((u) => u.includes('/999/threads_publish'))).toBe(true);
		expect(urls.some((u) => u.includes('/123/threads'))).toBe(false);
	});

	it('alignCredentials heals a mismatched id and username, else null', async () => {
		const healed = await threadsProvider.alignCredentials?.(
			{ accessToken: 'tok', threadsUserId: '123', threadsUsername: 'old' },
			undefined,
			mockFetch({ '/me?fields=': () => Response.json({ id: '999', username: 'someone' }) })
		);
		expect(healed?.threadsUserId).toBe('999');
		expect(healed?.threadsUsername).toBe('someone');
		const unchanged = await threadsProvider.alignCredentials?.(
			{ accessToken: 'tok', threadsUserId: '999', threadsUsername: 'someone' },
			undefined,
			mockFetch({ '/me?fields=': () => Response.json({ id: '999', username: 'someone' }) })
		);
		expect(unchanged).toBeNull();
		// Lookup unavailable (404) → no healing, never a throw.
		const unavailable = await threadsProvider.alignCredentials?.(
			{ accessToken: 'tok', threadsUserId: '123' },
			undefined,
			mockFetch({})
		);
		expect(unavailable).toBeNull();
	});

	it('names the missing grant and where to enable it', async () => {
		const seen: string[] = [];
		await expect(
			threadsProvider.publish(
				{ text: 'hi' },
				creds,
				undefined,
				preflightFetch(debugData({ scopes: ['threads_basic'] }), 200, seen)
			)
		).rejects.toThrow(/threads_content_publish.*Website permissions.*reconnect/);
		expect(seen).toEqual(['debug']);
	});

	it('requires manage_replies only for multi-segment threads', async () => {
		const withoutReplies = ['threads_basic', 'threads_content_publish'];
		await expect(
			threadsProvider.publish(
				{ text: 'a', thread: [{ text: 'a' }, { text: 'b' }] },
				creds,
				undefined,
				preflightFetch(debugData({ scopes: withoutReplies }))
			)
		).rejects.toThrow(/threads_manage_replies/);
		const seen: string[] = [];
		const result = await threadsProvider.publish(
			{ text: 'hi' },
			creds,
			undefined,
			preflightFetch(debugData({ scopes: withoutReplies }), 200, seen)
		);
		expect(result.remotePostId).toBe('media-1');
		expect(seen).toContain('container');
	});

	it('proceeds when inspection is unavailable or malformed', async () => {
		for (const debug of [
			preflightFetch({}, 400),
			preflightFetch({ data: null }),
			preflightFetch(debugData({ scopes: 'threads_basic' }))
		]) {
			const result = await threadsProvider.publish({ text: 'hi' }, creds, undefined, debug);
			expect(result.remotePostId).toBe('media-1');
		}
	});

	it('proceeds with full grants and matching user', async () => {
		const seen: string[] = [];
		const result = await threadsProvider.publish(
			{ text: 'hi' },
			creds,
			undefined,
			preflightFetch(debugData(), 200, seen)
		);
		expect(result.remotePostId).toBe('media-1');
		expect(seen).toEqual(['debug', 'container', 'publish']);
	});
});

describe('threads media fetch retries', () => {
	const creds = { accessToken: 'tok', threadsUserId: '123', threadsUsername: 'someone' };
	const media = [{ storageKey: 'k1', mime: 'image/png', size: 100 }];

	function preflightHandlers(extra: Record<string, unknown>) {
		return {
			'/me?fields=': () => Response.json({ id: '123', username: 'someone' }),
			debug_token: () =>
				Response.json({
					data: {
						is_valid: true,
						user_id: '123',
						scopes: ['threads_basic', 'threads_content_publish']
					}
				}),
			...extra
		};
	}

	const mediaFetchError = JSON.stringify({
		error: {
			message: 'An unknown error occurred',
			type: 'OAuthException',
			code: 1,
			error_subcode: 2207052,
			error_user_title: "Media download has failed. The media URI doesn't meet our requirements.",
			error_user_msg: 'The media could not be fetched from this URI: https://cdn.test/k1'
		}
	});

	it('retries with a freshly signed URL when Meta cannot fetch the media', async () => {
		const bodies: Record<string, string>[] = [];
		let minted = 0;
		const fetchImpl = mockFetch(
			preflightHandlers({
				'/threads_publish': () => Response.json({ id: 'media-1' }),
				'/threads': async (req: Request) => {
					bodies.push(Object.fromEntries(new URLSearchParams(await req.text())));
					if (bodies.length === 1) return new Response(mediaFetchError, { status: 400 });
					return Response.json({ id: 'c-1' });
				}
			})
		);
		const result = await threadsProvider.publish(
			{ text: 'with image', media },
			creds,
			undefined,
			fetchImpl,
			{
				mediaUrlFor: () => {
					minted += 1;
					return `https://cdn.test/k1?attempt=${minted}`;
				}
			}
		);
		expect(result.remotePostId).toBe('media-1');
		expect(bodies).toHaveLength(2);
		// The retry hands Meta a new link rather than the rejected one.
		expect(bodies[1].image_url).not.toBe(bodies[0].image_url);
		expect(bodies[1].media_type).toBe('IMAGE');
	});

	it('does not retry container failures that are not media downloads', async () => {
		let attempts = 0;
		const fetchImpl = mockFetch(
			preflightHandlers({
				'/threads': async () => {
					attempts += 1;
					return new Response(
						JSON.stringify({
							error: { message: 'Invalid parameter', code: 100, error_subcode: 33 }
						}),
						{ status: 400 }
					);
				}
			})
		);
		await expect(
			threadsProvider.publish({ text: 'with image', media }, creds, undefined, fetchImpl, {
				mediaUrlFor: () => 'https://cdn.test/k1'
			})
		).rejects.toThrow(/Invalid parameter/);
		expect(attempts).toBe(1);
	});
});

describe('linkedin little text and alt text', () => {
	it('escapes every reserved character but keeps hashtags', () => {
		expect(escapeLittleText('Launch (beta) today')).toBe('Launch \\(beta\\) today');
		expect(escapeLittleText('a|b{c}@d[e]<f>*g_h~i\\j')).toBe(
			'a\\|b\\{c\\}\\@d\\[e\\]\\<f\\>\\*g\\_h\\~i\\\\j'
		);
		// `#word` is little's hashtag element: escaping it would kill the tag.
		expect(escapeLittleText('#launch day and #2026')).toBe('#launch day and #2026');
		expect(escapeLittleText('Ship it\n#café')).toBe('Ship it\n#café');
		// A `#` that does not start a word is plain text.
		expect(escapeLittleText('issue #')).toBe('issue \\#');
		expect(escapeLittleText('C# and https://x.test/a#b')).toBe('C\\# and https://x.test/a\\#b');
		expect(escapeLittleText('plain text, nothing reserved.')).toBe('plain text, nothing reserved.');
	});

	it('sends escaped commentary and per-image alt text', async () => {
		const posts: Array<{ commentary: string; content: Record<string, unknown> }> = [];
		let n = 0;
		const fetchImpl = mockFetch({
			'/rest/images?action=initializeUpload': async () => {
				n += 1;
				return Response.json({
					value: { uploadUrl: `https://upload.test/img${n}`, image: `urn:li:image:IMG${n}` }
				});
			},
			'upload.test/img': () => new Response('', { status: 201 }),
			'/rest/posts': async (req) => {
				posts.push(await req.json());
				return new Response('{}', {
					status: 201,
					headers: { 'x-restli-id': 'urn:li:share:1', 'Content-Type': 'application/json' }
				});
			}
		});
		const creds = { accessToken: 'tok', personUrn: 'urn:li:person:abc' };
		const image = (alt?: string) => ({
			bytes: new Uint8Array([1]),
			mime: 'image/png',
			size: 1,
			alt
		});
		await linkedinProvider.publish(
			{ text: 'One (1) image #tag', media: [image('  A red kite  ')] },
			creds,
			undefined,
			fetchImpl
		);
		await linkedinProvider.publish(
			{ text: 'two', media: [image('first'), image()] },
			creds,
			undefined,
			fetchImpl
		);
		expect(posts[0].commentary).toBe('One \\(1\\) image #tag');
		expect(posts[0].content).toEqual({ media: { id: 'urn:li:image:IMG1', altText: 'A red kite' } });
		expect(posts[1].content).toEqual({
			multiImage: {
				images: [{ id: 'urn:li:image:IMG2', altText: 'first' }, { id: 'urn:li:image:IMG3' }]
			}
		});
	});
});

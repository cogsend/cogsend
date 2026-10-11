import { describe, expect, it } from 'vitest';
import { blueskyProvider, mastodonProvider } from '#lib/server/providers/index.js';
import { waitForMastodonMedia } from '#lib/server/providers/mastodon.js';
import type { FetchLike } from '#lib/server/providers/types.js';
import { TID_RE, targetRecordKey } from '#lib/domain/tid.js';

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

describe('blueskyProvider.publish', () => {
	it('publishes text and returns at-uri', async () => {
		const fetchImpl = mockFetch({
			'com.atproto.server.createSession': () =>
				Response.json({
					accessJwt: 'access',
					refreshJwt: 'refresh',
					did: 'did:plc:test',
					handle: 'test.bsky.social'
				}),
			'com.atproto.repo.createRecord': async (req) => {
				const body = await req.json();
				expect(body.collection).toBe('app.bsky.feed.post');
				expect(body.record.text).toBe('Hello bluesky');
				return Response.json({
					uri: 'at://did:plc:test/app.bsky.feed.post/abc123',
					cid: 'cid1'
				});
			}
		});

		const result = await blueskyProvider.publish(
			{ text: 'Hello bluesky' },
			{ handle: 'test.bsky.social', appPassword: 'xxxx-xxxx' },
			undefined,
			fetchImpl
		);
		expect(result.remotePostId).toContain('app.bsky.feed.post');
		expect(result.remoteUrl).toContain('bsky.app/profile');
	});

	it('publishes thread as reply chain', async () => {
		let n = 0;
		const fetchImpl = mockFetch({
			'com.atproto.server.createSession': () =>
				Response.json({
					accessJwt: 'access',
					refreshJwt: 'refresh',
					did: 'did:plc:test',
					handle: 'test.bsky.social'
				}),
			'com.atproto.repo.createRecord': async (req) => {
				n += 1;
				const body = await req.json();
				if (n === 1) expect(body.record.reply).toBeUndefined();
				else expect(body.record.reply.root.uri).toContain('seg1');
				return Response.json({
					uri: `at://did:plc:test/app.bsky.feed.post/seg${n}`,
					cid: `cid${n}`
				});
			}
		});

		const result = await blueskyProvider.publish(
			{ text: 'root', thread: [{ text: 'part 1' }, { text: 'part 2' }, { text: 'part 3' }] },
			{ handle: 'test.bsky.social', appPassword: 'pw' },
			undefined,
			fetchImpl
		);
		expect(result.segmentIds).toHaveLength(3);
		expect(n).toBe(3);
	});
	it('checkpoints every segment with its record cid', async () => {
		const checkpoints: Array<{ segmentIds: string[]; segmentCids?: string[] }> = [];
		let n = 0;
		const fetchImpl = mockFetch({
			'com.atproto.server.createSession': () =>
				Response.json({
					accessJwt: 'a',
					refreshJwt: 'r',
					did: 'did:plc:test',
					handle: 'test.bsky.social'
				}),
			'com.atproto.repo.createRecord': async () => {
				n += 1;
				return Response.json({
					uri: `at://did:plc:test/app.bsky.feed.post/seg${n}`,
					cid: `cid${n}`
				});
			}
		});
		await blueskyProvider.publish(
			{ text: 'root', thread: [{ text: 'a' }, { text: 'b' }] },
			{ handle: 'test.bsky.social', appPassword: 'pw' },
			undefined,
			fetchImpl,
			{
				checkpoint: (state) => {
					checkpoints.push({
						segmentIds: [...state.segmentIds],
						segmentCids: state.segmentCids ? [...state.segmentCids] : undefined
					});
				}
			}
		);
		expect(checkpoints.map((c) => c.segmentIds.length)).toEqual([1, 2]);
		// Resume needs the cids to rebuild the reply chain.
		expect(checkpoints[1].segmentCids).toEqual(['cid1', 'cid2']);
	});

	it('uploads media blob then posts embed', async () => {
		const fetchImpl = mockFetch({
			'com.atproto.server.createSession': () =>
				Response.json({
					accessJwt: 'access',
					refreshJwt: 'refresh',
					did: 'did:plc:test',
					handle: 'test.bsky.social'
				}),
			'com.atproto.repo.uploadBlob': () =>
				Response.json({
					blob: { $type: 'blob', ref: { $link: 'bafyimage' }, mimeType: 'image/png', size: 4 }
				}),
			'com.atproto.repo.createRecord': async (req) => {
				const body = await req.json();
				expect(body.record.embed.$type).toBe('app.bsky.embed.images');
				expect(body.record.embed.images[0].alt).toBe('cat');
				return Response.json({ uri: 'at://did:plc:test/app.bsky.feed.post/img1', cid: 'cid' });
			}
		});

		const result = await blueskyProvider.publish(
			{
				text: 'pic',
				media: [{ bytes: new Uint8Array([1, 2, 3, 4]), mime: 'image/png', alt: 'cat' }]
			},
			{ handle: 'test.bsky.social', appPassword: 'pw' },
			undefined,
			fetchImpl
		);
		expect(result.remotePostId).toContain('img1');
	});
});

describe('mastodonProvider.publish', () => {
	it('publishes status with token', async () => {
		const fetchImpl = mockFetch({
			'/api/v1/statuses': async (req) => {
				const body = await req.json();
				expect(body.status).toBe('Hello masto');
				expect(req.headers.get('Authorization')).toBe('Bearer tok_abc');
				return Response.json({ id: '111', url: 'https://mastodon.test/@user/111' });
			}
		});
		const result = await mastodonProvider.publish(
			{ text: 'Hello masto' },
			{ accessToken: 'tok_abc', instanceUrl: 'https://mastodon.test' },
			undefined,
			fetchImpl
		);
		expect(result.remotePostId).toBe('111');
		expect(result.remoteUrl).toContain('111');
	});

	it('posts a poll on the first status only', async () => {
		const bodies: unknown[] = [];
		const fetchImpl = mockFetch({
			'/api/v1/statuses': async (req) => {
				bodies.push(await req.json());
				return Response.json({ id: 'p1', url: 'https://mastodon.test/@u/p1' });
			}
		});
		const poll = { options: ['yes', 'no'], expiresIn: 3600, multiple: true };
		await mastodonProvider.publish(
			{ text: 'pick', thread: [{ text: 'pick', options: { poll } }, { text: 'more' }] },
			{ accessToken: 't', instanceUrl: 'https://mastodon.test' },
			undefined,
			fetchImpl
		);
		expect(bodies).toHaveLength(2);
		expect((bodies[0] as Record<string, unknown>).poll).toEqual({
			options: ['yes', 'no'],
			expires_in: 3600,
			multiple: true,
			hide_totals: undefined
		});
		expect((bodies[1] as Record<string, unknown>).poll).toBeUndefined();
		expect(
			mastodonProvider.validate({
				text: 'x',
				thread: [{ text: 'x', options: { poll } }],
				options: { poll }
			}).length
		).toBe(0);
		expect(
			mastodonProvider.validate({
				text: 'x',
				media: [{ bytes: new Uint8Array([1]), mime: 'image/png' }],
				options: { poll }
			})[0].code
		).toBe('poll_with_media');
	});

	it('counts the content warning toward the character limit', async () => {
		// Mastodon counts the warning and the body together, so validating the
		// body alone lets a post pass here and fail at the instance.
		const warning = 'w'.repeat(495); // + 'body text' = 505 > 500
		const issues = mastodonProvider.validate(
			{ text: 'body text', options: { spoilerText: warning } },
			{ maxCharacters: 500 }
		);
		expect(issues.map((i) => i.code)).toContain('max_length');
		// Well under the limit with both counted: accepted.
		expect(
			mastodonProvider.validate(
				{ text: 'body text', options: { spoilerText: 'short warning' } },
				{ maxCharacters: 500 }
			)
		).toEqual([]);
	});

	it('threads with in_reply_to_id', async () => {
		const statuses: Array<{ status: string; in_reply_to_id?: string }> = [];
		let id = 0;
		const fetchImpl = mockFetch({
			'/api/v1/statuses': async (req) => {
				const body = await req.json();
				statuses.push(body);
				id += 1;
				return Response.json({ id: String(id), url: `https://mastodon.test/@u/${id}` });
			}
		});
		await mastodonProvider.publish(
			{ text: 't', thread: [{ text: 'a' }, { text: 'b' }] },
			{ accessToken: 't', instanceUrl: 'https://mastodon.test' },
			undefined,
			fetchImpl
		);
		expect(statuses).toHaveLength(2);
		expect(statuses[0].in_reply_to_id).toBeUndefined();
		expect(statuses[1].in_reply_to_id).toBe('1');
	});

	it('resumes a thread from checkpointed segment ids', async () => {
		const statuses: Array<{ status: string; in_reply_to_id?: string }> = [];
		let id = 10;
		const fetchImpl = mockFetch({
			'/api/v1/statuses': async (req) => {
				const body = await req.json();
				statuses.push(body);
				id += 1;
				return Response.json({ id: String(id), url: `https://mastodon.test/@u/${id}` });
			}
		});
		const result = await mastodonProvider.publish(
			{ text: 'a', thread: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] },
			{ accessToken: 't', instanceUrl: 'https://mastodon.test' },
			undefined,
			fetchImpl,
			{ resume: { segmentIds: ['1'], remoteUrl: 'https://mastodon.test/@u/1' } }
		);
		expect(statuses).toHaveLength(2);
		expect(statuses[0].status).toBe('b');
		expect(statuses[0].in_reply_to_id).toBe('1');
		expect(result.segmentIds).toEqual(['1', '11', '12']);
		expect(result.remotePostId).toBe('1');
	});
	it('checkpoints every segment as it lands', async () => {
		const checkpoints: string[][] = [];
		let id = 0;
		const fetchImpl = mockFetch({
			'/api/v1/statuses': async () => {
				id += 1;
				return Response.json({ id: `s${id}`, url: `https://mastodon.test/@u/s${id}` });
			}
		});
		await mastodonProvider.publish(
			{ text: 'a', thread: [{ text: 'a' }, { text: 'b' }] },
			{ accessToken: 't', instanceUrl: 'https://mastodon.test' },
			undefined,
			fetchImpl,
			{
				checkpoint: (state) => {
					checkpoints.push([...state.segmentIds]);
				}
			}
		);
		expect(checkpoints).toEqual([['s1'], ['s1', 's2']]);
	});

	it('partial multi-destination: bluesky ok mastodon fails', async () => {
		const bsky = mockFetch({
			'com.atproto.server.createSession': () =>
				Response.json({
					accessJwt: 'a',
					refreshJwt: 'r',
					did: 'did:plc:x',
					handle: 'x.bsky.social'
				}),
			'com.atproto.repo.createRecord': () =>
				Response.json({ uri: 'at://did:plc:x/app.bsky.feed.post/ok', cid: 'c' })
		});
		const masto = mockFetch({
			'/api/v1/statuses': () => new Response('rate limited', { status: 429 })
		});
		const ok = await blueskyProvider.publish(
			{ text: 'hi' },
			{ handle: 'x.bsky.social', appPassword: 'p' },
			undefined,
			bsky
		);
		expect(ok.remotePostId).toBeTruthy();
		await expect(
			mastodonProvider.publish(
				{ text: 'hi' },
				{ accessToken: 't', instanceUrl: 'https://mastodon.test' },
				undefined,
				masto
			)
		).rejects.toThrow(/429/);
	});
});

describe('mastodon async media processing', () => {
	it('waits for a 202 upload to finish before creating the status', async () => {
		const order: string[] = [];
		const fetchImpl = mockFetch({
			'/api/v2/media': async () => {
				order.push('upload');
				return Response.json({ id: 'm-1', url: null }, { status: 202 });
			},
			'/api/v1/media/m-1': async () => {
				order.push('poll');
				return Response.json({ id: 'm-1', url: 'https://mastodon.test/media/m-1' });
			},
			'/api/v1/statuses': async () => {
				order.push('status');
				return Response.json({ id: 's-1', url: 'https://mastodon.test/@u/s-1' });
			}
		});
		const result = await mastodonProvider.publish(
			{ text: 'pic', media: [{ bytes: new Uint8Array([1]), mime: 'image/png' }] },
			{ accessToken: 't', instanceUrl: 'https://mastodon.test' },
			undefined,
			fetchImpl
		);
		// The status must not reference an id Mastodon has not finished.
		expect(order).toEqual(['upload', 'poll', 'status']);
		expect(result.remotePostId).toBe('s-1');
	});

	it('does not poll when the upload is processed synchronously', async () => {
		const order: string[] = [];
		const fetchImpl = mockFetch({
			'/api/v2/media': async () => {
				order.push('upload');
				return Response.json({ id: 'm-1', url: 'https://mastodon.test/media/m-1' });
			},
			'/api/v1/statuses': async () => {
				order.push('status');
				return Response.json({ id: 's-1', url: 'https://mastodon.test/@u/s-1' });
			}
		});
		await mastodonProvider.publish(
			{ text: 'pic', media: [{ bytes: new Uint8Array([1]), mime: 'image/png' }] },
			{ accessToken: 't', instanceUrl: 'https://mastodon.test' },
			undefined,
			fetchImpl
		);
		expect(order).toEqual(['upload', 'status']);
	});

	it('polls past 206 partial responses until the media is ready', async () => {
		let polls = 0;
		const fetchImpl = mockFetch({
			'/api/v1/media/': async () => {
				polls += 1;
				return polls < 3 ? new Response('{}', { status: 206 }) : Response.json({ id: 'm-1' });
			}
		});
		await waitForMastodonMedia('https://mastodon.test', 't', 'm-1', fetchImpl, {
			attempts: 5,
			delayMs: 0
		});
		expect(polls).toBe(3);
	});

	it('gives up after the poll budget and stays retryable', async () => {
		const fetchImpl = mockFetch({
			'/api/v1/media/': async () => new Response('{}', { status: 206 })
		});
		await expect(
			waitForMastodonMedia('https://mastodon.test', 't', 'm-1', fetchImpl, {
				attempts: 2,
				delayMs: 0
			})
		).rejects.toThrow(/still processing/);
	});

	it('surfaces a failed media status check', async () => {
		const fetchImpl = mockFetch({
			'/api/v1/media/': async () => new Response('nope', { status: 500 })
		});
		await expect(
			waitForMastodonMedia('https://mastodon.test', 't', 'm-1', fetchImpl, {
				attempts: 2,
				delayMs: 0
			})
		).rejects.toThrow(/media processing failed \(500\)/);
	});
});

describe('blueskyProvider resume cids', () => {
	const creds = {
		handle: 'x.bsky.social',
		appPassword: 'p',
		accessJwt: 'a',
		refreshJwt: 'r',
		did: 'did:plc:x'
	};
	const thread = { text: 'root', thread: [{ text: 'part 1' }, { text: 'part 2' }] };

	it('reuses checkpointed cids without extra lookups', async () => {
		let getRecordCalls = 0;
		let replySeen: unknown = null;
		const fetchImpl = mockFetch({
			'com.atproto.repo.getRecord': () => {
				getRecordCalls += 1;
				return Response.json({ cid: 'should-not-happen' });
			},
			'com.atproto.repo.createRecord': async (req) => {
				const body = await req.json();
				replySeen = body.record.reply;
				return Response.json({ uri: 'at://did:plc:x/app.bsky.feed.post/seg2', cid: 'cid2' });
			}
		});
		const result = await blueskyProvider.publish(thread, creds, undefined, fetchImpl, {
			resume: {
				segmentIds: ['at://did:plc:x/app.bsky.feed.post/seg1'],
				segmentCids: ['cid1'],
				remoteUrl: null
			}
		});
		expect(getRecordCalls).toBe(0);
		expect(replySeen).toEqual({
			root: { uri: 'at://did:plc:x/app.bsky.feed.post/seg1', cid: 'cid1' },
			parent: { uri: 'at://did:plc:x/app.bsky.feed.post/seg1', cid: 'cid1' }
		});
		expect(result.segmentCids).toEqual(['cid1', 'cid2']);
	});

	it('resolves missing cids via getRecord instead of fabricating them', async () => {
		let replySeen: unknown = null;
		const fetchImpl = mockFetch({
			'com.atproto.repo.getRecord': () => Response.json({ cid: 'real-cid-1' }),
			'com.atproto.repo.createRecord': async (req) => {
				const body = await req.json();
				replySeen = body.record.reply;
				return Response.json({ uri: 'at://did:plc:x/app.bsky.feed.post/seg2', cid: 'cid2' });
			}
		});
		await blueskyProvider.publish(thread, creds, undefined, fetchImpl, {
			resume: { segmentIds: ['at://did:plc:x/app.bsky.feed.post/seg1'], remoteUrl: null }
		});
		expect(replySeen).toEqual({
			root: { uri: 'at://did:plc:x/app.bsky.feed.post/seg1', cid: 'real-cid-1' },
			parent: { uri: 'at://did:plc:x/app.bsky.feed.post/seg1', cid: 'real-cid-1' }
		});
	});
});

describe('sanitizeBlueskyPdsHost', () => {
	it('rejects private hosts and cleartext http in prod', async () => {
		const { sanitizeBlueskyPdsHost } = await import('#lib/server/providers/bluesky.js');
		expect(sanitizeBlueskyPdsHost('https://bsky.social')).toBe('https://bsky.social');
		expect(sanitizeBlueskyPdsHost('bsky.social')).toBe('https://bsky.social');
		expect(() => sanitizeBlueskyPdsHost('http://127.0.0.1:8080')).toThrow(
			/must use https|not allowed/
		);
		expect(() => sanitizeBlueskyPdsHost('http://intranet.local/xrpc')).toThrow(
			/must use https|not allowed/
		);
		expect(() => sanitizeBlueskyPdsHost('https://169.254.169.254/')).toThrow(/not allowed/);
		expect(() => sanitizeBlueskyPdsHost('https://metadata.google.internal/')).toThrow(
			/not allowed/
		);
	});
});

describe('bluesky idempotent record keys', () => {
	const creds = { handle: 'me.bsky.social', appPassword: 'x', did: 'did:plc:me' };
	const session = (extra: Record<string, (req: Request) => Response | Promise<Response>>) =>
		mockFetch({
			'com.atproto.server.createSession': () =>
				Response.json({
					accessJwt: 'a',
					refreshJwt: 'r',
					did: 'did:plc:me',
					handle: 'me.bsky.social'
				}),
			...extra
		});

	it('sends the caller-chosen rkey and turns a duplicate into the published record', async () => {
		// A holder, not a `let`: an assignment inside the fetch callback is not
		// visible to the type checker's flow analysis at the assertion below.
		const captured: { body?: { rkey?: string } } = {};
		const fetchImpl = session({
			'com.atproto.repo.createRecord': async (req) => {
				captured.body = (await req.json()) as { rkey?: string };
				// The shape a PDS answers when the key is already taken: the first
				// attempt's response was lost, but the record is there.
				return new Response(
					JSON.stringify({
						error: 'InvalidRequest',
						message: 'Could not create record: rkey already exists'
					}),
					{ status: 400 }
				);
			},
			'com.atproto.repo.getRecord': () =>
				Response.json({ uri: 'at://did:plc:me/app.bsky.feed.post/key', cid: 'cid-1' })
		});

		const key = targetRecordKey('target-1', Date.UTC(2026, 0, 1), 0);
		const result = await blueskyProvider.publish({ text: 'hello' }, creds, undefined, fetchImpl, {
			// Mastodon's key must not leak into the record key: it is no TID.
			idempotencyKey: (i) => `target-1:${i}`,
			recordKey: (i) => targetRecordKey('target-1', Date.UTC(2026, 0, 1), i)
		});
		expect(captured.body?.rkey).toBe(key);
		expect(captured.body?.rkey).toMatch(TID_RE);
		// Resolved rather than posted twice: the caller records the existing post,
		// with the cid the next reply in a thread would need.
		expect(result.remotePostId).toBe(`at://did:plc:me/app.bsky.feed.post/${key}`);
		expect(result.segmentCids).toEqual(['cid-1']);
	});

	it('recognises its own post behind the generic 500 a PDS answers for a taken key', async () => {
		// The repository layer throws a plain Error for a duplicate key, which
		// the PDS turns into an opaque 500 — the lookup is what tells the two apart.
		const key = targetRecordKey('target-3', Date.UTC(2026, 0, 1), 0);
		let lookups = 0;
		const fetchImpl = session({
			'com.atproto.repo.createRecord': () =>
				new Response(
					JSON.stringify({ error: 'InternalServerError', message: 'Internal Server Error' }),
					{ status: 500 }
				),
			'com.atproto.repo.getRecord': (req) => {
				lookups += 1;
				expect(new URL(req.url).searchParams.get('rkey')).toBe(key);
				return Response.json({ uri: `at://did:plc:me/app.bsky.feed.post/${key}`, cid: 'cid-9' });
			}
		});
		const result = await blueskyProvider.publish({ text: 'hello' }, creds, undefined, fetchImpl, {
			recordKey: (i) => targetRecordKey('target-3', Date.UTC(2026, 0, 1), i)
		});
		expect(lookups).toBe(1);
		expect(result.remotePostId).toBe(`at://did:plc:me/app.bsky.feed.post/${key}`);
		expect(result.segmentCids).toEqual(['cid-9']);
	});

	it('reports a real server error when nothing exists at the key', async () => {
		const fetchImpl = session({
			'com.atproto.repo.createRecord': () => new Response('upstream down', { status: 502 }),
			'com.atproto.repo.getRecord': () =>
				new Response(JSON.stringify({ error: 'RecordNotFound' }), { status: 400 })
		});
		await expect(
			blueskyProvider.publish({ text: 'hello' }, creds, undefined, fetchImpl, {
				recordKey: (i) => targetRecordKey('target-4', Date.UTC(2026, 0, 1), i)
			})
		).rejects.toThrow(/createRecord failed \(502\)/);
	});

	it('still fails loudly when the refusal is not a duplicate', async () => {
		const fetchImpl = session({
			'com.atproto.repo.createRecord': () =>
				new Response(JSON.stringify({ error: 'InvalidRequest', message: 'Bad record' }), {
					status: 400
				})
		});
		await expect(
			blueskyProvider.publish({ text: 'hello' }, creds, undefined, fetchImpl, {
				recordKey: (i) => targetRecordKey('target-2', Date.UTC(2026, 0, 1), i)
			})
		).rejects.toThrow(/createRecord/i);
	});
});

describe('bluesky session refresh', () => {
	const jwt = (exp: number) =>
		`h.${btoa(JSON.stringify({ exp })).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')}.s`;

	it('reads the expiry of an access token', async () => {
		const { jwtExpiryMs } = await import('#lib/server/providers/bluesky.js');
		expect(jwtExpiryMs(jwt(1_900_000_000))).toBe(1_900_000_000_000);
		expect(jwtExpiryMs('not-a-jwt')).toBeNull();
		expect(jwtExpiryMs(undefined)).toBeNull();
		expect(jwtExpiryMs('a.b.c')).toBeNull();
	});

	it('keeps a fresh session and refreshes one about to expire', async () => {
		let refreshes = 0;
		const fetchImpl = mockFetch({
			'com.atproto.server.refreshSession': () => {
				refreshes += 1;
				return Response.json({ accessJwt: 'new', refreshJwt: 'new-r', did: 'did:plc:me' });
			}
		});
		const base = { handle: 'me.bsky.social', appPassword: 'x', did: 'did:plc:me', refreshJwt: 'r' };
		const inAnHour = Math.floor(Date.now() / 1000) + 3600;
		const fresh = { ...base, accessJwt: jwt(inAnHour) };
		expect(await blueskyProvider.refreshIfNeeded!(fresh, fetchImpl)).toBe(fresh);
		expect(refreshes).toBe(0);

		const inAMinute = Math.floor(Date.now() / 1000) + 60;
		const stale = await blueskyProvider.refreshIfNeeded!(
			{ ...base, accessJwt: jwt(inAMinute) },
			fetchImpl
		);
		expect(refreshes).toBe(1);
		expect(stale.accessJwt).toBe('new');

		// An opaque token gets refreshed, as every publish used to.
		await blueskyProvider.refreshIfNeeded!({ ...base, accessJwt: 'opaque' }, fetchImpl);
		expect(refreshes).toBe(2);
	});
});

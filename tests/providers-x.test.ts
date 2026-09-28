import { describe, expect, it } from 'vitest';
import { validateXText, xWeightedLength } from '$lib/domain/validation/text';
import {
	codeChallenge,
	generateCodeVerifier,
	packXPendingSecret,
	unpackXPendingSecret,
	xAuthorizeUrl,
	xExchangeCode,
	xPostUrl,
	xProvider,
	xVerify,
	X_SCOPES
} from '$lib/server/providers/x';
import type { FetchLike } from '$lib/server/providers/types';

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

describe('validateXText', () => {
	it('accepts 280 chars, rejects 281', () => {
		expect(validateXText('a'.repeat(280)).ok).toBe(true);
		const over = validateXText('a'.repeat(281));
		expect(over.ok).toBe(false);
		expect(over.message).toMatch(/280/);
	});

	it('takes a post whose long link X counts as 23', () => {
		const link = `https://example.com/${'path/'.repeat(40)}`;
		const text = `${'a'.repeat(250)} ${link}`;
		expect(text.length).toBeGreaterThan(280);
		expect(validateXText(text).ok).toBe(true);
	});

	it('refuses a CJK post X would refuse, though it is under 280 graphemes', () => {
		const text = '日本語'.repeat(50);
		expect([...text]).toHaveLength(150);
		expect(validateXText(text).ok).toBe(false);
	});
});

describe('xWeightedLength', () => {
	it('counts Latin text and common punctuation as 1', () => {
		expect(xWeightedLength('hello')).toBe(5);
		expect(xWeightedLength('\u2018quoted\u2019 \u2014 dash')).toBe(15);
	});

	it('counts any link as 23 and the punctuation after it as text', () => {
		expect(xWeightedLength('https://example.com/a/very/long/path?with=query')).toBe(23);
		expect(xWeightedLength('https://x.co')).toBe(23);
		expect(xWeightedLength('see https://example.com/page.')).toBe(4 + 23 + 1);
		expect(xWeightedLength('http:// nothing')).toBe(15);
	});

	it('counts CJK and characters outside the light ranges as 2', () => {
		expect(xWeightedLength('日本')).toBe(4);
		expect(xWeightedLength('\u2026')).toBe(2);
	});

	it('counts an emoji as 2 however many code points build it', () => {
		expect(xWeightedLength('\u{1F600}')).toBe(2);
		expect(xWeightedLength('\u{1F468}\u200D\u{1F469}\u200D\u{1F467}')).toBe(2);
		expect(xWeightedLength('\u{1F44D}\u{1F3FD}')).toBe(2);
		expect(xWeightedLength('\u{1F1EE}\u{1F1F3}')).toBe(2);
		expect(xWeightedLength('1\uFE0F\u20E3')).toBe(2);
	});

	it('counts composed and decomposed accents the same', () => {
		expect(xWeightedLength('e\u0301')).toBe(xWeightedLength('\u00e9'));
		expect(xWeightedLength('\u00e9')).toBe(1);
	});
});

describe('xProvider.validate', () => {
	it('rejects empty segment without media', () => {
		expect(xProvider.validate({ text: '   ' }).some((i) => i.code === 'empty')).toBe(true);
	});

	it('rejects over-length segments', () => {
		const issues = xProvider.validate({ text: 'a'.repeat(281) });
		expect(issues.some((i) => i.code === 'max_length')).toBe(true);
	});

	it('rejects more than 4 images', () => {
		const issues = xProvider.validate({
			text: 'hi',
			media: [1, 2, 3, 4, 5].map(() => ({ mime: 'image/png', size: 10 }))
		});
		expect(issues.some((i) => i.code === 'max_images')).toBe(true);
	});

	it('rejects video', () => {
		const issues = xProvider.validate({
			text: 'hi',
			media: [{ mime: 'video/mp4', size: 10 }]
		});
		expect(issues.some((i) => i.code === 'no_video')).toBe(true);
	});

	it('allows a lone GIF, rejects GIF mixes', () => {
		expect(
			xProvider.validate({ text: 'hi', media: [{ mime: 'image/gif', size: 10 }] }).length
		).toBe(0);
		const mixed = xProvider.validate({
			text: 'hi',
			media: [
				{ mime: 'image/gif', size: 10 },
				{ mime: 'image/png', size: 10 }
			]
		});
		expect(mixed.some((i) => i.code === 'gif_with_images')).toBe(true);
		const two = xProvider.validate({
			text: 'hi',
			media: [
				{ mime: 'image/gif', size: 10 },
				{ mime: 'image/gif', size: 10 }
			]
		});
		expect(two.some((i) => i.code === 'max_gifs')).toBe(true);
	});

	it('rejects oversize images and bad mimes', () => {
		const big = xProvider.validate({
			text: 'hi',
			media: [{ mime: 'image/png', size: 6_000_000 }]
		});
		expect(big.some((i) => i.code === 'max_image_bytes')).toBe(true);
		// GIFs get the 15MB cap.
		expect(
			xProvider.validate({ text: 'hi', media: [{ mime: 'image/gif', size: 10_000_000 }] }).length
		).toBe(0);
		const bad = xProvider.validate({
			text: 'hi',
			media: [{ mime: 'image/bmp', size: 10 }]
		});
		expect(bad.some((i) => i.code === 'mime')).toBe(true);
	});

	it('rejects two cashtags', () => {
		const issues = xProvider.validate({ text: 'buy $AAPL and $TSLA now' });
		expect(issues.some((i) => i.code === 'max_cashtags')).toBe(true);
		expect(xProvider.validate({ text: 'buy $AAPL now' }).length).toBe(0);
	});

	it('accepts threads of valid segments', () => {
		expect(xProvider.validate({ text: 'a', thread: [{ text: 'a' }, { text: 'b' }] }).length).toBe(
			0
		);
	});
});

describe('x pkce + pending secret', () => {
	it('generates a valid verifier', () => {
		const v = generateCodeVerifier();
		expect(v.length).toBeGreaterThanOrEqual(43);
		expect(v.length).toBeLessThanOrEqual(128);
		expect(v).toMatch(/^[A-Za-z0-9\-_]+$/);
		expect(generateCodeVerifier()).not.toBe(v);
	});

	it('matches the RFC 7636 S256 construction (verified against node:crypto)', async () => {
		const challenge = await codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
		expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
	});

	it('packs and unpacks the pending secret', () => {
		const packed = packXPendingSecret('app-secret', 'verifier-123');
		expect(unpackXPendingSecret(packed)).toEqual({
			clientSecret: 'app-secret',
			codeVerifier: 'verifier-123'
		});
	});

	it('falls back for legacy plain-secret rows', () => {
		expect(unpackXPendingSecret('just-a-secret')).toEqual({ clientSecret: 'just-a-secret' });
	});
});

describe('xAuthorizeUrl', () => {
	it('builds the authorize url with pkce + scopes', () => {
		const url = new URL(xAuthorizeUrl('CID', 'https://app.test/', 'STATE.abc', 'CHALLENGE'));
		expect(url.origin + url.pathname).toBe('https://x.com/i/oauth2/authorize');
		expect(url.searchParams.get('response_type')).toBe('code');
		expect(url.searchParams.get('client_id')).toBe('CID');
		expect(url.searchParams.get('redirect_uri')).toBe(
			'https://app.test/api/connections/x/callback'
		);
		expect(url.searchParams.get('code_challenge')).toBe('CHALLENGE');
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		const scopes = url.searchParams.get('scope')?.split(' ') ?? [];
		for (const s of X_SCOPES) expect(scopes).toContain(s);
	});
});

describe('xExchangeCode', () => {
	function exchangeFetch() {
		return mockFetch({
			'/2/oauth2/token': async (req) => {
				const body = await req.text();
				expect(body).toContain('grant_type=authorization_code');
				expect(body).toContain('code_verifier=VERIFIER');
				expect(body).toContain('client_id=CID');
				return Response.json({
					access_token: 'at',
					refresh_token: 'rt',
					expires_in: 7200,
					scope: X_SCOPES.join(' ')
				});
			},
			'/2/users/me': () =>
				Response.json({
					data: { id: '42', username: 'someone', name: 'Some One' }
				})
		});
	}

	it('exchanges and resolves the profile', async () => {
		const out = await xExchangeCode(
			{
				clientId: 'CID',
				clientSecret: 'CSEC',
				code: 'CODE',
				codeVerifier: 'VERIFIER',
				appUrl: 'https://app.test'
			},
			exchangeFetch()
		);
		expect(out.accessToken).toBe('at');
		expect(out.refreshToken).toBe('rt');
		expect(out.xUserId).toBe('42');
		expect(out.xUsername).toBe('someone');
		expect(out.handle).toBe('@someone');
		expect(out.displayName).toBe('Some One');
	});

	it('requires a verifier', async () => {
		await expect(
			xExchangeCode(
				{ clientId: 'C', code: 'CODE', codeVerifier: '', appUrl: 'https://app.test' },
				exchangeFetch()
			)
		).rejects.toThrow(/expired/);
	});
});

describe('xVerify', () => {
	it('returns profile info', async () => {
		const fetchImpl = mockFetch({
			'/2/users/me': () =>
				Response.json({ data: { id: '42', username: 'someone', name: 'Some One' } })
		});
		const info = await xVerify({ accessToken: 'at' }, fetchImpl);
		expect(info).toEqual({ displayName: 'Some One', avatarUrl: undefined, handle: '@someone' });
	});
});

describe('xPostUrl', () => {
	it('builds user and fallback links', () => {
		expect(xPostUrl('123', 'someone')).toBe('https://x.com/someone/status/123');
		expect(xPostUrl('123')).toBe('https://x.com/i/status/123');
		expect(xPostUrl('')).toBeNull();
	});
});

describe('xProvider.publish', () => {
	it('posts text-only', async () => {
		const bodies: unknown[] = [];
		const fetchImpl = mockFetch({
			'/2/tweets': async (req) => {
				bodies.push(await req.json());
				expect(req.headers.get('Authorization')).toBe('Bearer tok');
				return Response.json({ data: { id: '111', text: 'Hello X' } }, { status: 201 });
			}
		});
		const result = await xProvider.publish(
			{ text: 'Hello X' },
			{ accessToken: 'tok', xUserId: '42', xUsername: 'someone' },
			undefined,
			fetchImpl
		);
		expect(result.remotePostId).toBe('111');
		expect(result.remoteUrl).toBe('https://x.com/someone/status/111');
		expect(bodies).toEqual([{ text: 'Hello X' }]);
	});

	it('uploads an image then attaches media_ids', async () => {
		const calls: string[] = [];
		const fetchImpl = mockFetch({
			'/2/media/upload/initialize': async (req) => {
				calls.push('init');
				const body = await req.json();
				expect(body.media_category).toBe('tweet_image');
				expect(body.total_bytes).toBe(4);
				return Response.json({ data: { id: '999' } });
			},
			'/2/media/upload/999/append': () => {
				calls.push('append');
				return new Response(null, { status: 204 });
			},
			'/2/media/upload/999/finalize': () => {
				calls.push('finalize');
				return Response.json({ data: { id: '999' } });
			},
			'/2/media/metadata': () => {
				calls.push('metadata');
				return Response.json({}, { status: 200 });
			},
			'/2/tweets': async (req) => {
				calls.push('tweet');
				const body = await req.json();
				expect(body.media).toEqual({ media_ids: ['999'] });
				return Response.json({ data: { id: '222' } }, { status: 201 });
			}
		});
		const result = await xProvider.publish(
			{
				text: 'pic',
				media: [{ bytes: new Uint8Array([1, 2, 3, 4]), mime: 'image/png', alt: 'cat', size: 4 }]
			},
			{ accessToken: 'tok', xUserId: '42', xUsername: 'someone' },
			undefined,
			fetchImpl
		);
		expect(result.remotePostId).toBe('222');
		expect(calls).toEqual(['init', 'append', 'finalize', 'metadata', 'tweet']);
	});

	it('posts a thread as a reply chain', async () => {
		const bodies: Array<Record<string, unknown>> = [];
		let n = 0;
		const fetchImpl = mockFetch({
			'/2/tweets': async (req) => {
				const body = (await req.json()) as Record<string, unknown>;
				bodies.push(body);
				n += 1;
				return Response.json({ data: { id: `t${n}` } }, { status: 201 });
			}
		});
		const result = await xProvider.publish(
			{ text: 'a', thread: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] },
			{ accessToken: 'tok', xUserId: '42' },
			undefined,
			fetchImpl
		);
		expect(result.segmentIds).toEqual(['t1', 't2', 't3']);
		expect(bodies[0].reply).toBeUndefined();
		expect(bodies[1]).toMatchObject({ reply: { in_reply_to_tweet_id: 't1' } });
		expect(bodies[2]).toMatchObject({ reply: { in_reply_to_tweet_id: 't2' } });
		expect(result.remoteUrl).toBe('https://x.com/i/status/t1');
	});
	it('checkpoints every segment as it lands', async () => {
		const checkpoints: string[][] = [];
		let n = 0;
		const fetchImpl = mockFetch({
			'/2/tweets': async () => {
				n += 1;
				return Response.json({ data: { id: `t${n}` } }, { status: 201 });
			}
		});
		await xProvider.publish(
			{ text: 'a', thread: [{ text: 'a' }, { text: 'b' }] },
			{ accessToken: 'tok', xUserId: '42' },
			undefined,
			fetchImpl,
			{
				checkpoint: (state) => {
					checkpoints.push([...state.segmentIds]);
				}
			}
		);
		// A crash after either segment can now resume at the next one instead
		// of re-publishing the whole thread.
		expect(checkpoints).toEqual([['t1'], ['t1', 't2']]);
	});

	it('resumes from checkpointed segments', async () => {
		const texts: string[] = [];
		const fetchImpl = mockFetch({
			'/2/tweets': async (req) => {
				const body = (await req.json()) as { text?: string };
				texts.push(body.text ?? '');
				return Response.json({ data: { id: `n${texts.length}` } }, { status: 201 });
			}
		});
		const result = await xProvider.publish(
			{ text: 'a', thread: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] },
			{ accessToken: 'tok', xUserId: '42' },
			undefined,
			fetchImpl,
			{ resume: { segmentIds: ['t1'], remoteUrl: 'https://x.com/i/status/t1' } }
		);
		expect(texts).toEqual(['b', 'c']);
		expect(result.segmentIds).toEqual(['t1', 'n1', 'n2']);
		expect(result.remotePostId).toBe('t1');
	});
});

describe('xProvider.refreshIfNeeded', () => {
	const fresh = {
		accessToken: 'at',
		refreshToken: 'rt',
		clientId: 'CID',
		expiresAt: Date.now() + 60 * 60 * 1000
	};

	it('keeps fresh tokens without a call', async () => {
		let called = 0;
		const fetchImpl = mockFetch({
			'/2/oauth2/token': () => {
				called += 1;
				return Response.json({ access_token: 'new' });
			}
		});
		const out = await xProvider.refreshIfNeeded!(fresh, fetchImpl);
		expect(out.accessToken).toBe('at');
		expect(called).toBe(0);
	});

	it('refreshes expiring tokens and rotates', async () => {
		const fetchImpl = mockFetch({
			'/2/oauth2/token': async () =>
				Response.json({ access_token: 'new-at', refresh_token: 'new-rt', expires_in: 7200 })
		});
		const out = await xProvider.refreshIfNeeded!(
			{ ...fresh, expiresAt: Date.now() + 60_000 },
			fetchImpl
		);
		expect(out.accessToken).toBe('new-at');
		expect(out.refreshToken).toBe('new-rt');
		expect(out.expiresAt).toBeGreaterThan(Date.now());
	});

	it('throws 401 when refresh is rejected', async () => {
		const fetchImpl = mockFetch({
			'/2/oauth2/token': () => new Response('invalid_grant', { status: 400 })
		});
		await expect(
			xProvider.refreshIfNeeded!({ ...fresh, expiresAt: Date.now() - 1000 }, fetchImpl)
		).rejects.toMatchObject({ status: 401 });
	});
});

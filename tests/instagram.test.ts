import { describe, expect, it } from 'vitest';
import { INSTAGRAM_MAX_ITEMS, instagramMediaProblems } from '#lib/domain/media-limits.js';
import { humanizedCause } from '#lib/domain/human-error.js';
import { validateInstagramText } from '#lib/domain/validation/text.js';
import { videoIssues } from '#lib/domain/video-rules.js';
import {
	instagramExchangeCode,
	instagramProvider,
	instagramUpstreamError,
	instagramVerify,
	PERSONAL_ACCOUNT_MESSAGE
} from '#lib/server/providers/instagram.js';
import {
	PROCESSING_MARK,
	ProviderError,
	type FetchLike,
	type MediaAttachment,
	type NormalizedPost,
	type PlatformProvider,
	type PublishPending
} from '#lib/server/providers/types.js';

type Opts = NonNullable<Parameters<PlatformProvider['publish']>[4]>;
type Handler = (req: Request) => Response | Promise<Response>;

/** Routes by substring, first match wins, and keeps every request. */
function fakeMeta(handlers: Record<string, Handler>) {
	const seen: Request[] = [];
	const fetchImpl: FetchLike = async (input, init) => {
		const url =
			typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		const req = new Request(url, init);
		seen.push(req.clone());
		for (const [key, handler] of Object.entries(handlers)) {
			if (url.includes(key)) return handler(req);
		}
		return new Response(`unmocked ${url}`, { status: 404 });
	};
	return { seen, fetchImpl };
}

const form = async (req: Request) => new URLSearchParams(await req.text());
const json = (body: unknown, status = 200) => Response.json(body, { status });

const photo = (n: number, extra: Partial<MediaAttachment> = {}): MediaAttachment => ({
	storageKey: `p${n}.jpg`,
	mime: 'image/jpeg',
	size: 1000,
	width: 1080,
	height: 1080,
	...extra
});

const reel: MediaAttachment = {
	storageKey: 'v.mp4',
	mime: 'video/mp4',
	size: 5_000_000,
	width: 1080,
	height: 1920,
	video: { durationMs: 20_000, videoCodec: 'avc', fps: 30, faststart: true }
};

const creds = { accessToken: 'tok', igUserId: '1789' };
// Signed URLs, with the variant visible so a test can see which object went.
const opts = (extra: Partial<Opts> = {}): Opts => ({
	mediaUrlFor: (key, variant) => `https://cdn.test/${variant ? `${variant}/` : ''}${key}`,
	// No waiting between status reads: a container not ready on the first read
	// is left to media_publish, or parked.
	timeLeft: () => 0,
	...extra
});

describe('instagramMediaProblems', () => {
	it('asks for a photo or video before anything else', () => {
		expect(instagramMediaProblems([])).toEqual(['Instagram needs a photo or video']);
	});

	it('takes photos, a carousel, or one video, and nothing in between', () => {
		expect(instagramMediaProblems([photo(1)])).toEqual([]);
		expect(
			instagramMediaProblems(Array.from({ length: INSTAGRAM_MAX_ITEMS }, (_, i) => photo(i)))
		).toEqual([]);
		expect(instagramMediaProblems([reel])).toEqual([]);
		expect(instagramMediaProblems([reel, photo(1)])).toContain(
			'Instagram posts a video on its own, as a Reel'
		);
		expect(instagramMediaProblems([reel, reel])).toContain(
			'Instagram posts a video on its own, as a Reel'
		);
		expect(
			instagramMediaProblems(Array.from({ length: INSTAGRAM_MAX_ITEMS + 1 }, (_, i) => photo(i)))
		).toEqual([`Instagram takes up to ${INSTAGRAM_MAX_ITEMS} photos (11 attached)`]);
	});

	it('takes a PNG or WebP only through its JPEG copy, and never a GIF', () => {
		expect(instagramMediaProblems([photo(1, { mime: 'image/png' })])).toEqual([
			'Instagram takes JPEG only — attach this image again, or as a JPEG'
		]);
		expect(instagramMediaProblems([photo(1, { mime: 'image/webp', hasJpegCopy: true })])).toEqual(
			[]
		);
		expect(instagramMediaProblems([photo(1, { mime: 'image/gif', hasJpegCopy: true })])).toEqual([
			"Instagram doesn't take GIFs"
		]);
	});

	it('takes photos from 4:5 tall to 1.91:1 wide, and lets an unknown shape through', () => {
		const shape = (width: number, height: number) =>
			instagramMediaProblems([photo(1, { width, height })]);
		expect(shape(1080, 1350)).toEqual([]);
		expect(shape(1910, 1000)).toEqual([]);
		expect(shape(1080, 1920)).toEqual(['Instagram takes photos from 4:5 tall to 1.91:1 wide']);
		expect(shape(3000, 1000)).toEqual(['Instagram takes photos from 4:5 tall to 1.91:1 wide']);
		expect(instagramMediaProblems([photo(1, { width: undefined, height: undefined })])).toEqual([]);
	});
});

describe('Instagram text and video rules', () => {
	it('caps the caption at 2,200 characters and 30 hashtags', () => {
		expect(validateInstagramText('a'.repeat(2200)).ok).toBe(true);
		expect(validateInstagramText('a'.repeat(2201)).ok).toBe(false);
		const tags = (n: number) => Array.from({ length: n }, (_, i) => `#tag${i}`).join(' ');
		expect(validateInstagramText(tags(30)).ok).toBe(true);
		const over = validateInstagramText(tags(31));
		expect(over.message).toBe('Instagram takes up to 30 hashtags (31 used)');
		// A colour code or a URL fragment is not a hashtag.
		expect(validateInstagramText(`${tags(30)} &#38; https://a.test/#top`).ok).toBe(true);
	});

	it("holds a Reel to Meta's limits", () => {
		const fits = { durationMs: 60_000, width: 1080, height: 1920, size: 50_000_000, fps: 30 };
		expect(videoIssues('instagram', { ...fits, videoCodec: 'avc', faststart: true })).toEqual([]);
		const messages = (facts: object) =>
			videoIssues('instagram', { ...fits, videoCodec: 'avc', faststart: true, ...facts })
				.filter((issue) => issue.level === 'error')
				.map((issue) => issue.message);
		expect(messages({ durationMs: 2_000 }).join()).toMatch(/Instagram/);
		expect(messages({ durationMs: 16 * 60_000 }).join()).toMatch(/Instagram/);
		expect(messages({ size: 301_000_000 }).join()).toMatch(/Instagram/);
		expect(messages({ fps: 20 }).join()).toMatch(/Instagram/);
	});
});

describe('instagramProvider.validate', () => {
	const post = (text: string, media: MediaAttachment[] = []): NormalizedPost => ({ text, media });

	it('refuses a text-only post, which every other platform takes', () => {
		expect(instagramProvider.validate(post('hello')).map((i) => i.message)).toEqual([
			'Instagram needs a photo or video'
		]);
	});

	it('judges the thread as the one post it becomes', () => {
		const thread: NormalizedPost = {
			text: 'one',
			media: [photo(1)],
			thread: [
				{ text: 'one', media: [photo(1)] },
				{ text: 'two', media: [photo(2, { mime: 'image/png', hasJpegCopy: true })] }
			]
		};
		expect(instagramProvider.validate(thread)).toEqual([]);
		const split: NormalizedPost = {
			text: 'one',
			thread: [{ text: 'one' }, { text: 'two', media: [photo(2)] }]
		};
		expect(instagramProvider.validate(split)).toEqual([]);
	});

	it('refuses a JPEG over 8MB', () => {
		expect(
			instagramProvider.validate(post('hi', [photo(1, { size: 9_000_000 })])).map((i) => i.message)
		).toEqual(["An image is over Instagram's 8MB limit"]);
	});
});

describe('instagramProvider.publish', () => {
	it('posts one photo, sending the JPEG copy of a PNG with its alt text and the caption', async () => {
		const { seen, fetchImpl } = fakeMeta({
			'/1789/media_publish': () => json({ id: 'post-1' }),
			'/1789/media': () => json({ id: 'c1' }),
			'/c1?fields=status_code': () => json({ status_code: 'FINISHED' }),
			'/post-1?fields=permalink': () => json({ permalink: 'https://www.instagram.com/p/abc/' })
		});
		const result = await instagramProvider.publish(
			{
				text: 'first',
				media: [
					photo(1, { mime: 'image/png', storageKey: 'p1.png', hasJpegCopy: true, alt: 'a cat' })
				],
				thread: [
					{
						text: 'first',
						media: [
							photo(1, { mime: 'image/png', storageKey: 'p1.png', hasJpegCopy: true, alt: 'a cat' })
						]
					},
					{ text: 'second' }
				]
			},
			creds,
			undefined,
			fetchImpl,
			opts()
		);
		expect(result).toEqual({
			remotePostId: 'post-1',
			remoteUrl: 'https://www.instagram.com/p/abc/'
		});
		const create = await form(seen.find((r) => r.url.endsWith('/1789/media'))!);
		expect(create.get('image_url')).toBe('https://cdn.test/jpeg/p1.png');
		expect(create.get('alt_text')).toBe('a cat');
		expect(create.get('caption')).toBe('first\n\nsecond');
		expect(create.get('access_token')).toBe('tok');
		const publish = await form(seen.find((r) => r.url.endsWith('/media_publish'))!);
		expect(publish.get('creation_id')).toBe('c1');
	});

	it('makes a carousel only once every photo in it is ready', async () => {
		let created = 0;
		const order: string[] = [];
		const { seen, fetchImpl } = fakeMeta({
			'/1789/media_publish': () => {
				order.push('publish');
				return json({ id: 'post-2' });
			},
			'/1789/media': async (req) => {
				const params = await form(req);
				if (params.get('media_type') === 'CAROUSEL') {
					order.push('parent');
					return json({ id: 'parent' });
				}
				created += 1;
				order.push(`child-${created}`);
				return json({ id: `child-${created}` });
			},
			'?fields=status_code': (req) => {
				order.push(`read-${new URL(req.url).pathname.split('/').pop()}`);
				return json({ status_code: 'FINISHED' });
			},
			'?fields=permalink': () => json({})
		});
		const result = await instagramProvider.publish(
			{ text: 'album', media: [photo(1), photo(2), photo(3)] },
			creds,
			undefined,
			fetchImpl,
			opts()
		);
		expect(result.remotePostId).toBe('post-2');
		expect(order).toEqual([
			'child-1',
			'child-2',
			'child-3',
			'read-child-1',
			'read-child-2',
			'read-child-3',
			'parent',
			'read-parent',
			'publish'
		]);
		const children = await Promise.all(
			seen.filter((r) => r.url.endsWith('/1789/media')).map((r) => form(r))
		);
		expect(children.slice(0, 3).every((c) => c.get('is_carousel_item') === 'true')).toBe(true);
		expect(children.slice(0, 3).every((c) => !c.has('caption'))).toBe(true);
		expect(children[3].get('children')).toBe('child-1,child-2,child-3');
		expect(children[3].get('caption')).toBe('album');
	});

	it('refuses a photo Meta could not take, without publishing anything', async () => {
		const { seen, fetchImpl } = fakeMeta({
			'/1789/media_publish': () => json({ id: 'never' }),
			'/1789/media': () => json({ id: 'c1' }),
			'?fields=status_code': () => json({ status_code: 'ERROR', status: 'Error: bad image' })
		});
		const err = await instagramProvider
			.publish({ text: '', media: [photo(1)] }, creds, undefined, fetchImpl, opts())
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ProviderError);
		expect((err as ProviderError).code).toBe('forbidden');
		expect(seen.some((r) => r.url.includes('media_publish'))).toBe(false);
	});

	it('parks a Reel still processing, then publishes it from the same container', async () => {
		let status = 'IN_PROGRESS';
		const { seen, fetchImpl } = fakeMeta({
			'/1789/media_publish': () => json({ id: 'reel-1' }),
			'/1789/media': () => json({ id: 'rc' }),
			'/rc?fields=status_code': () => json({ status_code: status }),
			'?fields=permalink': () => json({ permalink: 'https://www.instagram.com/reel/xyz/' })
		});
		const first = (await instagramProvider
			.publish(
				{ text: 'clip', media: [{ ...reel, coverKey: 'cover/v.mp4' }] },
				creds,
				undefined,
				fetchImpl,
				opts()
			)
			.catch((e: unknown) => e)) as ProviderError;
		expect(first).toBeInstanceOf(ProviderError);
		expect(first.code).toBe('processing');
		expect(first.message).toContain(PROCESSING_MARK);
		const created = await form(seen.find((r) => r.url.endsWith('/1789/media'))!);
		expect(created.get('media_type')).toBe('REELS');
		expect(created.get('video_url')).toBe('https://cdn.test/v.mp4');
		expect(created.get('cover_url')).toBe('https://cdn.test/cover/v.mp4');
		expect(created.get('share_to_feed')).toBe('true');
		expect(created.get('caption')).toBe('clip');

		status = 'FINISHED';
		const pending: PublishPending = { ...first.pending!, startedAt: Date.now() };
		const done = await instagramProvider.publish(
			{ text: 'clip', media: [reel] },
			creds,
			undefined,
			fetchImpl,
			opts({ resume: { segmentIds: [], pending } })
		);
		expect(done.remotePostId).toBe('reel-1');
		expect(seen.filter((r) => r.url.endsWith('/1789/media'))).toHaveLength(1);
	});

	it('makes a new container for a Reel parked past its expiry', async () => {
		let made = 0;
		const { fetchImpl } = fakeMeta({
			'/1789/media_publish': () => json({ id: 'reel-2' }),
			'/1789/media': () => json({ id: `rc-${++made}` }),
			'/rc-old?fields=status_code': () =>
				json({
					status_code: 'EXPIRED',
					status: 'Expired: the container was not published within 24 hours'
				}),
			'?fields=status_code': () => json({ status_code: 'FINISHED' }),
			'?fields=permalink': () => json({})
		});
		const pending: PublishPending = {
			segment: 0,
			storageKey: 'v.mp4',
			state: { containerId: 'rc-old' },
			startedAt: Date.now()
		};
		const done = await instagramProvider.publish(
			{ text: '', media: [reel] },
			creds,
			undefined,
			fetchImpl,
			opts({ resume: { segmentIds: [], pending } })
		);
		expect(done.remotePostId).toBe('reel-2');
		expect(made).toBe(1);
	});

	it('never publishes twice: a lost answer is unconfirmed, a resumed post is done', async () => {
		const { seen, fetchImpl } = fakeMeta({
			'/1789/media_publish': () => {
				throw new TypeError('connection reset');
			},
			'/1789/media': () => json({ id: 'c1' }),
			'?fields=status_code': () => json({ status_code: 'FINISHED' })
		});
		const err = (await instagramProvider
			.publish({ text: '', media: [photo(1)] }, creds, undefined, fetchImpl, opts())
			.catch((e: unknown) => e)) as ProviderError;
		expect(err.code).toBe('unconfirmed');

		const before = seen.length;
		const resumed = await instagramProvider.publish(
			{ text: '', media: [photo(1)] },
			creds,
			undefined,
			fetchImpl,
			opts({ resume: { segmentIds: ['post-9'], remoteUrl: 'https://www.instagram.com/p/9/' } })
		);
		expect(resumed).toEqual({
			remotePostId: 'post-9',
			remoteUrl: 'https://www.instagram.com/p/9/'
		});
		expect(seen.length).toBe(before);
	});
});

describe('instagramUpstreamError', () => {
	const meta = (code: number, subcode?: number, message = 'nope') =>
		JSON.stringify({ error: { code, error_subcode: subcode, message } });

	it('expires the account only for a dead token', () => {
		expect(instagramUpstreamError('Instagram media', 400, meta(190)).code).toBe('auth');
		// The permissions boilerplate inside an invalid-parameter error is not one.
		const content = instagramUpstreamError(
			'Instagram media',
			400,
			meta(100, 2207009, 'missing permissions or invalid aspect ratio')
		);
		expect(content.code).toBe('forbidden');
	});

	it('waits an hour on the daily limit, and retries what Meta failed to fetch', () => {
		const limit = instagramUpstreamError('Instagram publish', 400, meta(9, 2207042));
		expect(limit.code).toBe('rate_limited');
		expect(limit.retryAfterMs).toBe(60 * 60_000);
		expect(limit.message).toContain("Instagram's limit of 100 posts a day");
		expect(instagramUpstreamError('Instagram media', 400, meta(9004, 2207052)).code).toBe(
			'upstream'
		);
		expect(instagramUpstreamError('Instagram media', 400, meta(9007, 2207027)).code).toBe(
			'upstream'
		);
		expect(instagramUpstreamError('Instagram media', 500, 'oops').code).toBe('upstream');
	});

	it('reads as Instagram, not Threads, to the person', () => {
		const err = instagramUpstreamError('Instagram media', 400, meta(190));
		expect(humanizedCause(err.message)).toMatch(/^Instagram refused/);
	});
});

describe('Instagram tokens and profile', () => {
	it('exchanges the code for a 60-day token and the account it belongs to', async () => {
		const { seen, fetchImpl } = fakeMeta({
			'api.instagram.com/oauth/access_token': () =>
				json({ data: [{ access_token: 'short', user_id: '42', permissions: 'x' }] }),
			'graph.instagram.com/access_token': () =>
				json({ access_token: 'long', expires_in: 5_184_000 }),
			'/me?fields=': () =>
				json({
					user_id: '1789',
					username: 'acme',
					name: 'Acme',
					account_type: 'BUSINESS',
					profile_picture_url: 'https://img.test/a.jpg'
				})
		});
		const got = await instagramExchangeCode(
			{ appId: 'app', appSecret: 'shh', code: 'abc#_', appUrl: 'https://cog.test/' },
			fetchImpl
		);
		expect(got).toMatchObject({
			accessToken: 'long',
			igUserId: '1789',
			igUsername: 'acme',
			handle: '@acme',
			displayName: 'Acme',
			avatarUrl: 'https://img.test/a.jpg',
			maxCharacters: 2200
		});
		expect(got.expiresAt! - Date.now()).toBeGreaterThan(59 * 24 * 60 * 60_000);
		const exchange = await form(seen[0]);
		expect(exchange.get('code')).toBe('abc');
		expect(exchange.get('redirect_uri')).toBe(
			'https://cog.test/api/connections/instagram/callback'
		);
	});

	it('refuses a personal account, which cannot post through the API', async () => {
		const { fetchImpl } = fakeMeta({
			'api.instagram.com/oauth/access_token': () => json({ access_token: 'short' }),
			'graph.instagram.com/access_token': () => json({ access_token: 'long' }),
			'/me?fields=': () => json({ user_id: '1', username: 'me', account_type: 'PERSONAL' })
		});
		await expect(
			instagramExchangeCode(
				{ appId: 'app', appSecret: 'shh', code: 'abc', appUrl: 'https://cog.test' },
				fetchImpl
			)
		).rejects.toThrow(PERSONAL_ACCOUNT_MESSAGE);
	});

	it('renews a token near its end, and expires the account when Meta refuses', async () => {
		const soon = { ...creds, expiresAt: Date.now() + 24 * 60 * 60_000 };
		const fresh = fakeMeta({
			refresh_access_token: () => json({ access_token: 'renewed', expires_in: 5_184_000 })
		});
		const renewed = await instagramProvider.refreshIfNeeded!(soon, fresh.fetchImpl);
		expect(renewed.accessToken).toBe('renewed');
		expect(fresh.seen[0].url).toContain('grant_type=ig_refresh_token');

		const later = { ...creds, expiresAt: Date.now() + 30 * 24 * 60 * 60_000 };
		expect(await instagramProvider.refreshIfNeeded!(later, fresh.fetchImpl)).toBe(later);

		const refused = fakeMeta({
			refresh_access_token: () => json({ error: { code: 190, message: 'expired' } }, 400)
		});
		await expect(instagramProvider.refreshIfNeeded!(soon, refused.fetchImpl)).rejects.toMatchObject(
			{ code: 'auth', status: 401 }
		);
		const throttled = fakeMeta({
			refresh_access_token: () => json({ error: { code: 4, message: 'too many calls' } }, 400)
		});
		expect(await instagramProvider.refreshIfNeeded!(soon, throttled.fetchImpl)).toBe(soon);
		const down = fakeMeta({ refresh_access_token: () => json({}, 503) });
		expect(await instagramProvider.refreshIfNeeded!(soon, down.fetchImpl)).toBe(soon);
	});

	it('reads the posting account from user_id, never the app-scoped id', async () => {
		const wrapped = fakeMeta({
			'/me?fields=': () => json({ data: [{ user_id: '1789', id: 'app-scoped', username: 'acme' }] })
		});
		expect((await instagramVerify(creds, wrapped.fetchImpl)).userId).toBe('1789');
		const appScopedOnly = fakeMeta({
			'/me?fields=': () => json({ id: 'app-scoped', username: 'acme' })
		});
		expect((await instagramVerify(creds, appScopedOnly.fetchImpl)).userId).toBeUndefined();
	});

	it('gives a token Meta rejects the 401 that expires the account', async () => {
		const { fetchImpl } = fakeMeta({
			'/me?fields=': () => json({ error: { code: 190, message: 'Session has expired' } }, 400)
		});
		await expect(instagramVerify(creds, fetchImpl)).rejects.toMatchObject({
			code: 'auth',
			status: 401
		});
	});

	it('verifies the account from its profile', async () => {
		const { fetchImpl } = fakeMeta({
			'/me?fields=': () => json({ user_id: '1789', username: 'acme', name: '' })
		});
		expect(await instagramVerify(creds, fetchImpl)).toMatchObject({
			handle: '@acme',
			displayName: 'acme',
			userId: '1789'
		});
	});
});

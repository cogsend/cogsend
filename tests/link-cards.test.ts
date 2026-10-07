import { describe, expect, it } from 'vitest';
import { blueskyProvider } from '$lib/server/providers/bluesky';
import { linkedinProvider } from '$lib/server/providers/linkedin';
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

const OG_HTML = `<html><head>
<meta property="og:title" content="Example Article" />
<meta property="og:description" content="An example description" />
<meta property="og:image" content="https://example.com/og.png" />
</head></html>`;

const PNG_1x1 = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
	0xde
]);

describe('bluesky link cards', () => {
	it('attaches external embed with OG thumb when no media', async () => {
		let embed: Record<string, unknown> | undefined;
		const fetchImpl = mockFetch({
			'com.atproto.server.createSession': () =>
				Response.json({
					accessJwt: 'a',
					refreshJwt: 'r',
					did: 'did:plc:x',
					handle: 'x.bsky.social'
				}),
			'example.com/article': () =>
				new Response(OG_HTML, { headers: { 'Content-Type': 'text/html' } }),
			'example.com/og.png': () =>
				new Response(PNG_1x1 as unknown as BodyInit, {
					headers: { 'Content-Type': 'image/png' }
				}),
			'com.atproto.repo.uploadBlob': () =>
				Response.json({
					blob: { $type: 'blob', ref: { $link: 'thumb1' }, mimeType: 'image/png', size: 100 }
				}),
			'com.atproto.repo.createRecord': async (req) => {
				const body = await req.json();
				embed = body.record.embed;
				expect(body.record.facets?.length).toBeGreaterThan(0);
				return Response.json({ uri: 'at://did:plc:x/app.bsky.feed.post/1', cid: 'c1' });
			}
		});
		await blueskyProvider.publish(
			{ text: 'read https://example.com/article wow' },
			{ handle: 'x.bsky.social', appPassword: 'p' },
			undefined,
			fetchImpl
		);
		expect(embed?.['$type']).toBe('app.bsky.embed.external');
		const ext = (embed as { external: { uri: string; title: string; thumb?: unknown } }).external;
		expect(ext.uri).toBe('https://example.com/article');
		expect(ext.title).toBe('Example Article');
		expect(ext.thumb).toBeTruthy();
	});

	it('suppresses card when images attached', async () => {
		let embed: Record<string, unknown> | undefined;
		const fetchImpl = mockFetch({
			'com.atproto.server.createSession': () =>
				Response.json({
					accessJwt: 'a',
					refreshJwt: 'r',
					did: 'did:plc:x',
					handle: 'x.bsky.social'
				}),
			'com.atproto.repo.uploadBlob': () =>
				Response.json({
					blob: { $type: 'blob', ref: { $link: 'img' }, mimeType: 'image/png', size: 4 }
				}),
			'com.atproto.repo.createRecord': async (req) => {
				const body = await req.json();
				embed = body.record.embed;
				return Response.json({ uri: 'at://did:plc:x/app.bsky.feed.post/2', cid: 'c2' });
			}
		});
		await blueskyProvider.publish(
			{
				text: 'see https://example.com/article',
				media: [{ bytes: new Uint8Array([1, 2, 3]), mime: 'image/png', width: 800, height: 600 }]
			},
			{ handle: 'x.bsky.social', appPassword: 'p' },
			undefined,
			fetchImpl
		);
		expect(embed?.['$type']).toBe('app.bsky.embed.images');
		const imgs = (embed as { images: Array<{ aspectRatio?: unknown }> }).images;
		expect(imgs[0].aspectRatio).toEqual({ width: 800, height: 600 });
	});

	it('posts text-only when OG fetch fails', async () => {
		let embed: unknown = 'unset';
		const fetchImpl = mockFetch({
			'com.atproto.server.createSession': () =>
				Response.json({
					accessJwt: 'a',
					refreshJwt: 'r',
					did: 'did:plc:x',
					handle: 'x.bsky.social'
				}),
			'com.atproto.repo.createRecord': async (req) => {
				const body = await req.json();
				embed = body.record.embed;
				return Response.json({ uri: 'at://did:plc:x/app.bsky.feed.post/3', cid: 'c3' });
			}
		});
		await blueskyProvider.publish(
			{ text: 'broken https://example.com/missing' },
			{ handle: 'x.bsky.social', appPassword: 'p' },
			undefined,
			fetchImpl
		);
		expect(embed).toBeUndefined();
	});
});

describe('linkedin article cards', () => {
	it('attaches article with thumbnail when no media', async () => {
		let content: Record<string, unknown> | undefined;
		const fetchImpl = mockFetch({
			'example.com/article': () =>
				new Response(OG_HTML, { headers: { 'Content-Type': 'text/html' } }),
			'example.com/og.png': () =>
				new Response(PNG_1x1 as unknown as BodyInit, {
					headers: { 'Content-Type': 'image/png' }
				}),
			'/rest/images?action=initializeUpload': () =>
				Response.json({ value: { uploadUrl: 'https://up.test/i', image: 'urn:li:image:THUMB' } }),
			'up.test/i': () => new Response('', { status: 201 }),
			'/rest/posts': async (req) => {
				const body = await req.json();
				content = body.content;
				return new Response(JSON.stringify({ id: 'urn:li:share:1' }), {
					status: 201,
					headers: { 'x-restli-id': 'urn:li:share:1', 'Content-Type': 'application/json' }
				});
			}
		});
		await linkedinProvider.publish(
			{ text: 'read https://example.com/article' },
			{ accessToken: 'tok', personUrn: 'urn:li:person:abc' },
			undefined,
			fetchImpl
		);
		const article = (content as { article: { source: string; thumbnail?: string } }).article;
		expect(article.source).toBe('https://example.com/article');
		expect(article.thumbnail).toBe('urn:li:image:THUMB');
	});

	it('does not attach article when images present', async () => {
		let content: Record<string, unknown> | undefined;
		const fetchImpl = mockFetch({
			'/rest/images?action=initializeUpload': () =>
				Response.json({ value: { uploadUrl: 'https://up.test/i', image: 'urn:li:image:IMG' } }),
			'up.test/i': () => new Response('', { status: 201 }),
			'/rest/posts': async (req) => {
				const body = await req.json();
				content = body.content;
				return new Response(JSON.stringify({ id: 'urn:li:share:2' }), {
					status: 201,
					headers: { 'x-restli-id': 'urn:li:share:2', 'Content-Type': 'application/json' }
				});
			}
		});
		await linkedinProvider.publish(
			{
				text: 'see https://example.com/article',
				media: [{ bytes: new Uint8Array([1, 2]), mime: 'image/png', size: 2 }]
			},
			{ accessToken: 'tok', personUrn: 'urn:li:person:abc' },
			undefined,
			fetchImpl
		);
		expect((content as { media?: unknown }).media).toBeTruthy();
		expect((content as { article?: unknown }).article).toBeUndefined();
	});
});

describe('bluesky svg thumbs', () => {
	it('keeps card but omits svg thumb', async () => {
		let embed: Record<string, unknown> | undefined;
		let uploads = 0;
		const fetchImpl = mockFetch({
			'com.atproto.server.createSession': () =>
				Response.json({
					accessJwt: 'a',
					refreshJwt: 'r',
					did: 'did:plc:x',
					handle: 'x.bsky.social'
				}),
			'example.com/svgpage': () =>
				new Response(
					`<html><head><meta property="og:title" content="T" /><meta property="og:description" content="D" /><meta property="og:image" content="https://example.com/v.svg" /></head></html>`,
					{ headers: { 'Content-Type': 'text/html' } }
				),
			'example.com/v.svg': () =>
				new Response('<svg></svg>', { headers: { 'Content-Type': 'image/svg+xml' } }),
			'com.atproto.repo.uploadBlob': () => {
				uploads += 1;
				return Response.json({
					blob: { $type: 'blob', ref: { $link: 'x' }, mimeType: 'image/png', size: 1 }
				});
			},
			'com.atproto.repo.createRecord': async (req) => {
				embed = (await req.json()).record.embed;
				return Response.json({ uri: 'at://did:plc:x/app.bsky.feed.post/9', cid: 'c9' });
			}
		});
		await blueskyProvider.publish(
			{ text: 'see https://example.com/svgpage' },
			{ handle: 'x.bsky.social', appPassword: 'p' },
			undefined,
			fetchImpl
		);
		expect(embed?.['$type']).toBe('app.bsky.embed.external');
		const ext = (embed as { external: { thumb?: unknown } }).external;
		expect(ext.thumb).toBeUndefined();
		expect(uploads).toBe(0);
	});
});

describe('X post link cards', () => {
	const POST = 'https://x.com/ada_builds/status/1974452871209381904';
	// x.com gives a server a title and an image but no text; oEmbed has the text.
	const X_PAGE = `<html><head>
<meta property="og:title" content="Ada Builds (@ada_builds) on X" />
<meta property="og:image" content="https://pbs.twimg.com/card_img/1/abc?format=png" />
</head></html>`;
	const OEMBED = {
		author_name: 'Ada Builds',
		author_url: 'https://x.com/ada_builds',
		html: '<blockquote class="twitter-tweet"><p lang="en">Moved my whole posting setup to a Worker. <a href="https://t.co/AbC123">https://t.co/AbC123</a></p>&mdash; Ada Builds (@ada_builds) <a href="https://x.com/ada_builds/status/1974452871209381904">October 4, 2026</a></blockquote>'
	};

	function blueskyFetch(oembed: () => Response, onEmbed: (embed: unknown) => void) {
		return mockFetch({
			'publish.x.com/oembed': oembed,
			'com.atproto.server.createSession': () =>
				Response.json({
					accessJwt: 'a',
					refreshJwt: 'r',
					did: 'did:plc:x',
					handle: 'x.bsky.social'
				}),
			'x.com/ada_builds/status': () =>
				new Response(X_PAGE, { headers: { 'Content-Type': 'text/html' } }),
			'pbs.twimg.com/card_img': () =>
				new Response(PNG_1x1 as unknown as BodyInit, { headers: { 'Content-Type': 'image/png' } }),
			'com.atproto.repo.uploadBlob': () =>
				Response.json({
					blob: { $type: 'blob', ref: { $link: 'thumb1' }, mimeType: 'image/png', size: 100 }
				}),
			'com.atproto.repo.createRecord': async (req) => {
				onEmbed((await req.json()).record.embed);
				return Response.json({ uri: 'at://did:plc:x/app.bsky.feed.post/9', cid: 'c9' });
			}
		});
	}

	it("gives Bluesky the quoted post's author and text, with its image", async () => {
		let embed: unknown;
		await blueskyProvider.publish(
			{ text: `Worth reading.\n${POST}` },
			{ handle: 'x.bsky.social', appPassword: 'p' },
			undefined,
			blueskyFetch(
				() => Response.json(OEMBED),
				(e) => (embed = e)
			)
		);
		const ext = (embed as { external: Record<string, unknown> }).external;
		expect(ext.uri).toBe(POST);
		expect(ext.title).toBe('Ada Builds (@ada_builds)');
		expect(ext.description).toBe('Moved my whole posting setup to a Worker.');
		expect(ext.thumb).toBeTruthy();
	});

	it("keeps the page's own card when X's oEmbed fails", async () => {
		let embed: unknown;
		await blueskyProvider.publish(
			{ text: `Worth reading.\n${POST}` },
			{ handle: 'x.bsky.social', appPassword: 'p' },
			undefined,
			blueskyFetch(
				() => new Response('{}', { status: 500 }),
				(e) => (embed = e)
			)
		);
		const ext = (embed as { external: Record<string, unknown> }).external;
		expect(ext.title).toBe('Ada Builds (@ada_builds) on X');
		expect(ext.thumb).toBeTruthy();
	});

	it("gives LinkedIn the quoted post's author and text", async () => {
		let content: Record<string, unknown> | undefined;
		const fetchImpl = mockFetch({
			'publish.x.com/oembed': () => Response.json(OEMBED),
			'x.com/ada_builds/status': () =>
				new Response(X_PAGE, { headers: { 'Content-Type': 'text/html' } }),
			'pbs.twimg.com/card_img': () =>
				new Response(PNG_1x1 as unknown as BodyInit, { headers: { 'Content-Type': 'image/png' } }),
			'/rest/images?action=initializeUpload': () =>
				Response.json({ value: { uploadUrl: 'https://up.test/i', image: 'urn:li:image:THUMB' } }),
			'up.test/i': () => new Response('', { status: 201 }),
			'/rest/posts': async (req) => {
				content = (await req.json()).content;
				return new Response(JSON.stringify({ id: 'urn:li:share:9' }), {
					status: 201,
					headers: { 'x-restli-id': 'urn:li:share:9', 'Content-Type': 'application/json' }
				});
			}
		});
		await linkedinProvider.publish(
			{ text: `Worth reading.\n${POST}` },
			{ accessToken: 'tok', personUrn: 'urn:li:person:abc' },
			undefined,
			fetchImpl
		);
		const article = (content as { article: Record<string, unknown> }).article;
		expect(article.source).toBe(POST);
		expect(article.title).toBe('Ada Builds (@ada_builds)');
		expect(article.description).toBe('Moved my whole posting setup to a Worker.');
		expect(article.thumbnail).toBe('urn:li:image:THUMB');
	});
});

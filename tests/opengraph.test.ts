import { describe, expect, it } from 'vitest';
import {
	OG_HTML_MAX_BYTES,
	fetchOgImage,
	fetchOpenGraph,
	parseOpenGraphHtml
} from '$lib/server/opengraph';
import type { FetchLike } from '$lib/server/providers/types';

describe('parseOpenGraphHtml', () => {
	it('prefers og: tags over title/description', () => {
		const html = `
			<html><head>
			<title>Fallback</title>
			<meta property="og:title" content="OG Title" />
			<meta property="og:description" content="OG Desc" />
			<meta property="og:image" content="/img/og.png" />
			<meta property="og:site_name" content="Example" />
			</head></html>`;
		const og = parseOpenGraphHtml(html, 'https://example.com/page');
		expect(og.title).toBe('OG Title');
		expect(og.description).toBe('OG Desc');
		expect(og.image).toBe('https://example.com/img/og.png');
		expect(og.siteName).toBe('Example');
	});

	it('falls back to twitter + title tag', () => {
		const html = `<html><head><title>Page Title</title>
			<meta name="twitter:image" content="https://cdn.test/x.jpg" />
			</head></html>`;
		const og = parseOpenGraphHtml(html, 'https://example.com/');
		expect(og.title).toBe('Page Title');
		expect(og.image).toBe('https://cdn.test/x.jpg');
	});

	it('reads only <head> when the page keeps its tags there', () => {
		// Without a closing </head>: the body's opening tag ends the head.
		const html = `<!doctype html><html><head>
			<meta property="og:title" content="The real title" />
			<meta name="description" content="Head description" />
			<body>${'<p>long article</p>'.repeat(5000)}
			<meta property="og:description" content="An embedded widget's tag" />
			</body></html>`;
		const og = parseOpenGraphHtml(html, 'https://example.com/');
		expect(og.title).toBe('The real title');
		expect(og.description).toBe('Head description');
	});

	it('still finds tags a page put in its body', () => {
		const html = `<html><head><title>Head title</title></head><body>
			<meta property="og:description" content="Body description" />
			<meta property="og:image" content="https://cdn.test/body.png" />
			</body></html>`;
		const og = parseOpenGraphHtml(html, 'https://example.com/');
		expect(og.title).toBe('Head title');
		expect(og.description).toBe('Body description');
		expect(og.image).toBe('https://cdn.test/body.png');
	});

	it('rejects blocked/private image hosts', () => {
		const html = `<meta property="og:image" content="http://127.0.0.1/x.png" />`;
		const og = parseOpenGraphHtml(html, 'https://example.com/');
		expect(og.image).toBeNull();
	});

	it('decodes entities and truncates', () => {
		const html = `<meta property="og:title" content="A &amp; B" />`;
		const og = parseOpenGraphHtml(html, 'https://example.com/');
		expect(og.title).toBe('A & B');
	});
});

describe('opengraph hardening', () => {
	it('keeps apostrophes inside double-quoted content', () => {
		const html = `<meta property="og:title" content="Alex's Blog" />`;
		expect(parseOpenGraphHtml(html, 'https://example.com/').title).toBe("Alex's Blog");
		const rev = `<meta content="It's a test" property="og:title" />`;
		expect(parseOpenGraphHtml(rev, 'https://example.com/').title).toBe("It's a test");
	});

	it('rejects invalid URLs with 400, not 500', async () => {
		const dummy: FetchLike = async () => new Response('x', { status: 200 });
		const err = await fetchOpenGraph('not a url', dummy).then(
			() => null,
			(e: unknown) => e as { status?: number }
		);
		expect(err?.status).toBe(400);
	});

	it('refuses an oversized body before buffering it', async () => {
		let read = false;
		// A declared length past the cap: the body must never be touched.
		const huge = (async () =>
			({
				ok: true,
				status: 200,
				headers: new Headers({
					'content-type': 'text/html',
					'content-length': String(OG_HTML_MAX_BYTES + 1)
				}),
				body: {
					getReader: () => {
						read = true;
						return {
							read: async () => ({ done: true, value: undefined }),
							cancel: async () => {}
						};
					}
				},
				arrayBuffer: async () => {
					read = true;
					return new ArrayBuffer(0);
				}
			}) as unknown as Response) as FetchLike;
		const err = await fetchOpenGraph('https://public.test/big', huge).then(
			() => null,
			(e: unknown) => e as { status?: number; message?: string }
		);
		expect(err?.status).toBe(400);
		expect(err?.message).toMatch(/too large/i);
		expect(read).toBe(false);
	});

	it('caps a streamed body that declares no length', async () => {
		const chunk = new Uint8Array(64 * 1024).fill(97);
		let cancelled = false;
		// Endless: only the cap can stop it, so buffering the whole body would
		// hang instead of failing.
		const stream: ReadableStream<Uint8Array> = new ReadableStream({
			pull(controller) {
				controller.enqueue(chunk);
			},
			cancel() {
				cancelled = true;
			}
		});
		const huge: FetchLike = async () =>
			new Response(stream, { status: 200, headers: { 'Content-Type': 'text/html' } });
		const err = await fetchOpenGraph('https://public.test/stream', huge).then(
			() => null,
			(e: unknown) => e as { status?: number; message?: string }
		);
		expect(err?.status).toBe(400);
		expect(err?.message).toMatch(/too large/i);
		expect(cancelled).toBe(true);
	});

	it('blocks redirect chains landing on private hosts', async () => {
		const evil: FetchLike = async (input) => {
			const url = String(input);
			if (url.includes('public.test')) {
				return new Response('', {
					status: 302,
					headers: { location: 'http://169.254.169.254/latest/meta-data/' }
				});
			}
			return new Response('should not be fetched', {
				status: 200,
				headers: { 'Content-Type': 'text/html' }
			});
		};
		const err = await fetchOpenGraph('https://public.test/x', evil).then(
			() => null,
			(e: unknown) => e as { status?: number; message?: string }
		);
		expect(err).toBeTruthy();
		expect([400, 502, 504]).toContain(err?.status);
	});

	it('fetchOgImage refuses private redirect targets', async () => {
		const evil: FetchLike = async (input) => {
			const url = String(input);
			if (url.includes('cdn.test')) {
				return new Response('', {
					status: 302,
					headers: { location: 'http://127.0.0.1/evil.png' }
				});
			}
			return new Response(new Uint8Array([1, 2, 3]) as unknown as BodyInit, {
				headers: { 'Content-Type': 'image/png' }
			});
		};
		expect(await fetchOgImage('https://cdn.test/og.png', evil)).toBeNull();
	});

	it('fetchOgImage caps a streamed image body', async () => {
		const chunk = new Uint8Array(64 * 1024).fill(1);
		let cancelled = false;
		// Endless: only the cap can stop it. Buffering the body would hang here
		// instead of returning null.
		const stream: ReadableStream<Uint8Array> = new ReadableStream({
			pull(controller) {
				controller.enqueue(chunk);
			},
			cancel() {
				cancelled = true;
			}
		});
		const huge: FetchLike = async () =>
			new Response(stream, { status: 200, headers: { 'Content-Type': 'image/png' } });
		expect(await fetchOgImage('https://public.test/huge.png', huge)).toBeNull();
		expect(cancelled).toBe(true);
	});

	it('fetchOgImage gives up on an endless redirect chain', async () => {
		let hops = 0;
		const loop: FetchLike = async () => {
			hops += 1;
			return new Response('', {
				status: 302,
				headers: { location: 'https://public.test/again.png' }
			});
		};
		expect(await fetchOgImage('https://public.test/start.png', loop)).toBeNull();
		// Bounded: the chain is abandoned instead of reading a redirect body.
		expect(hops).toBeLessThanOrEqual(8);
	});
});

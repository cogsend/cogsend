import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET as linkPreviewGET } from '../src/routes/api/link-preview/+server';

/**
 * The one endpoint that makes the Worker fetch a URL the caller chose. The host
 * blocklist is unit-tested; this covers the route around it: the scope gate and
 * the shapes it accepts.
 */
function call(query: string, scopes: string[] | null) {
	return linkPreviewGET({
		url: new URL(`http://localhost/api/link-preview?${query}`),
		locals: {
			user: {
				id: 'u1',
				email: 'preview@localhost',
				timezone: 'UTC',
				totpEnabled: true,
				mfaVerified: true
			},
			apiKeyScopes: scopes
		}
	} as never) as Promise<Response>;
}

describe('GET /api/link-preview', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('refuses a read-scoped key', async () => {
		// Egress needs `write`: a leaked read key must not proxy requests.
		const res = await call('url=https://example.com', ['read']);
		expect(res.status).toBe(403);
	});

	it('requires a url', async () => {
		const res = await call('', ['write']);
		expect(res.status).toBe(400);
	});

	it('refuses a private or blocked host without fetching it', async () => {
		const fetched = vi.fn();
		vi.stubGlobal('fetch', fetched);
		for (const url of [
			'http://127.0.0.1/x',
			'http://169.254.169.254/latest/meta-data/',
			'http://x.internal/'
		]) {
			const res = await call(`url=${encodeURIComponent(url)}`, ['write']);
			expect(res.status).toBeGreaterThanOrEqual(400);
		}
		expect(fetched).not.toHaveBeenCalled();
	});

	it('returns parsed metadata for an allowed host', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						'<html><head><meta property="og:title" content="Hello there"><meta property="og:description" content="A page"></head></html>',
						{ status: 200, headers: { 'Content-Type': 'text/html' } }
					)
			)
		);
		const res = await call('url=example.com%2Fpost', ['write']);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { title?: string; description?: string; url?: string };
		expect(body.title).toBe('Hello there');
		expect(body.description).toBe('A page');
		// A bare paste is completed to https before fetching.
		expect(body.url ?? '').toContain('example.com');
	});

	describe('X post links', () => {
		const xLink = encodeURIComponent('https://x.com/ada_builds/status/1974452871209381904');
		const oembed = {
			author_name: 'Ada Builds',
			author_url: 'https://x.com/ada_builds',
			html: '<blockquote><p>Moved my setup to a Worker.</p>&mdash; Ada <a href="#">October 4, 2026</a></blockquote>'
		};
		const page =
			'<html><head><meta property="og:title" content="Ada Builds (@ada_builds) on X"></head></html>';

		function stub(oembedResponse: () => Response) {
			const fetched = vi.fn(async (input: RequestInfo | URL) => {
				const host = new URL(String(input)).hostname;
				if (host === 'publish.x.com') return oembedResponse();
				return new Response(page, { status: 200, headers: { 'Content-Type': 'text/html' } });
			});
			vi.stubGlobal('fetch', fetched);
			return fetched;
		}
		const hosts = (fetched: ReturnType<typeof vi.fn>) =>
			fetched.mock.calls.map((c) => new URL(String((c as unknown[])[0])).hostname);

		it('returns the post for the quote card', async () => {
			const fetched = stub(() => Response.json(oembed));
			const res = await call(`url=${xLink}`, ['write']);
			expect(res.status).toBe(200);
			const body = (await res.json()) as { xPost?: { name: string; text: string; date: string } };
			expect(body.xPost).toMatchObject({
				name: 'Ada Builds',
				text: 'Moved my setup to a Worker.',
				date: 'October 4, 2026'
			});
			expect(hosts(fetched)).toEqual(['publish.x.com']);
		});

		it('says a deleted post is gone', async () => {
			stub(() => new Response('', { status: 404 }));
			const res = await call(`url=${xLink}`, ['write']);
			expect(res.status).toBe(404);
		});

		it('falls back to the page tags when X fails', async () => {
			const fetched = stub(() => new Response('', { status: 503 }));
			const res = await call(`url=${xLink}`, ['write']);
			expect(res.status).toBe(200);
			const body = (await res.json()) as { title?: string; xPost?: unknown };
			expect(body.title).toBe('Ada Builds (@ada_builds) on X');
			expect(body.xPost).toBeUndefined();
			expect(hosts(fetched)).toEqual(['publish.x.com', 'x.com']);
		});

		it('does not call a post gone when only the fallback page found nothing', async () => {
			// The quote card reads a 404 as a deleted post, so a tagless page must not answer one.
			const fetched = vi.fn(async (input: RequestInfo | URL) => {
				const host = new URL(String(input)).hostname;
				if (host === 'publish.x.com') return new Response('', { status: 503 });
				return new Response('<html><head></head></html>', {
					status: 200,
					headers: { 'Content-Type': 'text/html' }
				});
			});
			vi.stubGlobal('fetch', fetched);
			const res = await call(`url=${xLink}`, ['write']);
			expect(res.status).toBe(502);
		});

		it('never asks X about other links', async () => {
			const fetched = stub(() => Response.json(oembed));
			await call('url=https%3A%2F%2Fexample.com%2Fa%2Fstatus%2F1', ['write']);
			expect(hosts(fetched)).not.toContain('publish.x.com');
		});
	});
});

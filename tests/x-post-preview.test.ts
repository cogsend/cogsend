import { describe, expect, it, vi } from 'vitest';
import { fetchXPostPreview, parseOEmbedHtml } from '$lib/server/x-post-preview';

const LINK = 'https://x.com/XDevelopers/status/2044919377544261979?s=20';

// The shape publish.x.com/oembed returned for this post on 5 Oct 2026.
const OEMBED = {
	url: 'https://x.com/XDevelopers/status/2044919377544261979',
	author_name: 'Developers',
	author_url: 'https://x.com/XDevelopers',
	html: '<blockquote class="twitter-tweet" data-dnt="true"><p lang="en" dir="ltr">API Posting will increase to $0.015 per post from $0.01.<br><br>Quote &amp; follow &lt;removed&gt;. More details: <a href="https://t.co/vdqTnQxJil">https://t.co/vdqTnQxJil</a></p>&mdash; Developers (@XDevelopers) <a href="https://x.com/XDevelopers/status/2044919377544261979?ref_src=twsrc%5Etfw">April 16, 2026</a></blockquote>\n\n',
	width: 550
};

function respond(body: unknown, init: ResponseInit = {}) {
	return vi.fn(
		async () =>
			new Response(typeof body === 'string' ? body : JSON.stringify(body), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
				...init
			})
	);
}

describe('fetchXPostPreview', () => {
	it('asks publish.x.com about the post id, never the pasted host', async () => {
		const fetched = respond(OEMBED);
		await fetchXPostPreview(
			'https://mobile.twitter.com/XDevelopers/status/2044919377544261979',
			fetched
		);
		const requested = new URL(String((fetched.mock.calls[0] as unknown[])[0]));
		expect(requested.origin).toBe('https://publish.x.com');
		expect(requested.pathname).toBe('/oembed');
		expect(requested.searchParams.get('url')).toBe(
			'https://x.com/XDevelopers/status/2044919377544261979'
		);
	});

	it('returns the author, text and date of the post', async () => {
		const preview = await fetchXPostPreview(LINK, respond(OEMBED));
		expect(preview.xPost).toEqual({
			id: '2044919377544261979',
			name: 'Developers',
			handle: 'XDevelopers',
			text: 'API Posting will increase to $0.015 per post from $0.01.\n\nQuote & follow <removed>. More details: https://t.co/vdqTnQxJil',
			date: 'April 16, 2026'
		});
		// The link-card fields still make sense to a client that knows nothing of xPost.
		expect(preview.title).toBe('Developers (@XDevelopers)');
		expect(preview.description).toBe(preview.xPost.text);
		expect(preview.siteName).toBe('X');
		expect(preview.image).toBeNull();
		expect(preview.url).toBe('https://x.com/XDevelopers/status/2044919377544261979');
	});

	it('reports a deleted or protected post as not found', async () => {
		for (const status of [404, 403]) {
			await expect(fetchXPostPreview(LINK, respond('', { status }))).rejects.toMatchObject({
				status: 404
			});
		}
	});

	it('reports anything else X gets wrong as a bad gateway', async () => {
		const cases = [
			respond('', { status: 500 }),
			respond('', { status: 302, headers: { Location: 'https://example.com/' } }),
			respond('not json'),
			respond({ author_name: 'No html' }),
			respond('x'.repeat(300_000)),
			vi.fn(async () => {
				throw new Error('offline');
			})
		];
		for (const fetched of cases) {
			await expect(fetchXPostPreview(LINK, fetched)).rejects.toMatchObject({ status: 502 });
		}
	});

	it('refuses a link that is not an X post without fetching', async () => {
		const fetched = respond(OEMBED);
		await expect(
			fetchXPostPreview('https://example.com/a/status/1', fetched)
		).rejects.toMatchObject({
			status: 400
		});
		expect(fetched).not.toHaveBeenCalled();
	});
});

describe('parseOEmbedHtml', () => {
	it('copes with an embed that has no paragraph or date', () => {
		expect(parseOEmbedHtml('<blockquote></blockquote>')).toEqual({ text: '', date: '' });
	});
});

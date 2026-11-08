import { describe, expect, it } from 'vitest';
import { blueskyRichText, shortenBlueskyUrl } from '#lib/domain/bluesky-links.js';
import { blueskyTextLength, validateBlueskyText } from '#lib/domain/validation/text.js';
import { blueskyProvider } from '#lib/server/providers/bluesky.js';
import { zernioProviderFor } from '#lib/server/providers/zernio.js';
import type { FetchLike } from '#lib/server/providers/types.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The text a facet covers, read the way Bluesky reads it: by UTF-8 byte offsets. */
function facetText(text: string, facet: { index: { byteStart: number; byteEnd: number } }) {
	return decoder.decode(encoder.encode(text).slice(facet.index.byteStart, facet.index.byteEnd));
}

const LONG_LINK =
	'https://example.com/blog/2026/11/a-very-long-article-title-that-goes-on?utm_source=newsletter&utm_medium=email';

describe('shortenBlueskyUrl', () => {
	it('matches the cases in Bluesky’s own app', () => {
		expect(shortenBlueskyUrl('https://bsky.app')).toBe('bsky.app');
		expect(shortenBlueskyUrl('https://bsky.app/3jk7x4irgv52r')).toBe('bsky.app/3jk7x4irgv52r');
		expect(shortenBlueskyUrl('https://bsky.app/3jk7x4irgv52r2313y182h9')).toBe(
			'bsky.app/3jk7x4irgv52...'
		);
		expect(shortenBlueskyUrl('https://very-long-domain-name.com/foo')).toBe(
			'very-long-domain-name.com/foo'
		);
		expect(shortenBlueskyUrl('https://very-long-domain-name.com/foo?bar=baz#andsomemore')).toBe(
			'very-long-domain-name.com/foo?bar=baz#...'
		);
	});

	it('keeps a port, shortens http too, and leaves what it cannot parse', () => {
		expect(shortenBlueskyUrl('http://example.com:8080/a')).toBe('example.com:8080/a');
		expect(shortenBlueskyUrl('http://example.com/0123456789abcdef')).toBe(
			'example.com/0123456789ab...'
		);
		expect(shortenBlueskyUrl('https://')).toBe('https://');
	});

	it('keeps a path of 15 characters and shortens one of 16', () => {
		expect(shortenBlueskyUrl('https://example.com/0123456789abcd')).toBe(
			'example.com/0123456789abcd'
		);
		expect(shortenBlueskyUrl('https://example.com/0123456789abcde')).toBe(
			'example.com/0123456789ab...'
		);
	});
});

describe('blueskyRichText', () => {
	it('posts the short text and links it to the full URL', () => {
		const { text, facets } = blueskyRichText(`read ${LONG_LINK} today`, { links: 'short' });
		expect(text).toBe('read example.com/blog/2026/11... today');
		expect(facets).toEqual([
			{
				index: { byteStart: 5, byteEnd: 5 + 'example.com/blog/2026/11...'.length },
				features: [{ $type: 'app.bsky.richtext.facet#link', uri: LONG_LINK }]
			}
		]);
	});

	it('counts the facet in bytes after an emoji and non-Latin text', () => {
		const { text, facets } = blueskyRichText(`👋🏽 नमस्ते ${LONG_LINK} 🎉`, { links: 'short' });
		expect(facetText(text, facets[0])).toBe('example.com/blog/2026/11...');
		expect(text.endsWith(' 🎉')).toBe(true);
	});

	it('leaves closing punctuation outside the link, and handles several links', () => {
		const { text, facets } = blueskyRichText(
			`(see ${LONG_LINK}). Also https://bsky.app/3jk7x4irgv52r2313y182h9, ok`,
			{ links: 'short' }
		);
		expect(text).toBe('(see example.com/blog/2026/11...). Also bsky.app/3jk7x4irgv52..., ok');
		expect(facets.map((f) => f.features[0].uri)).toEqual([
			LONG_LINK,
			'https://bsky.app/3jk7x4irgv52r2313y182h9'
		]);
		expect(facets.map((f) => facetText(text, f))).toEqual([
			'example.com/blog/2026/11...',
			'bsky.app/3jk7x4irgv52...'
		]);
	});

	it('without shortening, keeps the text and links it as typed', () => {
		const typed = `go ${LONG_LINK} now`;
		const { text, facets } = blueskyRichText(typed, { links: 'full' });
		expect(text).toBe(typed);
		expect(facetText(text, facets[0])).toBe(LONG_LINK);
		expect(facets[0].features[0].uri).toBe(LONG_LINK);
	});

	it('changes nothing in a post without links', () => {
		expect(blueskyRichText('just words 👋', { links: 'short' })).toEqual({
			text: 'just words 👋',
			facets: []
		});
	});
});

describe('Bluesky length with links', () => {
	// 250 characters of text plus the link: over 300 as typed, well under once shortened.
	const post = `${'a'.repeat(250)} ${LONG_LINK}`;

	it('counts a link the way Bluesky’s app posts it', () => {
		expect(blueskyTextLength(post, { links: 'short' })).toBe(
			251 + 'example.com/blog/2026/11...'.length
		);
		expect(validateBlueskyText(post).ok).toBe(true);
		expect(validateBlueskyText(post, { links: 'full' }).ok).toBe(false);
		expect(validateBlueskyText('a'.repeat(301)).ok).toBe(false);
	});

	it('a direct account takes the post, a Zernio account does not', () => {
		expect(blueskyProvider.validate({ text: post })).toEqual([]);
		const zernio = zernioProviderFor('bluesky').validate({ text: post });
		expect(zernio.map((issue) => issue.code)).toEqual(['max_length']);
	});
});

describe('publishing a link to Bluesky', () => {
	it('posts the short text, links the full URL, and cards the full URL', async () => {
		let record: { text: string; facets: unknown; embed?: { external?: { uri: string } } } | null =
			null;
		const fetchImpl: FetchLike = async (input, init) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			if (url.includes('createSession')) {
				return Response.json({ accessJwt: 'a', refreshJwt: 'r', did: 'did:plc:x', handle: 'x' });
			}
			if (url.includes('createRecord')) {
				record = (JSON.parse(String(init?.body)) as { record: NonNullable<typeof record> }).record;
				return Response.json({ uri: 'at://did:plc:x/app.bsky.feed.post/1', cid: 'c1' });
			}
			if (url.startsWith('https://example.com/blog')) {
				return new Response('<meta property="og:title" content="An article">', {
					headers: { 'Content-Type': 'text/html' }
				});
			}
			return new Response('not mocked', { status: 404 });
		};
		await blueskyProvider.publish(
			{ text: `new post: ${LONG_LINK}` },
			{ handle: 'x', appPassword: 'p' },
			undefined,
			fetchImpl
		);
		expect(record).not.toBeNull();
		const posted = record!;
		expect(posted.text).toBe('new post: example.com/blog/2026/11...');
		expect(posted.facets).toEqual([
			{
				index: { byteStart: 10, byteEnd: 10 + 'example.com/blog/2026/11...'.length },
				features: [{ $type: 'app.bsky.richtext.facet#link', uri: LONG_LINK }]
			}
		]);
		expect(posted.embed?.external?.uri).toBe(LONG_LINK);
	});
});

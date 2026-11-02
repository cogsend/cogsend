import { utf8ByteLength } from './bytes';

export type BlueskyLinkFacet = {
	index: { byteStart: number; byteEnd: number };
	features: Array<{ $type: string; uri: string }>;
};

const LINK_RE = /https?:\/\/[^\s]+/gi;
// Trailing punctuation belongs to the sentence (`see this.`), not the link.
const TRAILING_PUNCT_RE = /[.,);:!?]+$/;

/**
 * The text Bluesky's own app posts in place of a link (`toShortUrl` in
 * bluesky-social/social-app): the host and up to 13 characters of the rest.
 * Matching it exactly keeps a post that fits in Bluesky's app fitting here.
 */
export function shortenBlueskyUrl(url: string): string {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return url;
		const path = (parsed.pathname === '/' ? '' : parsed.pathname) + parsed.search + parsed.hash;
		return path.length > 15 ? `${parsed.host}${path.slice(0, 13)}...` : parsed.host + path;
	} catch {
		return url;
	}
}

/**
 * The record text and link facets for a post. Bluesky checks its 300 limit
 * against the record text, so with `shortenLinks` each link is posted short,
 * as Bluesky's app does, and its facet still points at the full URL.
 */
export function blueskyRichText(
	text: string,
	{ shortenLinks }: { shortenLinks: boolean }
): { text: string; facets: BlueskyLinkFacet[] } {
	const facets: BlueskyLinkFacet[] = [];
	let out = '';
	let last = 0;
	for (const match of text.matchAll(LINK_RE)) {
		const url = match[0].replace(TRAILING_PUNCT_RE, '');
		out += text.slice(last, match.index);
		const shown = shortenLinks ? shortenBlueskyUrl(url) : url;
		const byteStart = utf8ByteLength(out);
		out += shown;
		facets.push({
			index: { byteStart, byteEnd: byteStart + utf8ByteLength(shown) },
			features: [{ $type: 'app.bsky.richtext.facet#link', uri: url }]
		});
		last = match.index + url.length;
	}
	return { text: out + text.slice(last), facets };
}

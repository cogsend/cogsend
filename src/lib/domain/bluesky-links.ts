import { utf8ByteLength } from './bytes';
import { isZernioConnection } from './zernio';

export type BlueskyLinkFacet = {
	index: { byteStart: number; byteEnd: number };
	features: Array<{ $type: string; uri: string }>;
};

/**
 * How a link appears in a Bluesky post: `full` as typed (Zernio links the text
 * itself), `short` the way Bluesky's app shows it, `compact` with only the site
 * kept, an account's opt-in for posts with several long links.
 */
export type BlueskyLinkStyle = 'full' | 'short' | 'compact';

const LINK_RE = /https?:\/\/[^\s]+/gi;
// Trailing punctuation belongs to the sentence (`see this.`), not the link.
const TRAILING_PUNCT_RE = /[.,);:!?]+$/;

/**
 * The text Bluesky's own app posts in place of a link (`toShortUrl` in
 * bluesky-social/social-app): the host and up to 13 characters of the rest.
 * Matching it exactly keeps a post that fits in Bluesky's app fitting here.
 * `compact` drops the rest instead, but only where Bluesky's app would cut it,
 * and never the host: the app warns before opening a link whose text names a
 * different site from the one it opens.
 */
export function shortenBlueskyUrl(url: string, style: 'short' | 'compact' = 'short'): string {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return url;
		const path = (parsed.pathname === '/' ? '' : parsed.pathname) + parsed.search + parsed.hash;
		if (path.length <= 15) return parsed.host + path;
		return style === 'compact' ? `${parsed.host}/...` : `${parsed.host}${path.slice(0, 13)}...`;
	} catch {
		return url;
	}
}

/** The style an account's links are posted in, from its connection meta. */
export function blueskyLinkStyleFor(
	meta: { compactLinks?: unknown; provider?: unknown } | null | undefined
): BlueskyLinkStyle {
	if (isZernioConnection(meta)) return 'full';
	return meta?.compactLinks === true ? 'compact' : 'short';
}

/**
 * The style that makes a post longest, for a post going to several accounts:
 * a link never shows longer as `compact` than `short`, nor as `short` than
 * `full`, so a post that fits it fits every account. No accounts counts as
 * Bluesky's own style.
 */
export function longestBlueskyLinkStyle(styles: BlueskyLinkStyle[]): BlueskyLinkStyle {
	if (styles.includes('full')) return 'full';
	if (styles.length && styles.every((style) => style === 'compact')) return 'compact';
	return 'short';
}

/**
 * The record text and link facets for a post. Bluesky checks its 300 limit
 * against the record text, so unless `links` is `full` each link is posted
 * shorter, and its facet still points at the full URL.
 */
export function blueskyRichText(
	text: string,
	{ links }: { links: BlueskyLinkStyle }
): { text: string; facets: BlueskyLinkFacet[] } {
	const facets: BlueskyLinkFacet[] = [];
	let out = '';
	let last = 0;
	for (const match of text.matchAll(LINK_RE)) {
		const url = match[0].replace(TRAILING_PUNCT_RE, '');
		out += text.slice(last, match.index);
		const shown = links === 'full' ? url : shortenBlueskyUrl(url, links);
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

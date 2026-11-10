import { utf8ByteLength } from './bytes';
import { findRichText } from './rich-text';
import { isZernioConnection } from './zernio';

export type BlueskyFacet = {
	index: { byteStart: number; byteEnd: number };
	features: Array<
		| { $type: 'app.bsky.richtext.facet#link'; uri: string }
		| { $type: 'app.bsky.richtext.facet#tag'; tag: string }
		| { $type: 'app.bsky.richtext.facet#mention'; did: string }
	>;
};

/**
 * How a link appears in a Bluesky post: `full` as typed (Zernio links the text
 * itself), `short` the way Bluesky's app shows it, `compact` with only the site
 * kept, an account's opt-in for posts with several long links.
 */
export type BlueskyLinkStyle = 'full' | 'short' | 'compact';

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
 * The record text and facets for a post: its links, hashtags and the mentions
 * `mentions` resolved (handle to DID). Bluesky checks its 300 limit against the
 * record text, so unless `links` is `full` each link is posted shorter, and its
 * facet still points at the full URL. A link typed without `https://` keeps its
 * text, as in Bluesky's app, and a mention nobody resolved stays plain text.
 */
export function blueskyRichText(
	text: string,
	{ links, mentions }: { links: BlueskyLinkStyle; mentions?: ReadonlyMap<string, string> }
): { text: string; facets: BlueskyFacet[] } {
	const facets: BlueskyFacet[] = [];
	let out = '';
	let last = 0;
	for (const entity of findRichText(text)) {
		let feature: BlueskyFacet['features'][number];
		if (entity.type === 'link') {
			feature = { $type: 'app.bsky.richtext.facet#link', uri: entity.uri };
		} else if (entity.type === 'tag') {
			feature = { $type: 'app.bsky.richtext.facet#tag', tag: entity.tag };
		} else {
			const did = mentions?.get(entity.handle);
			if (!did) continue;
			feature = { $type: 'app.bsky.richtext.facet#mention', did };
		}
		const typed = text.slice(entity.start, entity.end);
		const shown =
			entity.type === 'link' && !entity.bare && links !== 'full'
				? shortenBlueskyUrl(entity.uri, links)
				: typed;
		out += text.slice(last, entity.start);
		const byteStart = utf8ByteLength(out);
		out += shown;
		facets.push({
			index: { byteStart, byteEnd: byteStart + utf8ByteLength(shown) },
			features: [feature]
		});
		last = entity.end;
	}
	return { text: out + text.slice(last), facets };
}

/**
 * Mentions looked up per post. Each lookup is a call, and a request on Workers
 * Free gets 50 for everything, so the rest go out as plain text.
 */
export const MAX_MENTION_LOOKUPS = 8;

/** The handles a post mentions, lower-cased and unique, in order. */
export function blueskyMentionHandles(text: string): string[] {
	const handles = findRichText(text).flatMap((e) => (e.type === 'mention' ? [e.handle] : []));
	return [...new Set(handles)];
}

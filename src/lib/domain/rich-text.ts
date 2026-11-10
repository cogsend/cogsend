import TLDS from 'tlds';

/**
 * Links, hashtags and mentions in a post's text, found the way Bluesky's own
 * app finds them (`detectFacets` in bluesky-social/atproto), so a post from
 * here links what the same post written there would. Ranges are UTF-16 indexes
 * into the text.
 *
 * Two deliberate differences: an `http(s)://` link is found anywhere, as this
 * app always has (Bluesky's app needs a space or `(` before it, which would
 * stop linking `"https://…"`), and a bare domain may contain hyphens.
 */
export type RichTextEntity =
	| { type: 'link'; start: number; end: number; uri: string; bare: boolean }
	| { type: 'tag'; start: number; end: number; tag: string }
	| { type: 'mention'; start: number; end: number; handle: string };

const TLD_SET = new Set(TLDS);

const HTTP_LINK_RE = /https?:\/\/[^\s]+/gi;
// No lookbehind anywhere in this file: the composer loads it, and Safari before
// 16.4 cannot parse one. The leading group stands in for it.
const BARE_LINK_RE =
	/(^|\s|\()((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(\S*)/gi;
const MENTION_RE = /(^|\s|\()@([a-zA-Z0-9.-]+)\b/g;
// Bluesky's TAG_REGEX. The joiner and combining marks are each excluded on their own,
// which is what the lint rule takes for a mistake.
const TAG_RE =
	// eslint-disable-next-line no-misleading-character-class
	/(^|\s)[#\uFF03]((?!\uFE0F)[^\s\u00AD\u2060\u200A\u200B\u200C\u200D\u20E2]*[^\d\s\p{P}\u00AD\u2060\u200A\u200B\u200C\u200D\u20E2]+[^\s\u00AD\u2060\u200A\u200B\u200C\u200D\u20E2]*)?/gu;
const TRAILING_PUNCT_RE = /\p{P}+$/u;
const TAG_MAX_GRAPHEMES = 64;

/**
 * Whether `domain` ends in a real top-level domain, as Bluesky's `isValidDomain`.
 * The ending must be typed in lower case, as there: a missing space after a full
 * stop (`ends.It`) is a typo far more often than a link.
 */
export function isValidDomain(domain: string): boolean {
	const dot = domain.lastIndexOf('.');
	if (dot <= 0 || dot === domain.length - 1) return false;
	return TLD_SET.has(domain.slice(dot + 1));
}

/**
 * The end of a link once the sentence's punctuation and a closing quote are
 * left outside it (`see this.`, `"this"`). A `)` stays when it closes a `(` inside the link, as in
 * Wikipedia's `Foo_(bar)`.
 */
function trimLinkEnd(text: string, start: number, end: number): number {
	for (;;) {
		let next = end;
		while (next > start && /[.,;:!?"'”’]/.test(text[next - 1])) next--;
		if (next > start && text[next - 1] === ')') {
			const link = text.slice(start, next);
			const opens = link.split('(').length - 1;
			const closes = link.split(')').length - 1;
			if (closes > opens) next--;
		}
		if (next === end) return end;
		end = next;
	}
}

function graphemeLength(text: string): number {
	try {
		return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].length;
	} catch {
		return [...text].length;
	}
}

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) =>
	a.start < b.end && b.start < a.end;

/** Every link, hashtag and mention in `text`, in order and never overlapping. */
export function findRichText(text: string): RichTextEntity[] {
	if (!text) return [];
	const found: RichTextEntity[] = [];
	const free = (range: { start: number; end: number }) => !found.some((e) => overlaps(e, range));

	for (const match of text.matchAll(HTTP_LINK_RE)) {
		const start = match.index;
		const end = trimLinkEnd(text, start, start + match[0].length);
		if (end > start)
			found.push({ type: 'link', start, end, uri: text.slice(start, end), bare: false });
	}

	for (const match of text.matchAll(BARE_LINK_RE)) {
		const domain = match[2];
		const start = match.index + match[1].length;
		if (!isValidDomain(domain)) continue;
		const end = trimLinkEnd(text, start, start + domain.length + match[3].length);
		const range = { start, end };
		if (end <= start || !free(range)) continue;
		found.push({ type: 'link', ...range, uri: `https://${text.slice(start, end)}`, bare: true });
	}

	for (const match of text.matchAll(MENTION_RE)) {
		const handle = match[2].replace(/[.-]+$/, '');
		if (!isValidDomain(handle)) continue;
		const start = match.index + match[1].length;
		const range = { start, end: start + 1 + handle.length };
		if (!free(range)) continue;
		found.push({ type: 'mention', ...range, handle: handle.toLowerCase() });
	}

	for (const match of text.matchAll(TAG_RE)) {
		const raw = match[2];
		if (!raw) continue;
		const tag = raw.trim().replace(TRAILING_PUNCT_RE, '');
		if (!tag || (tag.length > TAG_MAX_GRAPHEMES && graphemeLength(tag) > TAG_MAX_GRAPHEMES)) {
			continue;
		}
		const start = match.index + match[1].length;
		const range = { start, end: start + 1 + tag.length };
		if (!free(range)) continue;
		found.push({ type: 'tag', ...range, tag });
	}

	return found.sort((a, b) => a.start - b.start);
}

import { utf8ByteLength } from '../bytes';
import { blueskyRichText, type BlueskyLinkStyle } from '../bluesky-links';
import { cleanUrl } from '../links';
import { findRichText } from '../rich-text';
import { splitThreadSegments } from '../thread-segments';

export function countGraphemes(text: string): number {
	if (!text) return 0;
	try {
		const Seg = Intl.Segmenter;
		if (Seg) {
			const seg = new Seg(undefined, { granularity: 'grapheme' });
			return [...seg.segment(text)].length;
		}
	} catch {
		/* fall through */
	}
	return [...text].length;
}

export function mastodonWeightedLength(text: string, options: { urlLength?: number } = {}): number {
	const urlLength = options.urlLength ?? 23;
	if (!text) return 0;
	const re = /https?:\/\/[^\s]+/gi;
	let weighted = 0;
	let lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) !== null) {
		weighted += countGraphemes(text.slice(lastIndex, match.index));
		weighted += urlLength;
		lastIndex = match.index + match[0].length;
	}
	weighted += countGraphemes(text.slice(lastIndex));
	return weighted;
}

function tooLong(length: number, max: number, label: string) {
	return {
		ok: false as const,
		length,
		max,
		message: `${length} / ${max} characters (${label})`
	};
}

/** A Bluesky post's length as Bluesky counts it: on the text actually posted. */
export function blueskyTextLength(text: string, opts: { links: BlueskyLinkStyle }): number {
	return countGraphemes(blueskyRichText(text, opts).text);
}

export function validateBlueskyText(
	text: string,
	{ links = 'short' }: { links?: BlueskyLinkStyle } = {}
): { ok: boolean; length: number; max: number; message?: string } {
	const maxGraphemes = 300;
	const posted = blueskyRichText(text, { links }).text;
	const length = countGraphemes(posted);
	if (length > maxGraphemes) {
		return {
			ok: false,
			length,
			max: maxGraphemes,
			message: `${length} graphemes — over by ${length - maxGraphemes} (max ${maxGraphemes})`
		};
	}
	const bytes = utf8ByteLength(posted);
	if (bytes > 3000) {
		return {
			ok: false,
			length,
			max: maxGraphemes,
			message: `Text exceeds 3000 UTF-8 bytes (${bytes})`
		};
	}
	return { ok: true, length, max: maxGraphemes };
}

/** What an instance counts toward its limit: the content warning, then the post. */
export function mastodonCountedText(text: string, contentWarning?: string | null): string {
	return [contentWarning, text].filter(Boolean).join('\n');
}

export function validateMastodonText(
	text: string,
	maxChars = 500
): { ok: boolean; length: number; max: number; message?: string } {
	const length = mastodonWeightedLength(text);
	if (length > maxChars) {
		return {
			ok: false,
			length,
			max: maxChars,
			message: `${length} / ${maxChars} characters on this instance`
		};
	}
	return { ok: true, length, max: maxChars };
}

/** Threads refuses a post with more distinct links than this. */
export const THREADS_MAX_LINKS = 5;

/** Distinct links in one Threads post, as the publish check counts them. */
export function countThreadsLinks(text: string): number {
	const links = text.match(/https?:\/\/[^\s]+/gi) ?? [];
	return new Set(links.map((l) => l.replace(/[.,);:!?]+$/, '').toLowerCase())).size;
}

/** The most links any one post of a Threads thread has. */
export function mostThreadsLinksInAPost(body: string): number {
	return Math.max(0, ...splitThreadSegments(body).map(countThreadsLinks));
}

export const X_CASHTAG_MESSAGE = 'X allows max 1 cashtag (e.g. $AAPL) per post';

/** Distinct cashtags ($AAPL) in one X post, which takes at most one. */
export function countCashtags(text: string): number {
	const found = text.match(/\$[A-Za-z]{1,6}\b/g) || [];
	return new Set(found.map((t) => t.toUpperCase())).size;
}

/** The most cashtags any one post of an X thread has. */
export function mostCashtagsInAPost(body: string): number {
	return Math.max(0, ...splitThreadSegments(body).map(countCashtags));
}

export const LINKEDIN_MAX_CHARS = 3000;
export const THREADS_MAX_CHARS = 500;
export const INSTAGRAM_MAX_CHARS = 2200;
export const INSTAGRAM_MAX_HASHTAGS = 30;
export const X_MAX_CHARS = 280;

export function validateLinkedinText(
	text: string,
	maxChars = LINKEDIN_MAX_CHARS
): { ok: boolean; length: number; max: number; message?: string } {
	const length = countGraphemes(text);
	if (length > maxChars) return tooLong(length, maxChars, 'LinkedIn max 3000');
	return { ok: true, length, max: maxChars };
}

export function validateThreadsText(
	text: string,
	maxChars = THREADS_MAX_CHARS
): { ok: boolean; length: number; max: number; message?: string } {
	const length = countGraphemes(text);
	if (length > maxChars) return tooLong(length, maxChars, 'Threads max 500');
	return { ok: true, length, max: maxChars };
}

export function validateInstagramText(
	text: string,
	maxChars = INSTAGRAM_MAX_CHARS
): { ok: boolean; length: number; max: number; message?: string } {
	const length = countGraphemes(text);
	if (length > maxChars) return tooLong(length, maxChars, 'Instagram max 2200');
	// A `#` inside a word, a URL fragment or an HTML entity is not a hashtag. No
	// lookbehind: this loads in the composer, and Safari before 16.4 cannot parse one.
	const hashtags = text.match(/(?:^|[^\p{L}\p{N}_&/#])#[\p{L}\p{N}_]+/gu)?.length ?? 0;
	if (hashtags > INSTAGRAM_MAX_HASHTAGS) {
		return {
			ok: false,
			length,
			max: maxChars,
			message: `Instagram takes up to ${INSTAGRAM_MAX_HASHTAGS} hashtags (${hashtags} used)`
		};
	}
	return { ok: true, length, max: maxChars };
}

/** What X counts a link as, however long it is (it is wrapped in t.co). */
export const X_URL_WEIGHT = 23;

/** Code points X counts as 1; everything else is 2 (twitter-text v3 config). */
const X_LIGHT_RANGES: ReadonlyArray<readonly [number, number]> = [
	[0x0000, 0x10ff],
	[0x2000, 0x200d],
	[0x2010, 0x201f],
	[0x2032, 0x2037]
];

const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u;

let xSegmenter: Intl.Segmenter | null | undefined;

function graphemesOf(text: string): string[] {
	if (xSegmenter === undefined) {
		try {
			xSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
		} catch {
			xSegmenter = null;
		}
	}
	return xSegmenter ? [...xSegmenter.segment(text)].map((s) => s.segment) : [...text];
}

function xTextWeight(text: string): number {
	let weight = 0;
	for (const grapheme of graphemesOf(text)) {
		// An emoji is 2 however many code points build it (skin tones, ZWJ families, flags).
		if (EMOJI.test(grapheme)) {
			weight += 2;
			continue;
		}
		for (const char of grapheme) {
			const cp = char.codePointAt(0) ?? 0;
			weight += X_LIGHT_RANGES.some(([start, end]) => cp >= start && cp <= end) ? 1 : 2;
		}
	}
	return weight;
}

/**
 * The length X holds a post to, which is not its grapheme count: a link is 23
 * whatever its length, an emoji is 2, and CJK and most scripts outside Latin
 * are 2 per code point. A grapheme count would block posts with long links that
 * X takes, and pass CJK posts that X refuses at publish.
 *
 * A link typed without a scheme (`example.com`) counts as 23 too, or as typed
 * when longer: X links those for its own list of top-level domains, which is
 * close to but not the same as the one used here, so the count may come out a
 * little over X's and never under it.
 */
export function xWeightedLength(text: string): number {
	if (!text) return 0;
	const normalized = text.normalize('NFC');
	const links: Array<{ start: number; end: number; weight: (typed: string) => number }> = [];
	const re = /https?:\/\/[^\s]+/gi;
	let match: RegExpExecArray | null;
	while ((match = re.exec(normalized)) !== null) {
		// Trailing punctuation ("see this.") belongs to the sentence, not the link.
		const url = cleanUrl(match[0]);
		if (!/^https?:\/\/[^/]/i.test(url)) continue;
		links.push({ start: match.index, end: match.index + url.length, weight: () => X_URL_WEIGHT });
	}
	for (const entity of findRichText(normalized)) {
		if (entity.type !== 'link' || !entity.bare) continue;
		if (links.some((l) => entity.start < l.end && l.start < entity.end)) continue;
		links.push({
			start: entity.start,
			end: entity.end,
			weight: (typed) => Math.max(X_URL_WEIGHT, xTextWeight(typed))
		});
	}
	links.sort((a, b) => a.start - b.start);
	let weight = 0;
	let last = 0;
	for (const link of links) {
		weight +=
			xTextWeight(normalized.slice(last, link.start)) +
			link.weight(normalized.slice(link.start, link.end));
		last = link.end;
	}
	return weight + xTextWeight(normalized.slice(last));
}

export function validateXText(
	text: string,
	maxChars = X_MAX_CHARS
): { ok: boolean; length: number; max: number; message?: string } {
	const length = xWeightedLength(text);
	if (length > maxChars) return tooLong(length, maxChars, `X max ${maxChars}`);
	return { ok: true, length, max: maxChars };
}

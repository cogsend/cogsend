import { utf8ByteLength } from '../bytes';
import { cleanUrl } from '../links';

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

export function validateBlueskyText(
	text: string,
	maxGraphemes = 300
): { ok: boolean; length: number; max: number; message?: string } {
	const length = countGraphemes(text);
	if (length > maxGraphemes) {
		return {
			ok: false,
			length,
			max: maxGraphemes,
			message: `${length} graphemes — over by ${length - maxGraphemes} (max ${maxGraphemes})`
		};
	}
	const bytes = utf8ByteLength(text);
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

export const LINKEDIN_MAX_CHARS = 3000;
export const THREADS_MAX_CHARS = 500;
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
 * A link typed without a scheme (`example.com`) is counted as typed: X only
 * links those for its own list of top-level domains.
 */
export function xWeightedLength(text: string): number {
	if (!text) return 0;
	const normalized = text.normalize('NFC');
	const re = /https?:\/\/[^\s]+/gi;
	let weight = 0;
	let last = 0;
	let match: RegExpExecArray | null;
	while ((match = re.exec(normalized)) !== null) {
		// Trailing punctuation ("see this.") belongs to the sentence, not the link.
		const url = cleanUrl(match[0]);
		if (!/^https?:\/\/[^/]/i.test(url)) continue;
		weight += xTextWeight(normalized.slice(last, match.index)) + X_URL_WEIGHT;
		last = match.index + url.length;
	}
	return weight + xTextWeight(normalized.slice(last));
}

export function validateXText(
	text: string,
	maxChars = X_MAX_CHARS
): { ok: boolean; length: number; max: number; message?: string } {
	const length = xWeightedLength(text);
	if (length > maxChars) return tooLong(length, maxChars, 'X max 280');
	return { ok: true, length, max: maxChars };
}

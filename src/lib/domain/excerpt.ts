/** One-line preview of a draft body for list views. Grapheme-safe. */
// Singleton: constructing Intl.Segmenter per card (N x per search keystroke)
// dominated Posts list renders. One shared instance is safe (stateless read).
let graphemeSegmenter: Intl.Segmenter | null = null;
function getGraphemeSegmenter(): Intl.Segmenter | null {
	if (graphemeSegmenter) return graphemeSegmenter;
	try {
		graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
		return graphemeSegmenter;
	} catch {
		return null;
	}
}
function segmentGraphemes(text: string): string[] {
	const seg = getGraphemeSegmenter();
	if (!seg) {
		// Very old runtimes without Intl.Segmenter: code points (splits ZWJ).
		return [...text];
	}
	return [...seg.segment(text)].map((s) => s.segment);
}

export function draftExcerpt(body: string | null | undefined, max = 120): string {
	// Thread delimiters read as noise in one-line lists: render as a separator.
	const text = (body || '')
		.replace(/\s*---\s*/g, ' · ')
		.replace(/\s+/g, ' ')
		.trim();
	if (!text) return 'Empty draft';
	// Grapheme clusters (not code points): family emoji / flags / skin tones
	// must never split mid-joiner.
	const chars = segmentGraphemes(text);
	if (chars.length <= max) return text;
	return chars.slice(0, max).join('').trimEnd() + '…';
}

/**
 * A post's text for a list card, with its line breaks. A run of blank lines
 * shows as one, and a post of many short lines stops at `maxLines`, which the
 * character cap alone would let grow far taller than a card should.
 */
export function cardExcerpt(text: string | null | undefined, max = 500, maxLines = 8): string {
	const { text: out, cut } = cardExcerptCut(text, max, maxLines);
	return cut ? `${out}…` : out;
}

/** `cardExcerpt` before its "…", and whether anything was cut off. */
export function cardExcerptCut(
	text: string | null | undefined,
	max = 500,
	maxLines = 8
): { text: string; cut: boolean } {
	const body = (text || '')
		.replace(/\r\n?/g, '\n')
		.split('\n')
		.map((line) => line.trimEnd())
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	if (!body) return { text: 'Empty draft', cut: false };
	const lines = body.split('\n');
	let out = lines.length > maxLines ? lines.slice(0, maxLines).join('\n').trimEnd() : body;
	let cut = out !== body;
	const chars = segmentGraphemes(out);
	if (chars.length > max) {
		out = chars.slice(0, max).join('').trimEnd();
		cut = true;
	}
	return { text: out, cut };
}

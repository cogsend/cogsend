import { THREAD_DELIMITER } from './thread-segments';

/**
 * Split pasted text into thread segments that each fit a per-post character
 * cap. Split points, best first: explicit `---` delimiter, blank-line
 * paragraphs, sentence boundaries, then word wraps. A single unbreakable run
 * (URL, CJK without spaces) is hard-sliced at grapheme boundaries.
 *
 * Lossy on purpose about whitespace: joined sentences get single spaces, and
 * a paragraph that fits a post keeps its own post.
 */
export const MAX_AUTO_SEGMENTS = 30;

/** Grapheme iterator with Intl.Segmenter, falling back to code points. */
function graphemes(text: string): string[] {
	try {
		return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(
			(s) => s.segment
		);
	} catch {
		// Old runtimes without Intl.Segmenter: code points (splits ZWJ emoji).
		return [...text];
	}
}

/**
 * Split a paragraph into sentences without breaking URLs, domains or decimals.
 * Only treats `.!?` (with optional closing quotes/brackets) as a boundary when
 * followed by whitespace or end-of-string. No regex lookbehind (Safari < 16.4).
 */
function splitSentences(t: string): string[] {
	const out: string[] = [];
	const len = t.length;
	let start = 0;
	let i = 0;
	while (i < len) {
		const ch = t[i];
		if (ch === '\n') {
			const piece = t.slice(start, i).trim();
			if (piece) out.push(piece);
			i++;
			start = i;
			continue;
		}
		if (ch === '.' || ch === '!' || ch === '?') {
			let end = i + 1;
			while (end < len && (t[end] === '.' || t[end] === '!' || t[end] === '?')) end++;
			while (end < len && (t[end] === '"' || t[end] === "'" || t[end] === ')' || t[end] === ']'))
				end++;
			if (end === len || /\s/.test(t[end])) {
				const piece = t.slice(start, end).trim();
				if (piece) out.push(piece);
				while (end < len && /[ \t]/.test(t[end])) end++;
				start = end;
				i = end;
				continue;
			}
		}
		i++;
	}
	const tail = t.slice(start).trim();
	if (tail) out.push(tail);
	return out.length ? out : [t];
}

function hardSliceByCount(text: string, maxChars: number, count: (s: string) => number): string[] {
	const parts: string[] = [];
	let current = '';
	for (const g of graphemes(text)) {
		if (current && count(current + g) > maxChars) {
			parts.push(current);
			current = g;
		} else {
			current += g;
		}
	}
	if (current) parts.push(current);
	return parts;
}

export function splitLongText(
	text: string,
	maxChars: number,
	count: (s: string) => number
): string[] {
	const trimmed = (text || '').replace(/\r\n/g, '\n').trim();
	if (!trimmed) return [];
	if (count(trimmed) <= maxChars) return [trimmed];

	// 1) An explicit delimiter is user intent — always honor it.
	let blocks = trimmed.includes(THREAD_DELIMITER) ? trimmed.split(THREAD_DELIMITER) : [trimmed];
	// 2) Paragraph breaks are the next best split point.
	blocks = blocks.flatMap((b) => b.split(/\n{2,}/));

	const out: string[] = [];
	let current = '';
	const flush = () => {
		const t = current.trim();
		if (t) out.push(t);
		current = '';
	};

	for (const block of blocks) {
		const t = block.trim();
		if (!t) continue;
		const merged = current ? `${current}\n\n${t}` : t;
		if (count(merged) <= maxChars) {
			current = merged;
			continue;
		}
		flush();
		// Sentence-ish boundaries (newlines act as boundaries too).
		const sentences = splitSentences(t);
		for (const raw of sentences) {
			const sentence = raw.trim();
			if (!sentence) continue;
			const candidate = current ? `${current} ${sentence}` : sentence;
			if (count(candidate) <= maxChars) {
				current = candidate;
				continue;
			}
			flush();
			if (count(sentence) <= maxChars) {
				current = sentence;
				continue;
			}
			// Sentence alone exceeds a post: wrap on words.
			for (const word of sentence.split(/\s+/)) {
				const withWord = current ? `${current} ${word}` : word;
				if (count(withWord) <= maxChars) {
					current = withWord;
					continue;
				}
				flush();
				if (count(word) <= maxChars) {
					current = word;
				} else {
					// One run longer than a whole post (URL/CJK): hard slice.
					const pieces = hardSliceByCount(word, maxChars, count);
					for (let i = 0; i < pieces.length; i++) {
						if (i < pieces.length - 1) out.push(pieces[i]);
						else current = pieces[i];
					}
				}
			}
		}
		flush();
	}
	flush();

	if (!out.length) return [trimmed];
	// Safety valve for pathological pastes: keep everything; the tail post may
	// stay over the cap (the gauge shows it) rather than dropping text.
	if (out.length > MAX_AUTO_SEGMENTS) {
		const head = out.slice(0, MAX_AUTO_SEGMENTS - 1);
		head.push(out.slice(MAX_AUTO_SEGMENTS - 1).join('\n\n'));
		return head;
	}
	return out;
}

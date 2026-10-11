import { describe, expect, it } from 'vitest';
import { countGraphemes } from '#lib/domain/validation/text.js';
import { MAX_AUTO_SEGMENTS, splitLongText } from '#lib/domain/text-split.js';

const count = countGraphemes;

describe('splitLongText', () => {
	it('returns empty for empty input', () => {
		expect(splitLongText('', 100, count)).toEqual([]);
		expect(splitLongText('   \n  ', 100, count)).toEqual([]);
	});

	it('returns one segment when text fits', () => {
		expect(splitLongText('hello world', 100, count)).toEqual(['hello world']);
	});

	it('normalizes CRLF before measuring', () => {
		expect(splitLongText('a\r\n\r\nb', 100, count)).toEqual(['a\n\nb']);
	});

	it('honors an explicit --- delimiter when each part fits the cap', () => {
		expect(splitLongText('one part here\n---\nsecond part here', 20, count)).toEqual([
			'one part here',
			'second part here'
		]);
	});

	it('splits on blank-line paragraphs when the whole does not fit', () => {
		const text = 'First paragraph here.\n\nSecond paragraph here.';
		const out = splitLongText(text, 30, count);
		expect(out).toEqual(['First paragraph here.', 'Second paragraph here.']);
	});

	it('keeps two short paragraphs together when they fit one post', () => {
		const text = 'One.\n\nTwo.';
		expect(splitLongText(text, 30, count)).toEqual(['One.\n\nTwo.']);
	});

	it('packs sentences up to the cap without exceeding it', () => {
		const text =
			'This is sentence number one. This is sentence number two. This is sentence number three.';
		const out = splitLongText(text, 60, count);
		expect(out.length).toBeGreaterThan(1);
		for (const seg of out) expect(count(seg)).toBeLessThanOrEqual(60);
		// No text lost: rejoining keeps every sentence.
		const rejoined = out.join(' ');
		expect(rejoined).toContain('sentence number one.');
		expect(rejoined).toContain('sentence number two.');
		expect(rejoined).toContain('sentence number three.');
	});

	it('wraps words when a single sentence exceeds the cap', () => {
		const text = 'supercalifragilistic word '.repeat(12).trim();
		const out = splitLongText(text, 40, count);
		expect(out.length).toBeGreaterThan(1);
		for (const seg of out) expect(count(seg)).toBeLessThanOrEqual(40);
		expect(out.join(' ')).toBe(text);
	});

	it('hard-slices unbreakable CJK runs at grapheme boundaries', () => {
		const text = '这是一段很长的中文文本没有空格也没有标点符号'.repeat(4);
		const out = splitLongText(text, 20, count);
		expect(out.length).toBeGreaterThan(1);
		for (const seg of out) expect(count(seg)).toBeLessThanOrEqual(20);
		expect(out.join('')).toBe(text);
	});

	it('caps pathological pastes at MAX_AUTO_SEGMENTS', () => {
		const text = Array.from({ length: 80 }, (_, i) => `Post number ${i} text here.`).join('\n\n');
		const out = splitLongText(text, 40, count);
		expect(out.length).toBe(MAX_AUTO_SEGMENTS);
		expect(out.join(' ')).toContain('Post number 79');
	});
});

import { describe, expect, it } from 'vitest';
import { cardExcerpt, draftExcerpt } from '#lib/domain/excerpt.js';

describe('draftExcerpt', () => {
	it('falls back for empty bodies', () => {
		expect(draftExcerpt(null)).toBe('Empty draft');
		expect(draftExcerpt(undefined)).toBe('Empty draft');
		expect(draftExcerpt('')).toBe('Empty draft');
		expect(draftExcerpt('   \n  ')).toBe('Empty draft');
	});

	it('returns short bodies unchanged', () => {
		expect(draftExcerpt('hi linkedin')).toBe('hi linkedin');
	});

	it('collapses whitespace and newlines', () => {
		expect(draftExcerpt('one\n\ntwo   three')).toBe('one two three');
	});

	it('truncates long bodies with an ellipsis', () => {
		const body = 'a'.repeat(200);
		const out = draftExcerpt(body);
		expect(out.endsWith('…')).toBe(true);
		expect([...out].length).toBeLessThanOrEqual(121);
	});

	it('does not split surrogate pairs or emoji', () => {
		const out = draftExcerpt(`x${'🎉'.repeat(200)}`, 10);
		expect([...out][9]).toBe('🎉');
		expect(out.endsWith('…')).toBe(true);
	});

	it('respects a custom max', () => {
		expect(draftExcerpt('hello world', 5)).toBe('hello…');
	});
});

describe('zwj sequences', () => {
	it('never splits joiners or flags', async () => {
		const { draftExcerpt } = await import('#lib/domain/excerpt.js');
		expect(draftExcerpt('👨‍👩‍👧‍👦', 1)).toBe('👨‍👩‍👧‍👦');
		expect(draftExcerpt('👍🏽 hello', 1)).toBe('👍🏽…');
	});
});

describe('cardExcerpt', () => {
	it('falls back for empty text', () => {
		expect(cardExcerpt(null)).toBe('Empty draft');
		expect(cardExcerpt(' \n\n \t ')).toBe('Empty draft');
	});

	it('keeps line breaks and indentation, without trailing spaces', () => {
		expect(cardExcerpt('  Hello  \n\n- one\n  - two \nbye')).toBe('Hello\n\n- one\n  - two\nbye');
	});

	it('reads Windows and old Mac line endings', () => {
		expect(cardExcerpt('a\r\nb\rc')).toBe('a\nb\nc');
	});

	it('shows a run of blank lines as one', () => {
		expect(cardExcerpt('a\n\n\n\n\nb\n \n \n c')).toBe('a\n\nb\n\n c');
	});

	it('keeps a typed --- as it is', () => {
		expect(cardExcerpt('before\n---\nafter')).toBe('before\n---\nafter');
	});

	it('stops after the line cap', () => {
		const text = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');
		expect(cardExcerpt(text)).toBe(
			`${Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n')}…`
		);
		expect(cardExcerpt('a\nb\nc', 500, 3)).toBe('a\nb\nc');
		expect(cardExcerpt('a\nb\n\nc', 500, 3)).toBe('a\nb…');
	});

	it('stops at the character cap without splitting emoji', () => {
		expect(cardExcerpt('a'.repeat(600))).toBe(`${'a'.repeat(500)}…`);
		const out = cardExcerpt(`x\n${'👨‍👩‍👧'.repeat(20)}`, 6);
		expect(out).toBe(`x\n${'👨‍👩‍👧'.repeat(4)}…`);
	});
});

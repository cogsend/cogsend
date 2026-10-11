import { describe, expect, it } from 'vitest';
import { draftExcerpt } from '#lib/domain/excerpt.js';

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

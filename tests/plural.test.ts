import { describe, expect, it } from 'vitest';
import { plural } from '#lib/domain/plural.js';

describe('plural', () => {
	it('uses the singular for exactly one', () => {
		expect(plural(1, 'draft', 'drafts')).toBe('1 draft');
	});

	it('uses the plural for none and for many', () => {
		expect(plural(0, 'draft', 'drafts')).toBe('0 drafts');
		expect(plural(3, 'scheduled post', 'scheduled posts')).toBe('3 scheduled posts');
	});
});

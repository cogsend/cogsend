import { describe, expect, it } from 'vitest';
import { claimPasswordProblem } from '#lib/domain/claim-password.js';

describe('claimPasswordProblem', () => {
	it('refuses a typed password that was repeated differently', () => {
		expect(claimPasswordProblem('correct horse', 'correct hrose', false)).toBe(
			"The two passwords don't match"
		);
	});

	it('accepts a typed password repeated exactly', () => {
		expect(claimPasswordProblem('correct horse', 'correct horse', false)).toBeNull();
	});

	it('does not ask to repeat a password that is shown on screen', () => {
		expect(claimPasswordProblem('generated-password', '', true)).toBeNull();
	});
});

import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_SECRETS } from '#lib/server/env.js';
import { PLACEHOLDER_VALUES, isPlaceholderValue } from '../scripts/lib/dev-vars.mjs';

/**
 * The scripts and the Worker read `.dev.vars` with the same parser now (see
 * scripts/lib/dev-vars.mjs), so this is no longer about two implementations
 * agreeing — it is the one thing that cannot be shared: the list of example
 * values. The app rejects them at boot and the scripts refuse to upload them;
 * a value in one list and not the other is a deploy that either fails at boot
 * or ships an example key.
 */
describe('placeholder values', () => {
	it('are the same set in the app and in the scripts', () => {
		expect([...PLACEHOLDER_VALUES].sort()).toEqual([...PLACEHOLDER_SECRETS].sort());
	});

	it('are refused, with whitespace ignored, while real values pass', () => {
		for (const placeholder of PLACEHOLDER_VALUES) {
			expect(isPlaceholderValue(placeholder)).toBe(true);
			expect(isPlaceholderValue(` ${placeholder}\n`)).toBe(true);
		}
		expect(isPlaceholderValue('a'.repeat(64))).toBe(false);
		expect(isPlaceholderValue(undefined)).toBe(true);
	});
});

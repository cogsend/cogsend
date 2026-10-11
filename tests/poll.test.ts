import { describe, expect, it } from 'vitest';
import { parsePollConfig, validatePollConfig } from '#lib/domain/poll.js';

describe('validatePollConfig', () => {
	it('accepts a valid poll', () => {
		expect(
			validatePollConfig({ options: [' yes ', 'no'], expiresIn: 86400, multiple: true })
		).toEqual({
			ok: true,
			config: { options: ['yes', 'no'], expiresIn: 86400, multiple: true, hideTotals: undefined }
		});
	});

	it('rejects bad shapes', () => {
		expect(validatePollConfig(null).ok).toBe(false);
		expect(validatePollConfig({ options: ['only'], expiresIn: 300 }).ok).toBe(false);
		expect(validatePollConfig({ options: ['a', 'b', 'c', 'd', 'e'], expiresIn: 300 }).ok).toBe(
			false
		);
		expect(validatePollConfig({ options: ['a', 'x'.repeat(51)], expiresIn: 300 }).ok).toBe(false);
		expect(validatePollConfig({ options: ['a', 'b'], expiresIn: 60 }).ok).toBe(false);
		expect(parsePollConfig({ options: ['a'], expiresIn: 300 })).toBeNull();
	});
});

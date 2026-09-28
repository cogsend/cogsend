import { describe, expect, it } from 'vitest';
import { parseTimeZone } from '$lib/domain/time-zone';

describe('parseTimeZone', () => {
	it('accepts zones the runtime knows', () => {
		expect(parseTimeZone('Asia/Kolkata')).toBe('Asia/Kolkata');
		expect(parseTimeZone(' Europe/Berlin ')).toBe('Europe/Berlin');
		expect(parseTimeZone('UTC')).toBe('UTC');
	});

	it('refuses anything else', () => {
		for (const bad of ['Not/AZone', '', '   ', 'x'.repeat(65), 42, null, undefined, {}]) {
			expect(parseTimeZone(bad)).toBeNull();
		}
	});
});

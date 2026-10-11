import { describe, expect, it } from 'vitest';
import {
	connectionIdsOverflow,
	normalizeConnectionIds,
	runAtError
} from '#lib/domain/request-limits.js';

describe('normalizeConnectionIds', () => {
	it('dedupes and trims', () => {
		expect(normalizeConnectionIds(['a', ' a ', 'b', 'a'])).toEqual(['a', 'b']);
	});
	it('drops non-strings and empties', () => {
		expect(normalizeConnectionIds(['a', '', '  ', 42, null, undefined])).toEqual(['a']);
	});
	it('caps at 10', () => {
		const many = Array.from({ length: 25 }, (_, i) => `c${i}`);
		expect(normalizeConnectionIds(many)).toHaveLength(10);
	});
	it('returns [] for non-arrays', () => {
		expect(normalizeConnectionIds(undefined)).toEqual([]);
		expect(normalizeConnectionIds('a')).toEqual([]);
	});
});

describe('connectionIdsOverflow', () => {
	it('flags >10 unique ids', () => {
		const many = Array.from({ length: 11 }, (_, i) => `c${i}`);
		expect(connectionIdsOverflow(many)).toBe(true);
		expect(connectionIdsOverflow(['a', 'a', 'b'])).toBe(false);
	});
});

describe('runAtError', () => {
	it('requires a valid date', () => {
		expect(runAtError(undefined)).toMatch(/required/);
		expect(runAtError('garbage')).toMatch(/required/);
	});
	it('rejects the past beyond grace', () => {
		const now = new Date('2026-09-08T12:00:00Z');
		expect(runAtError('2026-09-08T11:59:00Z', now)).toMatch(/future/);
	});
	it('allows now within grace', () => {
		const now = new Date('2026-09-08T12:00:00Z');
		expect(runAtError('2026-09-08T11:59:57Z', now)).toBeNull();
	});
	it('rejects more than a year out', () => {
		const now = new Date('2026-09-08T12:00:00Z');
		expect(runAtError('2028-09-08T12:00:01Z', now)).toMatch(/within the next year/);
		expect(runAtError('2027-09-08T11:59:59Z', now)).toBeNull();
	});
});

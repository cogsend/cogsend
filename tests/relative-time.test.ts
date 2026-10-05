import { describe, expect, it } from 'vitest';
import {
	formatDayTime,
	formatFullLocalWithZone,
	formatLocalDateTime,
	formatLocalDateTimeWithZone,
	localTimezoneShort
} from '$lib/domain/relative-time';

describe('local timezone formatting', () => {
	it('exposes a non-empty local zone abbreviation', () => {
		expect(localTimezoneShort().length).toBeGreaterThan(0);
	});

	it('formats an absolute local date/time', () => {
		const d = new Date(2026, 8, 9, 14, 30, 0, 0);
		const text = formatLocalDateTime(d);
		expect(text).toContain('Sep');
		expect(text).toContain('9');
		expect(text).toContain('30');
	});

	it('appends the zone and never shifts it', () => {
		const d = new Date(2026, 8, 9, 14, 30, 0, 0);
		expect(formatLocalDateTimeWithZone(d)).toBe(
			`${formatLocalDateTime(d)} ${localTimezoneShort()}`
		);
		const full = formatFullLocalWithZone(d);
		expect(full).toContain('2026');
		// Footer label and tooltip must name the SAME zone for one instant.
		expect(full).toContain(localTimezoneShort(d));
		expect(formatLocalDateTimeWithZone(d)).toContain(localTimezoneShort(d));
	});

	it('returns empty strings for invalid dates', () => {
		expect(formatLocalDateTime('not-a-date')).toBe('');
		expect(formatLocalDateTimeWithZone('not-a-date')).toBe('');
		expect(formatFullLocalWithZone('not-a-date')).toBe('');
		expect(formatDayTime('not-a-date')).toBe('');
	});
});

describe('formatDayTime', () => {
	const now = new Date(2026, 8, 7, 12, 0, 0); // Mon Sep 7 2026, noon local

	it('names the day for yesterday, today and tomorrow, with the time and no zone', () => {
		const today = formatDayTime(new Date(2026, 8, 7, 18, 40), now);
		expect(today).toMatch(/^Today, /);
		expect(today).toContain('40');
		expect(today).not.toContain(localTimezoneShort());
		expect(formatDayTime(new Date(2026, 8, 8, 9, 5), now)).toMatch(/^Tomorrow, .*05/);
		expect(formatDayTime(new Date(2026, 8, 6, 23, 15), now)).toMatch(/^Yesterday, .*15/);
	});

	it('falls back to the short date for any other day', () => {
		const d = new Date(2026, 8, 12, 9, 30);
		expect(formatDayTime(d, now)).toBe(formatLocalDateTime(d));
	});
});

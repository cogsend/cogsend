import { describe, expect, it } from 'vitest';
import { dayGroupLabel, formatRelativeTime } from '#lib/domain/relative-time.js';
import { remapSegmentIndexAfterReorder, reorderSegments } from '#lib/domain/thread-segments.js';

const now = new Date(2026, 8, 7, 12, 0, 0); // Mon Sep 7 2026, noon local

describe('dayGroupLabel', () => {
	it('labels today and tomorrow', () => {
		expect(dayGroupLabel(new Date(2026, 8, 7, 8), now)).toBe('Today');
		expect(dayGroupLabel(new Date(2026, 8, 8, 23), now)).toBe('Tomorrow');
	});

	it('labels yesterday', () => {
		expect(dayGroupLabel(new Date(2026, 8, 6, 23), now)).toBe('Yesterday');
	});

	it('uses a short date within the year (locale-formatted)', () => {
		const label = dayGroupLabel(new Date(2026, 8, 12, 9), now);
		// Locale-dependent shape; assert the essentials.
		expect(label).not.toBe('Today');
		expect(label).not.toBe('Tomorrow');
		expect(label).not.toBe('Yesterday');
		expect(label).toContain('Sep');
		expect(label).toContain('12');
	});
});

describe('reorderSegments', () => {
	const segs = ['a', 'b', 'c', 'd'];

	it('moves a segment forward and shifts the middle ones down', () => {
		expect(reorderSegments(segs, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
	});

	it('moves a segment back and shifts the middle ones up', () => {
		expect(reorderSegments(segs, 3, 1)).toEqual(['a', 'd', 'b', 'c']);
	});

	it('is a no-op for same index and out-of-range moves', () => {
		expect(reorderSegments(segs, 1, 1)).toBe(segs);
		expect(reorderSegments(segs, -1, 0)).toBe(segs);
		expect(reorderSegments(segs, 0, 4)).toBe(segs);
	});
});

describe('remapSegmentIndexAfterReorder', () => {
	it('maps the moved index to its new home', () => {
		expect(remapSegmentIndexAfterReorder(0, 0, 2)).toBe(2);
		expect(remapSegmentIndexAfterReorder(3, 3, 1)).toBe(1);
	});

	it('shifts the span between from and to', () => {
		// 0 → 2: media on 1 and 2 shift down by one.
		expect(remapSegmentIndexAfterReorder(1, 0, 2)).toBe(0);
		expect(remapSegmentIndexAfterReorder(2, 0, 2)).toBe(1);
		// 3 → 1: media on 1 and 2 shift up by one.
		expect(remapSegmentIndexAfterReorder(1, 3, 1)).toBe(2);
		expect(remapSegmentIndexAfterReorder(2, 3, 1)).toBe(3);
	});

	it('leaves untouched indexes alone', () => {
		expect(remapSegmentIndexAfterReorder(3, 0, 2)).toBe(3);
	});

	it('matches reorderSegments for every media position', () => {
		const segs = ['a', 'b', 'c', 'd', 'e'];
		for (let from = 0; from < segs.length; from++) {
			for (let to = 0; to < segs.length; to++) {
				const moved = reorderSegments(segs, from, to);
				for (let i = 0; i < segs.length; i++) {
					const mapped = remapSegmentIndexAfterReorder(i, from, to);
					expect(moved[mapped]).toBe(segs[i]);
				}
			}
		}
	});
});

describe('formatRelativeTime sanity', () => {
	it('still formats future times', () => {
		expect(formatRelativeTime(new Date(now.getTime() + 5 * 60_000), now)).toBe('in 5m');
	});
});

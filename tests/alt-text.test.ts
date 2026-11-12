import { describe, expect, it } from 'vitest';
import {
	ALT_LIMITS,
	MAX_ALT_LENGTH,
	altCutNote,
	altLimitFor,
	altReaches,
	missingAlt,
	missingAltMessage,
	type AltDestination,
	type AltItem
} from '#lib/domain/alt-text.js';
import { cleanAltText } from '#lib/server/draft-media.js';

const direct = (platform: AltDestination['platform']): AltDestination => ({
	platform,
	viaZernio: false
});
const zernio = (platform: AltDestination['platform']): AltDestination => ({
	platform,
	viaZernio: true
});

describe('where alt text goes', () => {
	it('follows what each provider sends', () => {
		expect(altReaches(direct('mastodon'), 'image')).toBe(true);
		expect(altReaches(direct('bluesky'), 'video')).toBe(true);
		expect(altReaches(direct('x'), 'video')).toBe(true);
		expect(altReaches(direct('threads'), 'image')).toBe(false);
		expect(altReaches(direct('threads'), 'video')).toBe(true);
		expect(altReaches(direct('linkedin'), 'image')).toBe(true);
		expect(altReaches(direct('linkedin'), 'video')).toBe(false);
		expect(altReaches(direct('instagram'), 'image')).toBe(true);
		expect(altReaches(direct('instagram'), 'video')).toBe(false);
		expect(altReaches(zernio('threads'), 'image')).toBe(true);
		expect(altReaches(zernio('instagram'), 'video')).toBe(true);
	});

	it('cuts the stored text where the server always has', () => {
		expect(MAX_ALT_LENGTH).toBe(1500);
		expect(cleanAltText('a'.repeat(1600))).toHaveLength(1500);
		expect(cleanAltText('  ')).toBeNull();
	});
});

describe('the count note', () => {
	it('names the platforms that keep less, once over their limit', () => {
		const to = [direct('x'), direct('instagram'), direct('mastodon')];
		expect(altCutNote(1000, 'image', to)).toBeNull();
		expect(altCutNote(1001, 'image', to)).toBe('X and Instagram keep the first 1,000 characters');
		expect(altCutNote(1001, 'image', [direct('x')])).toBe('X keeps the first 1,000 characters');
	});

	it('leaves out a platform the description never reaches', () => {
		expect(altCutNote(1200, 'video', [direct('instagram'), direct('x')])).toBe(
			'X keeps the first 1,000 characters'
		);
		expect(altCutNote(1200, 'video', [direct('instagram')])).toBeNull();
		expect(altLimitFor('video', [direct('instagram')])).toBeNull();
		expect(altLimitFor('image', [direct('instagram'), direct('bluesky')])).toBe(
			ALT_LIMITS.instagram
		);
	});
});

describe('media without alt text', () => {
	const items: AltItem[] = [
		{ id: 'b', kind: 'image', altText: 'A dog', segmentIndex: 1 },
		{ id: 'a', kind: 'image', altText: null, segmentIndex: 0 },
		{ id: 'c', kind: 'image', altText: '  ', segmentIndex: 1 },
		{ id: 'v', kind: 'video', altText: '', segmentIndex: 2 }
	];

	it('lists them in post order, counted within each post', () => {
		const missing = missingAlt(items, [direct('mastodon')]);
		expect(missing.map((m) => [m.id, m.position])).toEqual([
			['a', 1],
			['c', 2],
			['v', 1]
		]);
		expect(missingAltMessage(missing, 3)).toBe('2 images and 1 video have no alt text');
	});

	it('skips media no checked account would describe', () => {
		expect(missingAlt(items, [direct('threads')]).map((m) => m.id)).toEqual(['v']);
		expect(missingAlt(items, [direct('instagram')]).map((m) => m.id)).toEqual(['a', 'c']);
		expect(missingAlt(items, [])).toEqual([]);
	});

	it('names a single one by where it is', () => {
		const one = missingAlt([items[2]], [direct('x')]);
		expect(missingAltMessage(one, 2)).toBe('Image 1 in post 2 has no alt text');
		expect(missingAltMessage(one, 1)).toBe('Image 1 has no alt text');
		const video = missingAlt([items[3]], [direct('x')]);
		expect(missingAltMessage(video, 3)).toBe('The video in post 3 has no alt text');
		expect(missingAltMessage([], 1)).toBeNull();
	});
});

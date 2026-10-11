import { describe, expect, it } from 'vitest';
import {
	customizePlatformBody,
	customizedBodiesForSave,
	effectivePlatformBody,
	isPlatformCustomized,
	overridesFromVariants,
	platformsFromConnections,
	resetPlatformToFollow,
	resolveRestoredSelection,
	resolveSavedSelection
} from '#lib/domain/platform-sync.js';

describe('platform follow / customize / reset', () => {
	it('follows main until customized', () => {
		const main = 'Hello world';
		let overrides = {};
		expect(isPlatformCustomized(overrides, 'mastodon')).toBe(false);
		expect(effectivePlatformBody(main, overrides, 'mastodon')).toBe('Hello world');

		overrides = customizePlatformBody(overrides, 'mastodon', 'Hello masto');
		expect(isPlatformCustomized(overrides, 'mastodon')).toBe(true);
		expect(effectivePlatformBody(main, overrides, 'mastodon')).toBe('Hello masto');
		expect(effectivePlatformBody('Changed main', overrides, 'mastodon')).toBe('Hello masto');
		expect(effectivePlatformBody('Changed main', overrides, 'bluesky')).toBe('Changed main');
	});

	it('reset restores following main', () => {
		let overrides = customizePlatformBody({}, 'bluesky', 'custom bsky');
		overrides = resetPlatformToFollow(overrides, 'bluesky');
		expect(isPlatformCustomized(overrides, 'bluesky')).toBe(false);
		expect(effectivePlatformBody('Main again', overrides, 'bluesky')).toBe('Main again');
	});

	it('empty string is still customized', () => {
		const overrides = customizePlatformBody({}, 'mastodon', '');
		expect(isPlatformCustomized(overrides, 'mastodon')).toBe(true);
		expect(effectivePlatformBody('main', overrides, 'mastodon')).toBe('');
	});

	it('customizedBodiesForSave only includes customized platforms', () => {
		const overrides = customizePlatformBody({}, 'mastodon', 'm only');
		const saved = customizedBodiesForSave('main', overrides, ['mastodon', 'bluesky']);
		expect(saved).toEqual({ mastodon: 'm only' });
		expect(saved.bluesky).toBeUndefined();
	});

	it('overridesFromVariants treats equal-to-main as following', () => {
		const map = overridesFromVariants(
			[
				{ platform: 'mastodon', body: 'same' },
				{ platform: 'bluesky', body: 'different' }
			],
			'same'
		);
		expect(isPlatformCustomized(map, 'mastodon')).toBe(false);
		expect(isPlatformCustomized(map, 'bluesky')).toBe(true);
	});

	it('platformsFromConnections unique', () => {
		expect(
			platformsFromConnections([
				{ platform: 'mastodon' },
				{ platform: 'mastodon' },
				{ platform: 'bluesky' }
			])
		).toEqual(['mastodon', 'bluesky']);
	});
});

describe('resolveRestoredSelection', () => {
	it('returns null when the draft has no targets', () => {
		expect(resolveRestoredSelection([], [{ id: 'a' }])).toBeNull();
		expect(resolveRestoredSelection([null, undefined], [{ id: 'a' }])).toBeNull();
	});

	it('restores target ids that still exist, dropping deleted ones', () => {
		expect(resolveRestoredSelection(['a', 'gone', 'b'], [{ id: 'a' }, { id: 'b' }])).toEqual([
			'a',
			'b'
		]);
	});

	it('can restore an explicitly empty selection', () => {
		expect(resolveRestoredSelection(['gone'], [{ id: 'a' }])).toEqual([]);
	});
});

describe('resolveSavedSelection', () => {
	it('returns null when the draft never stored a selection', () => {
		expect(resolveSavedSelection(null, [{ id: 'a' }])).toBeNull();
		expect(resolveSavedSelection(undefined, [{ id: 'a' }])).toBeNull();
		expect(resolveSavedSelection('nope', [{ id: 'a' }])).toBeNull();
	});

	it('keeps existing ids and drops unknown ones', () => {
		expect(resolveSavedSelection(['a', 'gone', 'b'], [{ id: 'a' }, { id: 'b' }])).toEqual([
			'a',
			'b'
		]);
	});

	it('preserves an explicitly empty selection', () => {
		expect(resolveSavedSelection([], [{ id: 'a' }])).toEqual([]);
		expect(resolveSavedSelection(['gone'], [{ id: 'a' }])).toEqual([]);
	});
});

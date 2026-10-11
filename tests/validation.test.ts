import { describe, expect, it } from 'vitest';
import {
	PLATFORM_LIMITS,
	isOverSelectedPlatformLimit,
	platformLimit
} from '#lib/domain/editor-limits.js';
import { platformMark } from '#lib/domain/platform-marks.js';
import {
	countGraphemes,
	mastodonWeightedLength,
	validateBlueskyText,
	validateMastodonText
} from '#lib/domain/validation/text.js';
import { blueskyProvider, buildLinkFacets, mastodonProvider } from '#lib/server/providers/index.js';
import { utf8ByteLength } from '#lib/domain/bytes.js';

describe('countGraphemes', () => {
	it('counts ascii 1:1', () => {
		expect(countGraphemes('hello')).toBe(5);
	});
	it('counts emoji as single graphemes', () => {
		expect(countGraphemes('hi👍')).toBe(3);
	});
	it('empty is 0', () => {
		expect(countGraphemes('')).toBe(0);
	});
});

describe('validateBlueskyText', () => {
	it('allows up to 300 graphemes', () => {
		const r = validateBlueskyText('a'.repeat(300));
		expect(r.ok).toBe(true);
		expect(r.length).toBe(300);
	});
	it('rejects over 300 graphemes', () => {
		const r = validateBlueskyText('a'.repeat(301));
		expect(r.ok).toBe(false);
		expect(r.message).toMatch(/over by 1/);
	});
});

describe('mastodonWeightedLength', () => {
	it('counts plain text', () => {
		expect(mastodonWeightedLength('hello world')).toBe(11);
	});
	it('counts URLs as 23', () => {
		expect(mastodonWeightedLength('see https://example.com/very/long/path and more')).toBe(36);
	});
});

describe('validateMastodonText', () => {
	it('uses instance max', () => {
		expect(validateMastodonText('a'.repeat(500), 500).ok).toBe(true);
		expect(validateMastodonText('a'.repeat(501), 500).ok).toBe(false);
	});
});

describe('provider validate', () => {
	it('bluesky rejects long text', () => {
		const issues = blueskyProvider.validate({ text: 'x'.repeat(350) });
		expect(issues.some((i) => i.code === 'max_length')).toBe(true);
	});
	it('mastodon uses meta maxCharacters', () => {
		expect(
			mastodonProvider.validate({ text: 'a'.repeat(800) }, { maxCharacters: 1000 })
		).toHaveLength(0);
		expect(
			mastodonProvider
				.validate({ text: 'a'.repeat(600) }, { maxCharacters: 500 })
				.some((i) => i.code === 'max_length')
		).toBe(true);
	});
	it('rejects empty segment without media', () => {
		expect(blueskyProvider.validate({ text: '   ' }).length).toBeGreaterThan(0);
		expect(mastodonProvider.validate({ text: '' }).length).toBeGreaterThan(0);
	});
});

describe('buildLinkFacets', () => {
	it('creates facet with utf8 byte offsets', () => {
		const text = 'go https://example.com now';
		const facets = buildLinkFacets(text);
		expect(facets).toHaveLength(1);
		expect(facets[0].features[0].uri).toBe('https://example.com');
		expect(facets[0].index.byteStart).toBe(utf8ByteLength('go '));
	});
});

describe('bluesky media size validation', () => {
	it('rejects path-based media when size field exceeds 2MB', () => {
		const issues = blueskyProvider.validate({
			text: 'pic',
			media: [{ storageKey: 'huge.png', size: 2_000_001, mime: 'image/png' }]
		});
		expect(issues.some((i) => i.code === 'max_image_bytes')).toBe(true);
	});
	it('allows a 1.5MB image that the old 1MB cap refused', () => {
		const issues = blueskyProvider.validate({
			text: 'pic',
			media: [{ bytes: new Uint8Array(1_500_000), mime: 'image/png' }]
		});
		expect(issues.some((i) => i.code === 'max_image_bytes')).toBe(false);
	});
	it('allows exactly 2MB via size field', () => {
		const issues = blueskyProvider.validate({
			text: 'pic',
			media: [{ storageKey: 'ok.png', size: 2_000_000, mime: 'image/png', alt: 'ok' }]
		});
		expect(issues.some((i) => i.code === 'max_image_bytes')).toBe(false);
	});
	it('rejects oversized bytes buffer', () => {
		const issues = blueskyProvider.validate({
			text: 'pic',
			media: [{ bytes: new Uint8Array(2_000_001), mime: 'image/png' }]
		});
		expect(issues.some((i) => i.code === 'max_image_bytes')).toBe(true);
	});
});

describe('publish disable gates selected platforms only', () => {
	it('allows Mastodon-only 400-char post when Bluesky not selected', () => {
		expect(
			isOverSelectedPlatformLimit({
				selectedPlatforms: ['mastodon'],
				blueskyLen: 400,
				mastodonLen: 400
			})
		).toBe(false);
	});
	it('blocks when selected Bluesky is over limit', () => {
		expect(
			isOverSelectedPlatformLimit({
				selectedPlatforms: ['bluesky'],
				blueskyLen: 350,
				mastodonLen: 100
			})
		).toBe(true);
	});
	it('does not block on unused platform over limit', () => {
		expect(
			isOverSelectedPlatformLimit({
				selectedPlatforms: ['bluesky'],
				blueskyLen: 100,
				mastodonLen: 600
			})
		).toBe(false);
	});
	it('blocks when both selected and one is over', () => {
		expect(
			isOverSelectedPlatformLimit({
				selectedPlatforms: ['bluesky', 'mastodon'],
				blueskyLen: 301,
				mastodonLen: 100
			})
		).toBe(true);
	});
	it('allows two under-limit Bluesky posts when lens is max-per-segment', () => {
		expect(
			isOverSelectedPlatformLimit({
				selectedPlatforms: ['bluesky'],
				blueskyLen: 200,
				mastodonLen: 0,
				blueskyMax: 300
			})
		).toBe(false);
	});
});

describe('platformLimit', () => {
	const mastodon = (maxCharacters?: number) => ({
		platform: 'mastodon',
		metaJson: maxCharacters === undefined ? null : { maxCharacters }
	});

	it('uses the instance limit of the accounts it is given', () => {
		expect(platformLimit('mastodon', [mastodon(500)])).toBe(500);
		expect(platformLimit('mastodon', [mastodon(200)])).toBe(200);
		// Several selected instances: the strictest of those.
		expect(platformLimit('mastodon', [mastodon(200), mastodon(500)])).toBe(200);
	});

	it('does not let an account outside the selection cap the post', () => {
		// The bug this pins: the composer used to pass every connected account,
		// so an unselected 200-character instance blocked text that only the
		// 500-character one would have received.
		const selected = [mastodon(500)];
		expect(platformLimit('mastodon', selected)).toBe(500);
	});

	it('falls back to the platform default, and ignores nonsense', () => {
		expect(platformLimit('mastodon', [])).toBe(PLATFORM_LIMITS.mastodon);
		expect(platformLimit('mastodon', [mastodon(0), mastodon(-5)])).toBe(PLATFORM_LIMITS.mastodon);
		expect(platformLimit('mastodon', [{ platform: 'mastodon', metaJson: {} }])).toBe(
			PLATFORM_LIMITS.mastodon
		);
		expect(platformLimit('bluesky', [])).toBe(PLATFORM_LIMITS.bluesky);
		expect(platformLimit('linkedin', [mastodon(200)])).toBe(PLATFORM_LIMITS.linkedin);
		expect(platformLimit('threads', [])).toBe(PLATFORM_LIMITS.threads);
		expect(platformLimit('x', [])).toBe(PLATFORM_LIMITS.x);
	});
});

describe('platformMarks', () => {
	it('answers a mark for every platform the app can connect', () => {
		for (const platform of ['mastodon', 'bluesky', 'linkedin', 'threads', 'x']) {
			expect(platformMark(platform), platform).toMatch(/^M/);
		}
		// Case-insensitive, because platform ids arrive from D1 and from URLs.
		expect(platformMark('Bluesky')).toBe(platformMark('bluesky'));
	});

	it('answers null for an unknown platform rather than another brand', () => {
		// The components draw a neutral glyph for null; falling back to Bluesky
		// (which one of them did) labels the wrong platform.
		expect(platformMark('myspace')).toBeNull();
		expect(platformMark('')).toBeNull();
		expect(platformMark(null)).toBeNull();
		expect(platformMark(undefined)).toBeNull();
	});
});

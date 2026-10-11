import { describe, expect, it } from 'vitest';
import {
	isValidProfilePictureUrl,
	normalizeProfileSettings,
	parseProfileSettings,
	PROFILE_PICTURE_URL_MAX,
	sanitizeProfilePictureUrl
} from '#lib/domain/profile-settings.js';

describe('parseProfileSettings', () => {
	it('falls back on garbage', () => {
		expect(parseProfileSettings(null)).toEqual({
			mastoVisibility: 'public',
			defaultAccountIds: [],
			profilePictureUrl: ''
		});
		expect(parseProfileSettings('not json')).toEqual({
			mastoVisibility: 'public',
			defaultAccountIds: [],
			profilePictureUrl: ''
		});
		expect(
			parseProfileSettings({ mastoVisibility: 'nonsense', defaultAccountIds: [1, 2] })
		).toEqual({ mastoVisibility: 'public', defaultAccountIds: [], profilePictureUrl: '' });
		expect(parseProfileSettings({ profilePictureUrl: 'javascript:alert(1)' })).toEqual({
			mastoVisibility: 'public',
			defaultAccountIds: [],
			profilePictureUrl: ''
		});
	});

	it('keeps valid values from string or object', () => {
		const want = {
			mastoVisibility: 'private' as const,
			defaultAccountIds: ['a', 'b'],
			profilePictureUrl: ''
		};
		expect(parseProfileSettings(JSON.stringify(want))).toEqual(want);
		expect(parseProfileSettings(want)).toEqual(want);
	});
});

describe('normalizeProfileSettings', () => {
	it('rejects bad payloads', () => {
		expect(normalizeProfileSettings(null).ok).toBe(false);
		expect(normalizeProfileSettings({ mastoVisibility: 'everywhere' }).ok).toBe(false);
		expect(normalizeProfileSettings({ defaultAccountIds: 'x' }).ok).toBe(false);
		expect(normalizeProfileSettings({ defaultAccountIds: new Array(51).fill('x') }).ok).toBe(false);
	});

	it('accepts partial payloads', () => {
		const r = normalizeProfileSettings({ mastoVisibility: 'unlisted' });
		expect(r).toEqual({
			ok: true,
			settings: { mastoVisibility: 'unlisted', defaultAccountIds: [], profilePictureUrl: '' }
		});
	});

	it('accepts https profile URLs and empty', () => {
		expect(normalizeProfileSettings({ profilePictureUrl: '' })).toEqual({
			ok: true,
			settings: { mastoVisibility: 'public', defaultAccountIds: [], profilePictureUrl: '' }
		});
		expect(normalizeProfileSettings({ profilePictureUrl: 'https://example.com/a.png' })).toEqual({
			ok: true,
			settings: {
				mastoVisibility: 'public',
				defaultAccountIds: [],
				profilePictureUrl: 'https://example.com/a.png'
			}
		});
	});

	it('rejects javascript, http, and oversized profile URLs', () => {
		expect(normalizeProfileSettings({ profilePictureUrl: 'javascript:alert(1)' }).ok).toBe(false);
		expect(normalizeProfileSettings({ profilePictureUrl: 'http://example.com/a.png' }).ok).toBe(
			false
		);
		expect(normalizeProfileSettings({ profilePictureUrl: 'https://' + 'a'.repeat(2001) }).ok).toBe(
			false
		);
	});

	it('rejects empty or oversized default account ids', () => {
		expect(normalizeProfileSettings({ defaultAccountIds: [''] }).ok).toBe(false);
		expect(normalizeProfileSettings({ defaultAccountIds: ['x'.repeat(129)] }).ok).toBe(false);
	});
});

describe('isValidProfilePictureUrl', () => {
	// The settings page mirrors these rules client-side, so the dialog can flag a
	// bad URL before it reaches the API.
	it('accepts only non-empty https URLs inside the length cap', () => {
		const prefix = 'https://a.co/';
		const atCap = prefix + 'a'.repeat(PROFILE_PICTURE_URL_MAX - prefix.length);
		expect(atCap).toHaveLength(PROFILE_PICTURE_URL_MAX);
		expect(isValidProfilePictureUrl('https://example.com/a.png')).toBe(true);
		expect(isValidProfilePictureUrl('  https://example.com/a.png  ')).toBe(true);
		expect(isValidProfilePictureUrl(atCap)).toBe(true);
	});

	it('rejects empty, non-string, non-https and oversized values', () => {
		const overCap =
			'https://a.co/' + 'a'.repeat(PROFILE_PICTURE_URL_MAX - 'https://a.co/'.length + 1);
		expect(overCap).toHaveLength(PROFILE_PICTURE_URL_MAX + 1);
		for (const value of [
			'',
			'   ',
			null,
			undefined,
			42,
			'http://example.com/a.png',
			'javascript:alert(1)',
			'data:image/png;base64,AAAA',
			'example.com/a.png',
			overCap
		]) {
			expect(isValidProfilePictureUrl(value)).toBe(false);
		}
	});

	it('agrees with sanitizeProfilePictureUrl on the same input', () => {
		for (const value of ['', 'https://example.com/a.png', 'http://example.com/a.png', 42]) {
			expect(sanitizeProfilePictureUrl(value) !== '').toBe(isValidProfilePictureUrl(value));
		}
	});
});

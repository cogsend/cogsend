import { describe, expect, it } from 'vitest';
import { pageTitle } from '#lib/domain/page-title.js';

describe('pageTitle', () => {
	it('puts the section first', () => {
		expect(pageTitle('/posts', 'My Social')).toBe('Posts · My Social');
		expect(pageTitle('/settings/instance', 'My Social')).toBe('Settings · My Social');
		expect(pageTitle('/login/setup-2fa', 'My Social')).toBe('Set up authenticator · My Social');
		expect(pageTitle('/login/verify', 'My Social')).toBe('Sign in · My Social');
	});

	it('keeps the home title, and matches whole path segments only', () => {
		expect(pageTitle('/', 'My Social')).toBe('My Social — write & schedule');
		expect(pageTitle('/postsomething', 'My Social')).toBe('My Social — write & schedule');
	});

	it('leaves a preview link to name itself', () => {
		expect(pageTitle('/p/abc', 'My Social')).toBeNull();
	});
});

import { describe, expect, it } from 'vitest';
import { securityHeadersFor } from '#lib/server/security-headers.js';

/**
 * The header policy lives in one function so the https-only branch can be
 * asserted positively: the e2e suite runs over plain http and can only prove
 * HSTS is absent there.
 */
describe('securityHeadersFor', () => {
	it('sends HSTS over https and never over plain http', () => {
		expect(securityHeadersFor('/', true)['Strict-Transport-Security']).toBe(
			'max-age=31536000; includeSubDomains'
		);
		// Pinning a local http dev server to https would break it for good.
		expect(securityHeadersFor('/', false)['Strict-Transport-Security']).toBeUndefined();
	});

	it('frames-deny pages but not API responses', () => {
		expect(securityHeadersFor('/', true)['X-Frame-Options']).toBe('DENY');
		expect(securityHeadersFor('/api/drafts', true)['X-Frame-Options']).toBeUndefined();
		// The rest applies everywhere, JSON included.
		for (const path of ['/', '/api/drafts']) {
			const headers = securityHeadersFor(path, true);
			expect(headers['X-Content-Type-Options']).toBe('nosniff');
			expect(headers['Referrer-Policy']).toBe('no-referrer');
			expect(headers['Permissions-Policy']).toContain('camera=()');
		}
	});

	it('denies the features the app does not use, and leaves clipboard alone', () => {
		const policy = securityHeadersFor('/', true)['Permissions-Policy'];
		for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb']) {
			expect(policy).toContain(`${feature}=()`);
		}
		// The API-key copy button needs the clipboard, which defaults to 'self'.
		expect(policy).not.toContain('clipboard');
	});
});

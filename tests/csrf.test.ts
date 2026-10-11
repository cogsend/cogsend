import { describe, expect, it } from 'vitest';
import { carriesCredential, isCrossSiteForgery } from '#lib/server/csrf.js';

const SELF = 'https://cogsend.example.com';

function request(method: string, headers: Record<string, string> = {}) {
	return new Request(`${SELF}/api/drafts/d1`, { method, headers });
}

describe('the cross-site request check', () => {
	it('refuses what SvelteKit refuses when only the session cookie vouches for the request', () => {
		for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
			// A form from another site.
			expect(
				isCrossSiteForgery(
					request(method, {
						origin: 'https://evil.example',
						'content-type': 'application/x-www-form-urlencoded'
					}),
					SELF
				)
			).toBe(true);
			// No body at all, from another site or from no site.
			expect(isCrossSiteForgery(request(method, { origin: 'https://evil.example' }), SELF)).toBe(
				true
			);
			expect(isCrossSiteForgery(request(method), SELF)).toBe(true);
		}
		for (const type of ['multipart/form-data; boundary=x', 'Text/Plain;charset=UTF-8']) {
			expect(isCrossSiteForgery(request('POST', { 'content-type': type }), SELF)).toBe(true);
		}
	});

	it('lets the app itself, reads, and JSON through, as SvelteKit does', () => {
		expect(
			isCrossSiteForgery(
				request('POST', { origin: SELF, 'content-type': 'multipart/form-data; boundary=x' }),
				SELF
			)
		).toBe(false);
		expect(isCrossSiteForgery(request('DELETE', { origin: SELF }), SELF)).toBe(false);
		expect(isCrossSiteForgery(request('GET', { origin: 'https://evil.example' }), SELF)).toBe(
			false
		);
		// A cross-site JSON request needs a CORS preflight, which the app never grants.
		expect(
			isCrossSiteForgery(
				request('POST', { origin: 'https://evil.example', 'content-type': 'application/json' }),
				SELF
			)
		).toBe(false);
	});

	it('lets a request with its own credential through, body or none', () => {
		for (const credential of <Record<string, string>[]>[
			{ authorization: 'Bearer cs_key' },
			{ 'x-api-key': 'cs_key' },
			{ 'x-cogsend-token': 'tick' },
			{ 'x-cogsend-scheduler': 'tick' }
		]) {
			expect(carriesCredential(new Headers(credential))).toBe(true);
			// curl -X DELETE, or a pinger's bodiless POST.
			expect(isCrossSiteForgery(request('DELETE', credential), SELF)).toBe(false);
			expect(isCrossSiteForgery(request('POST', credential), SELF)).toBe(false);
			// An API client uploading media as a form.
			expect(
				isCrossSiteForgery(
					request('POST', { ...credential, 'content-type': 'multipart/form-data; boundary=x' }),
					SELF
				)
			).toBe(false);
		}
	});

	it('does not count an empty or malformed credential header', () => {
		expect(carriesCredential(new Headers({ 'x-api-key': '   ' }))).toBe(false);
		expect(carriesCredential(new Headers({ authorization: 'Basic abc' }))).toBe(false);
		expect(isCrossSiteForgery(request('POST', { authorization: 'Bearer' }), SELF)).toBe(true);
	});
});

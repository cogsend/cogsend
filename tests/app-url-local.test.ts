import { describe, expect, it } from 'vitest';
import {
	isLocalAppUrl,
	isLocalRequestHost,
	isPinnedAppUrl,
	resolveAppUrl
} from '#lib/domain/app-url.js';

/**
 * The "local instance" signal decides whether example secrets are tolerated and
 * whether SKIP_TOTP can be honored. It is derived from the resolved APP_URL:
 * a deployment cannot know its URL before it exists, so the request's own
 * origin is adopted unless one is pinned — and a public origin is never local.
 */
describe('local instance detection', () => {
	it('recognises local APP_URLs', () => {
		for (const url of ['http://localhost:5173', 'http://127.0.0.1:8787', 'http://[::1]:3000']) {
			expect(isLocalAppUrl(url)).toBe(true);
		}
		for (const url of ['https://cogsend.example.com', '', null, 'not a url']) {
			expect(isLocalAppUrl(url)).toBe(false);
		}
	});

	it('recognises hosts that can only be reached locally', () => {
		for (const host of ['localhost', 'localhost:4173', 'dev.localhost', '127.0.0.1', '::1']) {
			expect(isLocalRequestHost(host)).toBe(true);
		}
		// A dev server opened from a phone on the same network is still local.
		expect(isLocalRequestHost('192.168.1.20:5173')).toBe(true);
		expect(isLocalRequestHost('10.0.0.5')).toBe(true);
		expect(isLocalRequestHost('172.20.3.4')).toBe(true);
		for (const host of ['cogsend.example.com', 'cogsend.acct.workers.dev', '172.32.0.1']) {
			expect(isLocalRequestHost(host)).toBe(false);
		}
	});

	it('treats only a non-local configured value as pinned', () => {
		expect(isPinnedAppUrl('https://cogsend.acct.workers.dev')).toBe(true);
		for (const value of ['http://localhost:5173', '', undefined, null, 'not a url']) {
			expect(isPinnedAppUrl(value)).toBe(false);
		}
	});
});

describe('resolveAppUrl', () => {
	const request = { requestUrl: 'https://cogsend.acct.workers.dev/login' };

	it('keeps a pinned APP_URL, whatever the request came in on', () => {
		expect(resolveAppUrl({ ...request, configured: 'https://cogsend.example.com/' })).toEqual({
			url: 'https://cogsend.example.com',
			source: 'configured'
		});
		expect(
			resolveAppUrl({
				requestUrl: 'http://192.168.1.20:5173/',
				configured: 'https://cogsend.example.com'
			})
		).toEqual({ url: 'https://cogsend.example.com', source: 'configured' });
	});

	it('adopts the request origin when APP_URL is unset', () => {
		expect(resolveAppUrl(request)).toEqual({
			url: 'https://cogsend.acct.workers.dev',
			source: 'request'
		});
	});

	it('adopts the request origin over the localhost value .dev.vars.example ships', () => {
		expect(resolveAppUrl({ ...request, configured: 'http://localhost:5173/' })).toEqual({
			url: 'https://cogsend.acct.workers.dev',
			source: 'request'
		});
	});

	it('keeps a localhost APP_URL for local requests, including LAN ones', () => {
		for (const requestUrl of ['http://localhost:5173/', 'http://192.168.1.20:5173/posts']) {
			expect(resolveAppUrl({ requestUrl, configured: 'http://localhost:5173' })).toEqual({
				url: 'http://localhost:5173',
				source: 'configured'
			});
		}
	});

	it('never adopts the wrapper\u2019s internal host', () => {
		expect(
			resolveAppUrl({
				requestUrl: 'https://cogsend.internal/api/internal/tick',
				stored: 'https://cogsend.acct.workers.dev'
			})
		).toEqual({ url: 'https://cogsend.acct.workers.dev', source: 'stored' });
	});
	it('reports nothing rather than the internal host when nothing is known', () => {
		// A cron tick on a deployment nobody has opened yet: an internal URL in
		// an email or a media link would be worse than no link at all.
		expect(resolveAppUrl({ requestUrl: 'https://cogsend.internal/api/internal/tick' })).toEqual({
			url: '',
			source: 'none'
		});
	});

	it('adopts a loopback request when nothing is configured', () => {
		expect(resolveAppUrl({ requestUrl: 'http://localhost:5173/posts' })).toEqual({
			url: 'http://localhost:5173',
			source: 'request'
		});
	});

	it('does not adopt a private LAN address', () => {
		// A dev server reached from a phone is not a public origin, and treating
		// it as one would let a spoofed Host header look local.
		expect(resolveAppUrl({ requestUrl: 'http://192.168.1.20:5173/posts' })).toEqual({
			url: '',
			source: 'none'
		});
		expect(
			resolveAppUrl({
				requestUrl: 'http://192.168.1.20:5173/posts',
				stored: 'http://localhost:5173'
			})
		).toEqual({ url: 'http://localhost:5173', source: 'stored' });
	});

	it('falls back to the remembered origin when there is no request', () => {
		expect(resolveAppUrl({ stored: 'https://cogsend.acct.workers.dev/' })).toEqual({
			url: 'https://cogsend.acct.workers.dev',
			source: 'stored'
		});
	});

	it('reports no origin when nothing is known, rather than inventing one', () => {
		expect(resolveAppUrl({})).toEqual({ url: '', source: 'none' });
	});
});

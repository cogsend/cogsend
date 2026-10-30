import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	PLATFORM_SETUP,
	PLATFORM_SECRET_NAMES,
	SETUP_GUIDE_URL,
	callbackUri,
	connectableNames,
	emptyStateSentence,
	isOAuthPlatform,
	joinPlatformNames,
	missingSecrets,
	needsSetup,
	platformConfigured,
	platformSecretNames,
	secretsPutCommand,
	secretsPutCommandFor,
	setupFor,
	setupGuideUrl,
	type PlatformConfigured
} from '#lib/domain/platform-setup.js';

/**
 * The accounts dialog shows a "Needs setup" chip and setup steps for the
 * platforms this deployment has no app credentials for. Everything it claims
 * there — which secrets, which redirect URI — is data in this module, so it is
 * checked here; the connect routes are checked against the same data in
 * tests/connections-connect.test.ts.
 */
const all: PlatformConfigured = { linkedin: true, threads: true, instagram: true, x: true };
const none: PlatformConfigured = { linkedin: false, threads: false, instagram: false, x: false };

describe('platform setup data', () => {
	it('knows the four platforms that need an app, and only those', () => {
		for (const id of ['linkedin', 'threads', 'instagram', 'x'])
			expect(isOAuthPlatform(id)).toBe(true);
		// Mastodon registers its app per instance and Bluesky takes an app
		// password: neither can be blocked on missing credentials.
		for (const id of ['mastodon', 'bluesky', '']) {
			expect(isOAuthPlatform(id)).toBe(false);
			expect(setupFor(id)).toBeNull();
			expect(needsSetup(id, none)).toBe(false);
		}
		expect(Object.keys(PLATFORM_SETUP)).toEqual(['linkedin', 'threads', 'instagram', 'x']);
	});

	it('only asks for a platform when the deployment lacks it', () => {
		for (const id of ['linkedin', 'threads', 'instagram', 'x'] as const) {
			expect(needsSetup(id, all)).toBe(false);
			expect(needsSetup(id, none)).toBe(true);
			expect(needsSetup(id, { ...all, [id]: false })).toBe(true);
		}
	});

	it('points every redirect URI at a callback route that exists', () => {
		for (const id of ['linkedin', 'threads', 'instagram', 'x'] as const) {
			const uri = callbackUri(id, 'https://social.example');
			expect(uri.startsWith('https://social.example/api/connections/')).toBe(true);
			const path = new URL(uri).pathname;
			expect(existsSync(`src/routes${path}/+server.ts`)).toBe(true);
		}
		// A trailing slash (or two) must not produce a doubled slash, because the
		// provider compares the registered URI character by character.
		for (const appUrl of ['https://social.example', 'https://social.example/', 'https://a.b//']) {
			expect(callbackUri('x', appUrl)).toBe(
				`${appUrl.replace(/\/+$/, '')}/api/connections/x/callback`
			);
		}
	});

	it('documents the steps it points at, in the repository', () => {
		expect(SETUP_GUIDE_URL).toContain('/blob/main/docs/oauth-apps.md');
		const doc = readFileSync('docs/oauth-apps.md', 'utf8');
		const headings = doc
			.split('\n')
			.filter((line) => line.startsWith('#'))
			.map((line) =>
				line
					.replace(/^#+\s*/, '')
					.toLowerCase()
					.replace(/[^a-z0-9 -]/g, '')
					.replace(/ /g, '-')
			);
		expect(headings).toContain(SETUP_GUIDE_URL.split('#')[1]);
		// Every platform links to its own section, so the dialog's "Full steps"
		// link lands on the right steps rather than the top of the page.
		for (const id of ['linkedin', 'threads', 'instagram', 'x'] as const) {
			const url = setupGuideUrl(id);
			expect([id, url.startsWith(`${SETUP_GUIDE_URL.split('#')[0]}#`)]).toEqual([id, true]);
			expect([id, headings.includes(PLATFORM_SETUP[id].docsAnchor)]).toEqual([id, true]);
			expect([id, url.endsWith(`#${PLATFORM_SETUP[id].docsAnchor}`)]).toEqual([id, true]);
		}
	});

	it('sends the reader to the console that issues the credentials', () => {
		for (const id of ['linkedin', 'threads', 'instagram', 'x'] as const) {
			const setup = PLATFORM_SETUP[id];
			// https and a real host: the dialog renders this as a link, so a typo
			// would be a dead end in the middle of the setup steps.
			expect([id, new URL(setup.consoleUrl).protocol]).toEqual([id, 'https:']);
			expect([id, setup.consoleName.length > 0]).toEqual([id, true]);
			// The field the redirect URI goes in, and the product or use case the
			// console demands first: the two things people miss.
			expect([id, setup.redirectField.length > 10]).toEqual([id, true]);
			expect([id, setup.consoleRequirement.length > 20]).toEqual([id, true]);
		}
	});

	it('names exactly the secrets the API reports presence for', () => {
		expect(PLATFORM_SECRET_NAMES).toEqual([
			'LINKEDIN_CLIENT_ID',
			'LINKEDIN_CLIENT_SECRET',
			'THREADS_APP_ID',
			'THREADS_APP_SECRET',
			'INSTAGRAM_APP_ID',
			'INSTAGRAM_APP_SECRET',
			'X_CLIENT_ID',
			'X_CLIENT_SECRET'
		]);
		expect(platformSecretNames('x')).toEqual(['X_CLIENT_ID', 'X_CLIENT_SECRET']);
	});

	it('asks only for the secrets a deployment is missing', () => {
		// The case that used to read "no credentials yet" while one credential
		// was already uploaded: the command must name the missing half alone.
		expect(missingSecrets('linkedin', { LINKEDIN_CLIENT_ID: true })).toEqual([
			'LINKEDIN_CLIENT_SECRET'
		]);
		expect(missingSecrets('linkedin', {})).toEqual([
			'LINKEDIN_CLIENT_ID',
			'LINKEDIN_CLIENT_SECRET'
		]);
		// X's secret is optional, so its absence does not gate the platform, but
		// it is still offered while nothing is set.
		expect(missingSecrets('x', { X_CLIENT_ID: true })).toEqual(['X_CLIENT_SECRET']);
		expect(secretsPutCommandFor(missingSecrets('x', {}))).toBe(
			'npm run secrets:put X_CLIENT_ID X_CLIENT_SECRET'
		);
		expect(secretsPutCommandFor(['THREADS_APP_SECRET'])).toBe(
			'npm run secrets:put THREADS_APP_SECRET'
		);
	});

	it('derives "configured" from the same presence the dialog shows', () => {
		for (const id of ['linkedin', 'threads', 'instagram', 'x'] as const) {
			const all = Object.fromEntries(platformSecretNames(id).map((name) => [name, true]));
			expect([id, platformConfigured(id, all)]).toEqual([id, true]);
			expect([id, platformConfigured(id, {})]).toEqual([id, false]);
			for (const name of PLATFORM_SETUP[id].secrets) {
				expect([id, name, platformConfigured(id, { ...all, [name]: false })]).toEqual([
					id,
					name,
					false
				]);
			}
		}
		// The chip the dialog renders comes from `needsSetup`, and the missing
		// list from `missingSecrets`: both have to agree about a platform.
		const present = { X_CLIENT_ID: true };
		const configured = {
			linkedin: platformConfigured('linkedin', present),
			threads: platformConfigured('threads', present),
			instagram: platformConfigured('instagram', present),
			x: platformConfigured('x', present)
		};
		expect(needsSetup('x', configured)).toBe(false);
		expect(needsSetup('linkedin', configured)).toBe(true);
	});
	it('spells out one paste-ready command per platform', () => {
		expect(secretsPutCommand('linkedin')).toBe(
			'npm run secrets:put LINKEDIN_CLIENT_ID LINKEDIN_CLIENT_SECRET'
		);
		expect(secretsPutCommand('threads')).toBe(
			'npm run secrets:put THREADS_APP_ID THREADS_APP_SECRET'
		);
		// X reads its secret when present, so the command offers it even though
		// `secrets:put` skips a name with no local value.
		expect(secretsPutCommand('x')).toBe('npm run secrets:put X_CLIENT_ID X_CLIENT_SECRET');
		expect(PLATFORM_SETUP.x.optionalSecrets).toEqual(['X_CLIENT_SECRET']);
		// Nothing optional anywhere else: those secrets are required.
		expect(PLATFORM_SETUP.linkedin.optionalSecrets).toBeUndefined();
		expect(PLATFORM_SETUP.threads.optionalSecrets).toBeUndefined();
	});
});

describe('empty-state sentence', () => {
	it('lists only the platforms that can be connected', () => {
		expect(emptyStateSentence(all)).toBe(
			'No accounts yet. Connect Bluesky, Mastodon, LinkedIn, Threads, Instagram, or X to start posting.'
		);
		// The case behind the change: no app credentials anywhere, so naming
		// LinkedIn, Threads or X would offer something this deployment cannot do.
		expect(emptyStateSentence(none)).toBe(
			'No accounts yet. Connect Bluesky or Mastodon to start posting.'
		);
		expect(emptyStateSentence({ ...none, linkedin: true })).toBe(
			'No accounts yet. Connect Bluesky, Mastodon, or LinkedIn to start posting.'
		);
		expect(connectableNames(none)).toEqual(['Bluesky', 'Mastodon']);
	});

	it('joins names the way the sentence reads', () => {
		expect(joinPlatformNames([])).toBe('');
		expect(joinPlatformNames(['Bluesky'])).toBe('Bluesky');
		expect(joinPlatformNames(['Bluesky', 'Mastodon'])).toBe('Bluesky or Mastodon');
		expect(joinPlatformNames(['Bluesky', 'Mastodon', 'X'])).toBe('Bluesky, Mastodon, or X');
	});
});

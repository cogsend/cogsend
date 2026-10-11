import { describe, expect, it } from 'vitest';
import { TEST_ENV } from '#lib/server/db/test.js';
import { readAppEnv } from '#lib/server/env.js';

/**
 * The placeholder guard is what stops a deploy from running with the example
 * values that ship in .dev.vars.example — publish-time that would mean a
 * publicly-known key protecting every stored OAuth token and the TOTP secret.
 *
 * It used to key off NODE_ENV, which nothing ever set, so it could never fire.
 * These tests pin the current rule: example values are tolerated only when
 * APP_URL points at a local instance.
 */

// Shipped in .dev.vars.example and used by the e2e fixture.
const EXAMPLE_KEY = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const EXAMPLE_AUTH_SECRET = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

const deployed = {
	APP_URL: 'https://social.example.com',
	APP_ENCRYPTION_KEY: TEST_ENV.APP_ENCRYPTION_KEY,
	AUTH_SECRET: TEST_ENV.AUTH_SECRET
};

const local = { ...deployed, APP_URL: 'http://localhost:5173' };

describe('example-value guard', () => {
	it('accepts the example values on a local instance', () => {
		const env = readAppEnv({ ...local, APP_ENCRYPTION_KEY: EXAMPLE_KEY });
		expect(env.APP_ENCRYPTION_KEY).toBe(EXAMPLE_KEY);
	});

	it('refuses an example encryption key against a real deployment', () => {
		expect(() => readAppEnv({ ...deployed, APP_ENCRYPTION_KEY: EXAMPLE_KEY })).toThrow(
			/APP_ENCRYPTION_KEY must not be an example value/
		);
	});

	it('refuses an example session secret against a real deployment', () => {
		expect(() => readAppEnv({ ...deployed, AUTH_SECRET: EXAMPLE_AUTH_SECRET })).toThrow(
			/AUTH_SECRET must not be an example value/
		);
	});

	it('accepts real values against a real deployment', () => {
		expect(() => readAppEnv(deployed)).not.toThrow();
	});
});

describe('SKIP_TOTP', () => {
	it('is honored on a local instance', () => {
		expect(readAppEnv({ ...local, SKIP_TOTP: '1' }).skipTotp).toBe(true);
	});

	it('is ignored against a real deployment, so it can never weaken 2FA there', () => {
		expect(readAppEnv({ ...deployed, SKIP_TOTP: '1' }).skipTotp).toBe(false);
	});

	it('is ignored for falsy spellings', () => {
		for (const value of ['0', 'false', 'no', 'off', '']) {
			expect(readAppEnv({ ...local, SKIP_TOTP: value }).skipTotp).toBe(false);
		}
	});
});

describe('APP_URL', () => {
	it('is optional, but an unset one is never a local instance', () => {
		const { APP_URL: _omitted, ...withoutAppUrl } = deployed;
		// No URL known yet (a scheduled invocation before the first visit): the
		// example values are still refused, and nothing pretends to be local.
		expect(readAppEnv(withoutAppUrl).APP_URL).toBe('');
		expect(() => readAppEnv({ ...withoutAppUrl, APP_ENCRYPTION_KEY: EXAMPLE_KEY })).toThrow(
			/APP_ENCRYPTION_KEY must not be an example value/
		);
	});

	it('treats loopback spellings as local', () => {
		for (const url of [
			'http://localhost:5173',
			'http://127.0.0.1:8787',
			'http://[::1]:5173',
			'http://0.0.0.0:5173'
		]) {
			expect(readAppEnv({ ...deployed, APP_URL: url, SKIP_TOTP: '1' }).skipTotp).toBe(true);
		}
	});

	it('does not treat an unparseable URL as local', () => {
		expect(readAppEnv({ ...deployed, APP_URL: 'not-a-url', SKIP_TOTP: '1' }).skipTotp).toBe(false);
	});
});

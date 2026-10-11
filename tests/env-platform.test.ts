import { afterEach, describe, expect, it, vi } from 'vitest';
import { envFromPlatform } from '#lib/server/env.js';
import { deriveSecrets } from '#lib/server/derived-secrets.js';
import { TEST_ENV } from '#lib/server/db/test.js';

/**
 * `envFromPlatform` is the only path a real Worker takes to its configuration
 * (bindings + `[vars]`), and the test suite exercised `readAppEnv` alone.
 */
describe('envFromPlatform', () => {
	afterEach(() => vi.unstubAllEnvs());

	it('reads the Worker bindings, ignoring non-string entries', async () => {
		const env = await envFromPlatform({
			APP_URL: 'https://cogsend.example',
			APP_NAME: 'My Scheduler',
			APP_ENCRYPTION_KEY: TEST_ENV.APP_ENCRYPTION_KEY,
			AUTH_SECRET: TEST_ENV.AUTH_SECRET,
			// Real bindings ride along in the same object and must not be coerced.
			DB: { prepare: () => {} },
			MEDIA: { get: () => {} }
		});

		expect(env.APP_URL).toBe('https://cogsend.example');
		expect(env.APP_NAME).toBe('My Scheduler');
		expect(env.skipTotp).toBe(false);
	});

	it('falls back to the process environment for anything the binding omits', async () => {
		vi.stubEnv('SCHEDULER_SECRET', 'from-process-env-at-least-32-chars');
		const env = await envFromPlatform({
			APP_URL: 'https://cogsend.example',
			APP_ENCRYPTION_KEY: TEST_ENV.APP_ENCRYPTION_KEY,
			AUTH_SECRET: TEST_ENV.AUTH_SECRET
		});

		expect(env.SCHEDULER_SECRET).toBe('from-process-env-at-least-32-chars');
	});

	it('treats an empty binding value as absent so the fallback applies', async () => {
		vi.stubEnv('APP_NAME', 'from-process-env');
		const env = await envFromPlatform({
			APP_URL: 'https://cogsend.example',
			APP_NAME: '',
			APP_ENCRYPTION_KEY: TEST_ENV.APP_ENCRYPTION_KEY,
			AUTH_SECRET: TEST_ENV.AUTH_SECRET
		});

		expect(env.APP_NAME).toBe('from-process-env');
	});

	it('still fails closed on an example secret for a real deployment', async () => {
		await expect(
			envFromPlatform({
				APP_URL: 'https://cogsend.example',
				APP_ENCRYPTION_KEY: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
				AUTH_SECRET: 'dev-auth-secret-change-me'
			})
		).rejects.toThrow();
	});

	it('allows the local-development defaults on a localhost APP_URL', async () => {
		const env = await envFromPlatform({
			APP_URL: 'http://localhost:5173',
			APP_ENCRYPTION_KEY: 'local-dev-encryption-key-32-chars!!',
			AUTH_SECRET: 'local-dev-auth-secret-16'
		});

		expect(env.APP_URL).toBe('http://localhost:5173');
	});
});

describe('derived secrets', () => {
	const master = 'feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface';
	const base = {
		APP_ENCRYPTION_KEY: master
	};

	it('derives AUTH_SECRET and SCHEDULER_SECRET from APP_ENCRYPTION_KEY', async () => {
		const secrets = await deriveSecrets(master);
		const env = await envFromPlatform(base);

		expect(env.AUTH_SECRET).toBe(secrets.authSecret);
		expect(env.SCHEDULER_SECRET).toBe(secrets.schedulerSecret);
		// 64 hex characters: clear of the schema's 16/32 minimums.
		expect(env.AUTH_SECRET).toMatch(/^[0-9a-f]{64}$/);
		expect(env.SCHEDULER_SECRET).toMatch(/^[0-9a-f]{64}$/);
		// The two must not be interchangeable.
		expect(env.AUTH_SECRET).not.toBe(env.SCHEDULER_SECRET);
	});

	it('lets an explicit value win, one at a time', async () => {
		const both = await envFromPlatform({
			...base,
			AUTH_SECRET: 'explicit-auth-secret',
			SCHEDULER_SECRET: 'explicit-scheduler-secret-at-least-32'
		});
		expect(both.AUTH_SECRET).toBe('explicit-auth-secret');
		expect(both.SCHEDULER_SECRET).toBe('explicit-scheduler-secret-at-least-32');

		const mixed = await envFromPlatform({ ...base, AUTH_SECRET: 'explicit-auth-secret' });
		const derived = await deriveSecrets(master);
		expect(mixed.AUTH_SECRET).toBe('explicit-auth-secret');
		expect(mixed.SCHEDULER_SECRET).toBe(derived.schedulerSecret);
	});

	it('is not fooled by a placeholder master key on a real deployment', async () => {
		await expect(
			envFromPlatform({
				...base,
				APP_URL: 'https://cogsend.acct.workers.dev',
				APP_ENCRYPTION_KEY: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
			})
		).rejects.toThrow(/APP_ENCRYPTION_KEY must not be an example value/);
	});
});

describe('APP_URL resolution', () => {
	afterEach(() => vi.unstubAllEnvs());

	const secrets = {
		APP_ENCRYPTION_KEY: TEST_ENV.APP_ENCRYPTION_KEY,
		AUTH_SECRET: TEST_ENV.AUTH_SECRET
	};

	it('adopts the request origin when APP_URL is unset', async () => {
		const env = await envFromPlatform(secrets, {
			requestUrl: 'https://cogsend.acct.workers.dev/login'
		});
		expect(env.APP_URL).toBe('https://cogsend.acct.workers.dev');
		expect(env.appUrlSource).toBe('request');
	});

	it('replaces a localhost APP_URL on a real host, and stays strict about example secrets', async () => {
		const env = await envFromPlatform(
			{ ...secrets, APP_URL: 'http://localhost:5173' },
			{ requestUrl: 'https://cogsend.acct.workers.dev/' }
		);
		expect(env.APP_URL).toBe('https://cogsend.acct.workers.dev');
		expect(env.appUrlSource).toBe('request');
		await expect(
			envFromPlatform(
				{
					...secrets,
					APP_URL: 'http://localhost:5173',
					APP_ENCRYPTION_KEY: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
				},
				{ requestUrl: 'https://cogsend.acct.workers.dev/' }
			)
		).rejects.toThrow(/APP_ENCRYPTION_KEY must not be an example value/);
	});

	it('keeps a pinned APP_URL over the request origin', async () => {
		const env = await envFromPlatform(
			{ ...secrets, APP_URL: 'https://cogsend.example.com' },
			{ requestUrl: 'https://cogsend.acct.workers.dev/' }
		);
		expect(env.APP_URL).toBe('https://cogsend.example.com');
		expect(env.appUrlSource).toBe('configured');
	});

	it('uses the remembered origin when the wrapper calls itself', async () => {
		const env = await envFromPlatform(secrets, {
			requestUrl: 'https://cogsend.internal/api/internal/tick',
			storedAppUrl: 'https://cogsend.acct.workers.dev'
		});
		expect(env.APP_URL).toBe('https://cogsend.acct.workers.dev');
		expect(env.appUrlSource).toBe('stored');
	});
});

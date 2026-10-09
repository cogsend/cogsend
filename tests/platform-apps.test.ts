import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AppDb } from '$lib/server/db/client';
import { appSettings, users } from '$lib/server/db/schema';
import { createTestDb, TEST_ENV } from '$lib/server/db/test';
import { secretLabel } from '$lib/domain/platform-setup';
import {
	platformAppSettingKey,
	platformCredentialStatus,
	resolvePlatformCredentials
} from '$lib/server/platform-credentials';
import { GET as connectionsGET } from '../src/routes/api/connections/+server';
import { POST as xPOST } from '../src/routes/api/connections/x/+server';
import { POST as linkedinPOST } from '../src/routes/api/connections/linkedin/+server';
import {
	DELETE as appDELETE,
	PUT as appPUT
} from '../src/routes/api/settings/platform-apps/[platform]/+server';

/**
 * OAuth app credentials entered in the accounts dialog instead of as Worker
 * secrets. What matters: they work for connecting, they never come back out,
 * Worker secrets keep winning, and only a signed-in browser can set them.
 */
describe('OAuth app credentials stored in the app', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;

	beforeEach(async () => {
		({ db, close } = await createTestDb());
		userId = crypto.randomUUID();
		await db.insert(users).values({
			id: userId,
			email: 'apps@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: new Date(),
			updatedAt: new Date()
		});
	});

	afterEach(() => close());

	const session = (env = TEST_ENV, authMethod: 'session' | 'bearer' = 'session') => ({
		db,
		env,
		user: {
			id: userId,
			email: 'apps@localhost',
			timezone: 'UTC',
			totpEnabled: true,
			mfaVerified: true
		},
		authMethod
	});

	function call(
		handler: unknown,
		{
			platform = 'x',
			body,
			method = 'PUT',
			locals = session()
		}: { platform?: string; body?: unknown; method?: string; locals?: unknown } = {}
	) {
		return (handler as (event: unknown) => Promise<Response>)({
			request: new Request(`http://localhost/api/settings/platform-apps/${platform}`, {
				method,
				headers: { 'Content-Type': 'application/json' },
				...(body === undefined ? {} : { body: JSON.stringify(body) })
			}),
			params: { platform },
			locals,
			cookies: { get: () => 'session-token' },
			url: new URL(`http://localhost/api/settings/platform-apps/${platform}`)
		} as never);
	}

	const X_APP = { X_CLIENT_ID: 'stored-client-1234', X_CLIENT_SECRET: 'stored-secret-value' };

	it('saves, reports where they came from, and never sends a credential back', async () => {
		const res = await call(appPUT, { body: X_APP });
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).not.toContain(X_APP.X_CLIENT_ID);
		expect(text).not.toContain(X_APP.X_CLIENT_SECRET);
		const data = JSON.parse(text);
		expect(data.configured.x).toBe(true);
		expect(data.sources.x).toBe('app');
		expect(data.secrets).toMatchObject({ X_CLIENT_ID: true, X_CLIENT_SECRET: true });
		expect(data.savedClientIds.x).toBe('1234');

		// Stored encrypted, not as typed.
		const row = (
			await db
				.select()
				.from(appSettings)
				.where(eq(appSettings.key, platformAppSettingKey('x')))
		)[0];
		expect(row.value).not.toContain(X_APP.X_CLIENT_ID);
		expect(row.value).not.toContain(X_APP.X_CLIENT_SECRET);

		const listed = await connectionsGET({ locals: session() } as never);
		const listText = await listed.text();
		expect(listText).not.toContain(X_APP.X_CLIENT_SECRET);
		expect(JSON.parse(listText).configured.x).toBe(true);
	});

	it('lets a connect request use the stored app', async () => {
		await call(appPUT, { body: X_APP });
		const res = await call(xPOST, { locals: session() });
		expect(res.status).toBe(200);
		const { authorizeUrl } = await res.json();
		expect(new URL(authorizeUrl).searchParams.get('client_id')).toBe(X_APP.X_CLIENT_ID);
	});

	it('keeps Worker secrets in charge when they are set', async () => {
		const env = { ...TEST_ENV, X_CLIENT_ID: 'env-client', X_CLIENT_SECRET: 'env-secret' };
		const refused = await call(appPUT, { body: X_APP, locals: session(env) });
		expect(refused.status).toBe(409);

		// Even a value stored before the secrets were added is not used.
		await call(appPUT, { body: X_APP });
		const resolved = await resolvePlatformCredentials(db, env, 'x');
		expect(resolved).toEqual({
			source: 'env',
			values: { X_CLIENT_ID: 'env-client', X_CLIENT_SECRET: 'env-secret' }
		});
		const status = await platformCredentialStatus(db, env);
		expect(status.sources.x).toBe('env');
	});

	it('requires every required value and ignores names the platform does not read', async () => {
		const missing = await call(appPUT, {
			platform: 'linkedin',
			body: { LINKEDIN_CLIENT_ID: 'only-the-id' }
		});
		expect(missing.status).toBe(400);
		expect((await missing.json()).error).toContain('LINKEDIN_CLIENT_SECRET');

		await call(appPUT, {
			platform: 'linkedin',
			body: {
				LINKEDIN_CLIENT_ID: ' li-id ',
				LINKEDIN_CLIENT_SECRET: 'li-secret',
				APP_ENCRYPTION_KEY: 'smuggled'
			}
		});
		const resolved = await resolvePlatformCredentials(db, TEST_ENV, 'linkedin');
		expect(resolved?.values).toEqual({
			LINKEDIN_CLIENT_ID: 'li-id',
			LINKEDIN_CLIENT_SECRET: 'li-secret'
		});
		const connect = await call(linkedinPOST, { locals: session() });
		expect(connect.status).toBe(200);
	});

	it('takes X with only a client id, since the secret is optional there', async () => {
		const res = await call(appPUT, { body: { X_CLIENT_ID: 'public-client' } });
		expect(res.status).toBe(200);
		expect((await resolvePlatformCredentials(db, TEST_ENV, 'x'))?.values).toEqual({
			X_CLIENT_ID: 'public-client'
		});
	});

	it('removes them', async () => {
		await call(appPUT, { body: X_APP });
		const res = await call(appDELETE, { method: 'DELETE' });
		expect(res.status).toBe(200);
		expect((await res.json()).configured.x).toBe(false);
		expect(await resolvePlatformCredentials(db, TEST_ENV, 'x')).toBeNull();
		const connect = await call(xPOST, { locals: session() });
		expect(connect.status).toBe(409);
	});

	it('refuses API keys, unknown platforms, and an unverified session', async () => {
		expect((await call(appPUT, { body: X_APP, locals: session(TEST_ENV, 'bearer') })).status).toBe(
			401
		);
		expect((await call(appPUT, { platform: 'mastodon', body: X_APP })).status).toBe(404);
		const unverified = {
			...session(),
			user: { ...session().user, mfaVerified: false }
		};
		expect((await call(appPUT, { body: X_APP, locals: unverified })).status).toBe(401);
		expect(await resolvePlatformCredentials(db, TEST_ENV, 'x')).toBeNull();
	});

	it('treats credentials saved under another encryption key as missing', async () => {
		await call(appPUT, { body: X_APP });
		const rotated = {
			...TEST_ENV,
			APP_ENCRYPTION_KEY: 'another-key-that-is-at-least-32-chars-long'
		};
		expect(await resolvePlatformCredentials(db, rotated, 'x')).toBeNull();
		expect((await platformCredentialStatus(db, rotated)).configured.x).toBe(false);
	});

	it('labels the form fields the way the consoles do', () => {
		expect(secretLabel('X_CLIENT_ID')).toBe('Client ID');
		expect(secretLabel('X_CLIENT_SECRET')).toBe('Client secret');
		expect(secretLabel('THREADS_APP_ID')).toBe('App ID');
		expect(secretLabel('THREADS_APP_SECRET')).toBe('App secret');
		expect(secretLabel('LINKEDIN_CLIENT_ID')).toBe('Client ID');
	});
});

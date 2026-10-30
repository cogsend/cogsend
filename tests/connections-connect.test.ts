import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { oauthPending, users } from '#lib/server/db/schema.js';
import { createTestDb, TEST_ENV } from '#lib/server/db/test.js';
import { GET as connectionsGET } from '../src/routes/api/connections/+server';
import { POST as linkedinPOST } from '../src/routes/api/connections/linkedin/+server';
import { POST as mastodonPOST } from '../src/routes/api/connections/mastodon/+server';
import { POST as instagramPOST } from '../src/routes/api/connections/instagram/+server';
import { POST as threadsPOST } from '../src/routes/api/connections/threads/+server';
import { POST as xPOST } from '../src/routes/api/connections/x/+server';
import { platformName } from '#lib/domain/platforms.js';
import { PLATFORM_SECRET_NAMES, PLATFORM_SETUP } from '#lib/domain/platform-setup.js';
import { OAUTH_PENDING_TTL_MS } from '#lib/domain/oauth-pending.js';

/**
 * The connect entry points. They were untested: a regression here (a
 * dropped state binding, a wrong pending marker, a leaked authorize URL shape)
 * only surfaced when someone tried to connect a real account.
 */
describe('connect routes', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;

	/** Every provider configured, so the happy paths can run. */
	const env = {
		...TEST_ENV,
		THREADS_APP_ID: 'threads-app',
		THREADS_APP_SECRET: 'threads-secret',
		INSTAGRAM_APP_ID: 'ig-app',
		INSTAGRAM_APP_SECRET: 'ig-secret',
		X_CLIENT_ID: 'x-client',
		X_CLIENT_SECRET: 'x-secret',
		LINKEDIN_CLIENT_ID: 'li-client',
		LINKEDIN_CLIENT_SECRET: 'li-secret'
	};

	const locals = (overrides: Record<string, unknown> = {}) => ({
		db,
		env,
		user: {
			id: userId,
			email: 'connect@localhost',
			timezone: 'UTC',
			totpEnabled: true,
			mfaVerified: true
		},
		authMethod: 'session' as const,
		...overrides
	});

	const call = (handler: unknown, body?: unknown, overrides: Record<string, unknown> = {}) =>
		(handler as (event: unknown) => Promise<Response>)({
			request: new Request('http://localhost/api/connections', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				...(body === undefined ? {} : { body: JSON.stringify(body) })
			}),
			locals: locals(overrides),
			cookies: { get: () => 'session-token' },
			url: new URL('http://localhost/api/connections')
		} as never) as Promise<Response>;

	const pendingFor = async (marker: string) =>
		(await db.select().from(oauthPending).where(eq(oauthPending.instanceUrl, marker)))[0];

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'connect@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
	});
	afterAll(() => close());
	afterEach(() => vi.unstubAllGlobals());

	it('refuses bearer credentials — connecting is session-only', async () => {
		for (const handler of [mastodonPOST, threadsPOST, instagramPOST, xPOST, linkedinPOST]) {
			const res = await call(
				handler,
				{ instanceUrl: 'https://mastodon.example' },
				{
					authMethod: 'bearer'
				}
			);
			expect(res.status).toBe(401);
		}
	});

	it('answers a platform it has no credentials for with a setup code, not a 500', async () => {
		// Mastodon is not in this list on purpose: it registers an app on the
		// instance itself and needs no client credentials of its own.
		for (const [handler, platform, secrets] of [
			[threadsPOST, 'threads', ['THREADS_APP_ID', 'THREADS_APP_SECRET']],
			[instagramPOST, 'instagram', ['INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET']],
			[xPOST, 'x', ['X_CLIENT_ID']],
			[linkedinPOST, 'linkedin', ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET']]
		] as const) {
			const res = await call(handler, undefined, { env: { ...TEST_ENV } });
			expect(res.status).toBe(409);
			const body = (await res.json()) as {
				error: string;
				code?: string;
				platform?: string;
				secrets?: string[];
			};
			// The dialog turns this code into its setup panel; `secrets` is what
			// the panel tells the operator to set.
			expect(body.code).toBe('platform_not_configured');
			expect(body.platform).toBe(platform);
			expect(body.secrets).toEqual([...secrets]);
			// `error` is the sentence the person connecting reads, so it names the
			// platform and no environment variable.
			expect(body.error).toMatch(new RegExp(`${platformName(platform)} is not enabled`, 'i'));
			expect(body.error).not.toMatch(/CLIENT_ID|APP_ID|SECRET/);
		}
	});

	/**
	 * The setup panel's "add these secrets" list is only true while it matches
	 * what the routes actually require, so iterate the same data the panel uses
	 * and take each secret away in turn. X's client secret is deliberately in
	 * neither list: PKCE finishes the exchange without it.
	 */
	it('requires exactly the secrets the setup panel lists', async () => {
		for (const [handler, platform] of [
			[threadsPOST, 'threads'],
			[instagramPOST, 'instagram'],
			[xPOST, 'x'],
			[linkedinPOST, 'linkedin']
		] as const) {
			const setup = PLATFORM_SETUP[platform];
			const complete: Record<string, unknown> = { ...env };
			for (const secret of setup.optionalSecrets ?? []) delete complete[secret];
			// Everything required, nothing optional: the platform connects.
			expect((await call(handler, undefined, { env: complete })).status).toBe(200);

			for (const secret of setup.secrets) {
				const missing = { ...complete };
				delete missing[secret];
				const res = await call(handler, undefined, { env: missing });
				expect([platform, secret, res.status]).toEqual([platform, secret, 409]);
				expect(((await res.json()) as { code?: string }).code).toBe('platform_not_configured');
			}
		}
	});

	it('reports which platforms have credentials, and the URL to register with them', async () => {
		// The accounts dialog renders a "Needs setup" chip from `configured` and
		// the redirect URI from `appUrl`. Both have to describe this deployment,
		// not the browser: a provider compares the registered URI character by
		// character against the one the connect route sends.
		const withAll = {
			...env,
			APP_URL: 'https://cogsend.example.com/'
		};
		const res = (await (connectionsGET as (event: unknown) => Promise<Response>)({
			request: new Request('http://localhost/api/connections'),
			locals: locals({ env: withAll }),
			cookies: { get: () => 'session-token' },
			url: new URL('http://localhost/api/connections')
		} as never)) as Response;
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			configured: Record<string, boolean>;
			secrets: Record<string, boolean>;
			appUrl?: string;
		};
		expect(body.configured).toEqual({ linkedin: true, threads: true, instagram: true, x: true });
		expect(body.appUrl).toBe('https://cogsend.example.com/');
		// Presence per secret, not just per platform: this is what lets the
		// dialog name the missing half instead of repeating "no credentials".
		expect(Object.keys(body.secrets).sort()).toEqual([...PLATFORM_SECRET_NAMES].sort());
		expect(Object.values(body.secrets).every(Boolean)).toBe(true);

		const bare = (await (connectionsGET as (event: unknown) => Promise<Response>)({
			request: new Request('http://localhost/api/connections'),
			locals: locals({ env: { ...TEST_ENV } }),
			cookies: { get: () => 'session-token' },
			url: new URL('http://localhost/api/connections')
		} as never)) as Response;
		const bareBody = (await bare.json()) as {
			configured: Record<string, boolean>;
			secrets: Record<string, boolean>;
		};
		expect(bareBody.configured).toEqual({
			linkedin: false,
			threads: false,
			instagram: false,
			x: false
		});
		expect(Object.values(bareBody.secrets).some(Boolean)).toBe(false);
		// Half uploaded: the state that used to be indistinguishable from
		// nothing at all, because one missing secret disables the platform.
		const half = (await (connectionsGET as (event: unknown) => Promise<Response>)({
			request: new Request('http://localhost/api/connections'),
			locals: locals({ env: { ...TEST_ENV, LINKEDIN_CLIENT_ID: 'li-client' } }),
			cookies: { get: () => 'session-token' },
			url: new URL('http://localhost/api/connections')
		} as never)) as Response;
		const halfBody = (await half.json()) as {
			configured: Record<string, boolean>;
			secrets: Record<string, boolean>;
		};
		expect(halfBody.secrets.LINKEDIN_CLIENT_ID).toBe(true);
		expect(halfBody.secrets.LINKEDIN_CLIENT_SECRET).toBe(false);
		expect(halfBody.configured.linkedin).toBe(false);
	});

	it('binds X state, stores a PKCE verifier and returns an authorize URL', async () => {
		const res = await call(xPOST);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { authorizeUrl: string };
		const url = new URL(body.authorizeUrl);
		expect(url.searchParams.get('code_challenge')).toBeTruthy();
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(url.searchParams.get('state')).toBeTruthy();

		const row = await pendingFor('x');
		expect(row.clientId).toBe('x-client');
		// The window a visitor has to get through the provider's login, 2FA and
		// consent screens: too short and they come back to "oauth_expired" with
		// nothing to act on.
		const windowMs = row.expiresAt.getTime() - Date.now();
		expect(windowMs).toBeGreaterThan(OAUTH_PENDING_TTL_MS - 60_000);
		expect(windowMs).toBeLessThanOrEqual(OAUTH_PENDING_TTL_MS);
		// The verifier travels encrypted, packed with the client secret.
		expect(row.clientSecretEnc).not.toContain('x-secret');
	});

	it('returns Threads, Instagram and LinkedIn authorize URLs with a bound state', async () => {
		for (const [handler, marker, client] of [
			[threadsPOST, 'threads', 'threads-app'],
			[instagramPOST, 'instagram', 'ig-app'],
			[linkedinPOST, 'linkedin', 'li-client']
		] as const) {
			const res = await call(handler);
			expect(res.status).toBe(200);
			const body = (await res.json()) as { authorizeUrl: string };
			const url = new URL(body.authorizeUrl);
			expect(url.searchParams.get('state')).toBeTruthy();
			expect(url.searchParams.get('client_id')).toBe(client);

			const row = await pendingFor(marker);
			expect(row.userId).toBe(userId);
			expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
			if (marker === 'instagram') {
				expect(url.origin + url.pathname).toBe('https://www.instagram.com/oauth/authorize');
				expect(url.searchParams.get('scope')).toBe(
					'instagram_business_basic,instagram_business_content_publish'
				);
				expect(url.searchParams.get('redirect_uri')).toMatch(
					/\/api\/connections\/instagram\/callback$/
				);
			}
		}
	});

	it('rejects a Mastodon instance the SSRF guard blocks', async () => {
		const fetched = vi.fn();
		vi.stubGlobal('fetch', fetched);
		// A real APP_URL keeps the local-host allowance off. The test env points
		// at localhost, which deliberately relaxes it so a local instance can be
		// connected.
		const production = { ...env, APP_URL: 'https://cogsend.example' };
		for (const instanceUrl of [
			'http://127.0.0.1:3000',
			'http://169.254.169.254',
			'metadata.google.internal',
			'https://db.internal'
		]) {
			const res = await call(mastodonPOST, { instanceUrl }, { env: production });
			expect(res.status).toBe(400);
		}
		expect(fetched).not.toHaveBeenCalled();
	});

	it('registers a Mastodon app and stores the pending row under the instance URL', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: unknown) => {
				const url = String(input);
				if (url.endsWith('/api/v1/apps')) {
					return Response.json({ client_id: 'cid', client_secret: 'csecret' });
				}
				return new Response('unmocked', { status: 404 });
			})
		);
		const res = await call(mastodonPOST, { instanceUrl: 'https://mastodon.example' });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { authorizeUrl: string };
		const url = new URL(body.authorizeUrl);
		expect(url.host).toBe('mastodon.example');
		expect(url.pathname).toBe('/oauth/authorize');

		// Mastodon stores the real instance URL (not a marker) so the callback
		// can match one row per account per instance.
		const row = await pendingFor('https://mastodon.example');
		expect(row.clientId).toBe('cid');
		expect(row.clientSecretEnc).not.toContain('csecret');
	});
});

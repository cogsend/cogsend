import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { newId } from '#lib/server/db/client.js';
import type { AppDb } from '#lib/server/db/client.js';
import { connections, oauthPending, users } from '#lib/server/db/schema.js';
import { createTestDb, TEST_ENV } from '#lib/server/db/test.js';
import { decryptJson, encryptSecret } from '#lib/server/crypto.js';
import { bindOAuthState } from '#lib/server/oauth-state.js';
import { GET as instagramCallback } from '../src/routes/api/connections/instagram/callback/+server';
import { GET as linkedinCallback } from '../src/routes/api/connections/linkedin/callback/+server';

async function redirected(call: () => unknown): Promise<{ status: number; location: string }> {
	try {
		await call();
	} catch (e) {
		const err = e as { status?: number; location?: string };
		if (typeof err?.status === 'number')
			return { status: err.status, location: String(err.location ?? '') };
		throw e;
	}
	throw new Error('expected a redirect');
}

describe('linkedin oauth callback', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'oauth@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
	});
	afterAll(() => {
		vi.unstubAllGlobals();
		close();
	});

	async function seedPending() {
		const pendingId = newId();
		await db.insert(oauthPending).values({
			id: pendingId,
			userId,
			instanceUrl: 'linkedin',
			clientId: 'test-client',
			clientSecretEnc: await encryptSecret('test-secret', TEST_ENV.APP_ENCRYPTION_KEY),
			expiresAt: new Date(Date.now() + 10 * 60_000),
			createdAt: new Date()
		});
		return pendingId;
	}

	function linkedinFetch() {
		return vi.fn(async (input: unknown) => {
			const url = String(input);
			if (url.includes('/oauth/v2/accessToken')) {
				return Response.json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
			}
			if (url.includes('/v2/userinfo')) {
				return Response.json({ sub: 'li-sub-1', name: 'Li User', email: 'li@example.com' });
			}
			return new Response('unmocked', { status: 404 });
		});
	}

	it('creates the connection for a bound state', async () => {
		const pendingId = await seedPending();
		const state = await bindOAuthState({
			secret: TEST_ENV.AUTH_SECRET!,
			pendingId,
			sessionId: 'sess-1'
		});
		vi.stubGlobal('fetch', linkedinFetch());
		const url = new URL(
			`http://localhost/api/connections/linkedin/callback?code=CODE&state=${encodeURIComponent(state)}`
		);
		const out = await redirected(() =>
			linkedinCallback({
				url,
				locals: { db, env: TEST_ENV },
				cookies: { get: () => 'sess-1' }
			} as never)
		);
		expect(out.status).toBe(302);
		expect(out.location).toContain('/accounts');
		expect(out.location).toContain('connected=linkedin');
		const rows = await db.select().from(connections).where(eq(connections.userId, userId));
		expect(rows).toHaveLength(1);
		expect(rows[0].platform).toBe('linkedin');
	});

	it('rejects a state bound to another session', async () => {
		const pendingId = await seedPending();
		const state = await bindOAuthState({
			secret: TEST_ENV.AUTH_SECRET!,
			pendingId,
			sessionId: 'sess-1'
		});
		vi.stubGlobal('fetch', linkedinFetch());
		const url = new URL(
			`http://localhost/api/connections/linkedin/callback?code=CODE&state=${encodeURIComponent(state)}`
		);
		const out = await redirected(() =>
			linkedinCallback({
				url,
				locals: { db, env: TEST_ENV },
				cookies: { get: () => 'sess-2' }
			} as never)
		);
		expect(out.status).toBe(302);
		expect(out.location).toContain('/accounts');
		expect(out.location).toContain('oauth_expired');
	});
});

describe('instagram oauth callback', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'ig-oauth@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
	});
	afterAll(() => {
		vi.unstubAllGlobals();
		close();
	});

	async function connect(username: string, accountType = 'BUSINESS') {
		const pendingId = newId();
		await db.insert(oauthPending).values({
			id: pendingId,
			userId,
			instanceUrl: 'instagram',
			clientId: 'ig-app',
			clientSecretEnc: await encryptSecret('ig-secret', TEST_ENV.APP_ENCRYPTION_KEY),
			expiresAt: new Date(Date.now() + 10 * 60_000),
			createdAt: new Date()
		});
		const state = await bindOAuthState({
			secret: TEST_ENV.AUTH_SECRET!,
			pendingId,
			sessionId: 'sess-ig'
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: unknown) => {
				const url = String(input);
				if (url.includes('api.instagram.com/oauth/access_token'))
					return Response.json({ data: [{ access_token: 'short', user_id: 1789 }] });
				if (url.includes('grant_type=ig_exchange_token'))
					return Response.json({ access_token: 'long', expires_in: 5_184_000 });
				if (url.includes('/me?fields='))
					return Response.json({ user_id: '1789', username, account_type: accountType });
				return new Response('unmocked', { status: 404 });
			})
		);
		const url = new URL(
			`http://localhost/api/connections/instagram/callback?code=CODE%23_&state=${encodeURIComponent(state)}`
		);
		return redirected(() =>
			instagramCallback({
				url,
				locals: { db, env: TEST_ENV },
				cookies: { get: () => 'sess-ig' }
			} as never)
		);
	}

	it('keeps the app secret out of the row, and a renamed account reconnects in place', async () => {
		const first = await connect('acme');
		expect(first.location).toContain('connected=instagram');
		const reconnect = await connect('acme_renamed');
		expect(reconnect.location).toContain('connected=instagram');

		const rows = await db.select().from(connections).where(eq(connections.userId, userId));
		expect(rows).toHaveLength(1);
		expect(rows[0].handle).toBe('@acme_renamed');
		expect(JSON.parse(rows[0].metaJson ?? '{}').igUserId).toBe('1789');
		const creds = await decryptJson<Record<string, unknown>>(
			rows[0].credentialsEncrypted,
			TEST_ENV.APP_ENCRYPTION_KEY
		);
		expect(creds).toMatchObject({ accessToken: 'long', igUserId: '1789', clientId: 'ig-app' });
		expect(creds).not.toHaveProperty('clientSecret');
	});

	it('turns a personal account away with what to change', async () => {
		const out = await connect('someone', 'PERSONAL');
		expect(decodeURIComponent(out.location)).toContain('Business and Creator accounts');
	});
});

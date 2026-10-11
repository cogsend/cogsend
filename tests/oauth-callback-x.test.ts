import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { decryptJson, encryptSecret } from '#lib/server/crypto.js';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { connections, oauthPending, users } from '#lib/server/db/schema.js';
import { createTestDb, TEST_ENV } from '#lib/server/db/test.js';
import { bindOAuthState } from '#lib/server/oauth-state.js';
import { packXPendingSecret } from '#lib/server/providers/x.js';
import type { ConnectionCredentials } from '#lib/server/providers/types.js';
import { GET as xCallback } from '../src/routes/api/connections/x/callback/+server';

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

describe('x oauth callback', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'oauth-x@localhost',
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
			instanceUrl: 'x',
			clientId: 'x-client-id',
			clientSecretEnc: await encryptSecret(
				packXPendingSecret('x-client-secret', 'VERIFIER-123'),
				TEST_ENV.APP_ENCRYPTION_KEY
			),
			expiresAt: new Date(Date.now() + 10 * 60_000),
			createdAt: new Date()
		});
		return pendingId;
	}

	function xFetch() {
		return vi.fn(async (input: unknown, init?: RequestInit) => {
			const url = String(input);
			if (url.includes('/2/oauth2/token')) {
				const body = String((init?.body as URLSearchParams)?.toString?.() ?? init?.body ?? '');
				expect(body).toContain('code_verifier=VERIFIER-123');
				return Response.json({
					access_token: 'x-at',
					refresh_token: 'x-rt',
					expires_in: 7200,
					scope: 'tweet.read tweet.write users.read offline.access media.write'
				});
			}
			if (url.includes('/2/users/me')) {
				return Response.json({
					data: { id: '99', username: 'xuser', name: 'X User' }
				});
			}
			return new Response('unmocked', { status: 404 });
		});
	}

	it('creates the connection and stores the verifier-derived tokens', async () => {
		const pendingId = await seedPending();
		const state = await bindOAuthState({
			secret: TEST_ENV.AUTH_SECRET!,
			pendingId,
			sessionId: 'sess-x'
		});
		vi.stubGlobal('fetch', xFetch());
		const url = new URL(
			`http://localhost/api/connections/x/callback?code=CODE&state=${encodeURIComponent(state)}`
		);
		const out = await redirected(() =>
			xCallback({
				url,
				locals: { db, env: TEST_ENV },
				cookies: { get: () => 'sess-x' }
			} as never)
		);
		expect(out.status).toBe(302);
		expect(out.location).toContain('connected=x');
		const rows = await db.select().from(connections).where(eq(connections.userId, userId));
		expect(rows).toHaveLength(1);
		expect(rows[0].platform).toBe('x');
		expect(rows[0].handle).toBe('@xuser');
		const creds = await decryptJson<ConnectionCredentials>(
			rows[0].credentialsEncrypted,
			TEST_ENV.APP_ENCRYPTION_KEY
		);
		expect(creds.accessToken).toBe('x-at');
		expect(creds.refreshToken).toBe('x-rt');
		expect(creds.xUserId).toBe('99');
		expect(creds.xUsername).toBe('xuser');
	});

	it('rejects a state bound to another session', async () => {
		const pendingId = await seedPending();
		const state = await bindOAuthState({
			secret: TEST_ENV.AUTH_SECRET!,
			pendingId,
			sessionId: 'sess-x'
		});
		vi.stubGlobal('fetch', xFetch());
		const url = new URL(
			`http://localhost/api/connections/x/callback?code=CODE&state=${encodeURIComponent(state)}`
		);
		const out = await redirected(() =>
			xCallback({
				url,
				locals: { db, env: TEST_ENV },
				cookies: { get: () => 'other-session' }
			} as never)
		);
		expect(out.status).toBe(302);
		expect(out.location).toContain('oauth_expired');
	});

	it('refuses a pending row that belongs to another provider', async () => {
		// The state is valid and bound to this session, but the pending row was
		// started by the Threads flow: redeeming it here would store Threads
		// credentials as an X connection.
		const pendingId = await seedPending();
		await db
			.update(oauthPending)
			.set({ instanceUrl: 'threads' })
			.where(eq(oauthPending.id, pendingId));
		const state = await bindOAuthState({
			secret: TEST_ENV.AUTH_SECRET!,
			pendingId,
			sessionId: 'sess-x'
		});
		vi.stubGlobal('fetch', xFetch());
		const url = new URL(
			`http://localhost/api/connections/x/callback?code=CODE&state=${encodeURIComponent(state)}`
		);
		const out = await redirected(() =>
			xCallback({
				url,
				locals: { db, env: TEST_ENV },
				cookies: { get: () => 'sess-x' }
			} as never)
		);
		expect(out.status).toBe(302);
		expect(out.location).toContain('oauth_expired');
		// The mismatched pending row is cleaned up rather than left to expire.
		expect(await db.select().from(oauthPending).where(eq(oauthPending.id, pendingId))).toHaveLength(
			0
		);
		const conns = await db.select().from(connections).where(eq(connections.userId, userId));
		// No Threads credentials smuggled into a connection row; only the X row
		// the earlier case created.
		expect(conns.filter((c) => c.platform === 'threads')).toHaveLength(0);
		expect(conns.filter((c) => c.platform === 'x')).toHaveLength(1);
	});
});

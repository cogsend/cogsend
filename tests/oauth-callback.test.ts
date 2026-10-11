import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { newId } from '#lib/server/db/client.js';
import type { AppDb } from '#lib/server/db/client.js';
import { connections, oauthPending, users } from '#lib/server/db/schema.js';
import { createTestDb, TEST_ENV } from '#lib/server/db/test.js';
import { encryptSecret } from '#lib/server/crypto.js';
import { bindOAuthState } from '#lib/server/oauth-state.js';
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

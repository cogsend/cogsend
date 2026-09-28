import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { connections, users } from '$lib/server/db/schema';
import { newId, type AppDb } from '$lib/server/db/client';
import { TEST_ENV, createTestDb } from '$lib/server/db/test';
import { encryptJson } from '$lib/server/crypto';
import { POST as verifyPOST } from '../src/routes/api/connections/[id]/verify/+server';

/**
 * Two rules this route has to keep: it is session-only (it refreshes and stores
 * credentials, which a leaked API key must not be able to do — docs/api.md
 * promises as much), and its authorisation runs *before* the provider call, so
 * a rejected caller can never expire a row.
 */
describe('POST /api/connections/[id]/verify — session only, gate before write', () => {
	let db: AppDb;
	let close: () => void;
	let ownerId: string;
	let strangerId: string;

	async function addConnection(
		owner: string,
		overrides: Partial<typeof connections.$inferInsert> = {}
	) {
		const id = newId();
		const now = new Date();
		await db.insert(connections).values({
			id,
			userId: owner,
			platform: 'mastodon',
			handle: `acct-${id.slice(0, 8)}@example.social`,
			credentialsEncrypted: 'enc',
			status: 'active',
			createdAt: now,
			updatedAt: now,
			...overrides
		});
		return id;
	}

	const locals = (
		authMethod: 'session' | 'bearer',
		user = ownerId,
		scopes: string[] | null = null
	) => ({
		db,
		user: {
			id: user,
			email: `${user}@localhost`,
			timezone: 'UTC',
			totpEnabled: true,
			mfaVerified: true
		},
		authMethod,
		apiKeyScopes: scopes,
		env: TEST_ENV
	});
	const verify = (id: string, user = ownerId) =>
		verifyPOST({ params: { id }, locals: locals('session', user) } as never) as Promise<Response>;
	const verifyWithKey = (id: string, scopes: string[], user = ownerId) =>
		verifyPOST({
			params: { id },
			locals: locals('bearer', user, scopes)
		} as never) as Promise<Response>;
	const statusOf = async (id: string) =>
		(await db.select().from(connections).where(eq(connections.id, id)))[0];

	beforeAll(async () => {
		const ctx = await createTestDb();
		db = ctx.db;
		close = ctx.close;
		ownerId = newId();
		strangerId = newId();
		const now = new Date();
		for (const id of [ownerId, strangerId]) {
			await db.insert(users).values({
				id,
				email: `${id}@localhost`,
				passwordHash: 'x',
				timezone: 'UTC',
				createdAt: now,
				updatedAt: now
			});
		}
	});
	afterAll(() => {
		vi.unstubAllGlobals();
		close();
	});

	it('refuses every API key, whatever its scopes, and leaves the row untouched', async () => {
		const conn = await addConnection(ownerId);
		const before = await statusOf(conn);

		for (const scopes of [['read'], ['write'], ['read', 'write']]) {
			const res = await verifyWithKey(conn, scopes);
			expect(res.status, `scopes ${scopes.join('+')}`).toBe(401);
		}
		const after = await statusOf(conn);
		expect(after.status).toBe('active');
		// Not even the timestamp moved: a rejected gate must not reach the DB.
		expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
	});

	it('404s an unknown id and another user’s row for a session', async () => {
		expect((await verify(newId())).status).toBe(404);
		const stranger = await addConnection(strangerId);
		expect((await verify(stranger)).status).toBe(404);
		expect((await statusOf(stranger)).status).toBe('active');
	});

	it('still expires the row on a real provider auth failure', async () => {
		const conn = await addConnection(ownerId, {
			credentialsEncrypted: await encryptJson(
				{ instanceUrl: 'https://mastodon.example', accessToken: 'dead-token' },
				TEST_ENV.APP_ENCRYPTION_KEY
			)
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('revoked', { status: 401 }))
		);

		const res = await verify(conn);

		expect(res.status).toBe(401);
		expect((await statusOf(conn)).status).toBe('expired');
		vi.unstubAllGlobals();
	});

	it('marks the row active again when the provider accepts the token', async () => {
		const conn = await addConnection(ownerId, {
			credentialsEncrypted: await encryptJson(
				{ instanceUrl: 'https://mastodon.example', accessToken: 'good-token' },
				TEST_ENV.APP_ENCRYPTION_KEY
			)
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json({ id: '1', username: 'me', display_name: 'Me' }))
		);

		const res = await verify(conn);

		expect(res.status).toBe(200);
		expect((await statusOf(conn)).status).toBe('active');
		vi.unstubAllGlobals();
	});

	it('refuses to follow an instance that redirects to an internal address', async () => {
		const conn = await addConnection(ownerId, {
			credentialsEncrypted: await encryptJson(
				{ instanceUrl: 'https://mastodon.example', accessToken: 'secret-token' },
				TEST_ENV.APP_ENCRYPTION_KEY
			)
		});
		const seen: string[] = [];
		const internal = 'http://169.254.169.254/latest/meta-data/';
		// Follows redirects the way fetch does unless told `redirect: 'manual'`.
		const fakeFetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = String(input);
			seen.push(url);
			if (url === internal) return Response.json({ id: 'metadata' });
			if (init?.redirect === 'manual') {
				return new Response(null, { status: 302, headers: { location: internal } });
			}
			return fakeFetch(internal, init);
		};
		vi.stubGlobal('fetch', vi.fn(fakeFetch));

		const res = await verify(conn);

		expect(res.ok).toBe(false);
		// The token-carrying request never reached the internal address.
		expect(seen).toEqual(['https://mastodon.example/api/v1/accounts/verify_credentials']);
		// A refused hop is not a dead token: the account keeps its status.
		expect((await statusOf(conn)).status).toBe('active');
		vi.unstubAllGlobals();
	});

	describe('through Zernio', () => {
		afterEach(() => vi.unstubAllGlobals());

		async function zernioRow(status = 'expired') {
			return addConnection(ownerId, {
				platform: 'x',
				handle: 'acme',
				status,
				credentialsEncrypted: await encryptJson(
					{ zernioApiKey: 'zk_1', zernioAccountId: 'acc-1' },
					TEST_ENV.APP_ENCRYPTION_KEY
				),
				metaJson: JSON.stringify({
					provider: 'zernio',
					zernioAccountId: 'acc-1',
					zernioProfileId: 'p1'
				})
			});
		}
		const stub = (handler: (req: Request) => Response) =>
			vi.stubGlobal(
				'fetch',
				vi.fn(async (input: unknown, init?: RequestInit) =>
					handler(new Request(String(input), init))
				)
			);

		it('marks the row active when Zernio still holds a live token', async () => {
			const id = await zernioRow();
			stub(() =>
				Response.json({
					accounts: [
						{
							_id: 'acc-1',
							platform: 'twitter',
							profileId: 'p1',
							username: '@acme2',
							displayName: 'Acme'
						}
					]
				})
			);
			expect((await verify(id)).status).toBe(200);
			const row = await statusOf(id);
			expect(row.status).toBe('active');
			expect(row.handle).toBe('acme2');
		});

		it('expires the row when Zernio lists the account as inactive', async () => {
			const id = await zernioRow('active');
			stub(() =>
				Response.json({
					accounts: [{ _id: 'acc-1', platform: 'twitter', profileId: 'p1', isActive: false }]
				})
			);
			expect((await verify(id)).status).toBe(401);
			expect((await statusOf(id)).status).toBe('expired');
		});

		it('expires the row and says where to reconnect when Zernio reports the token dead', async () => {
			const id = await zernioRow('active');
			stub(() =>
				Response.json({
					accounts: [
						{ _id: 'acc-1', platform: 'twitter', profileId: 'p1', needsReconnection: true }
					]
				})
			);
			const res = await verify(id);
			expect(res.status).toBe(401);
			expect(((await res.json()) as { error: string }).error).toMatch(/reconnect .* in Zernio/i);
			expect((await statusOf(id)).status).toBe('expired');
		});

		it('expires the row when the key itself is refused, and keeps it on a blip', async () => {
			const id = await zernioRow('active');
			stub(() => Response.json({ error: 'Invalid API key' }, { status: 401 }));
			expect((await verify(id)).status).toBe(401);
			expect((await statusOf(id)).status).toBe('expired');

			const healthy = await zernioRow('active');
			stub(() => new Response('down', { status: 503 }));
			expect((await verify(healthy)).status).toBe(502);
			expect((await statusOf(healthy)).status).toBe('active');
		});
	});
});

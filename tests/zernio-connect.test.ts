import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { connections, oauthPending, users } from '#lib/server/db/schema.js';
import { createTestDb, TEST_ENV } from '#lib/server/db/test.js';
import { POST as connectPOST } from '../src/routes/api/connections/zernio/connect/+server';
import { GET as callbackGET } from '../src/routes/api/connections/zernio/callback/+server';
import { isPublicPath } from '../src/hooks.server';

describe('zernio connect-through', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;

	const locals = (overrides: Record<string, unknown> = {}) => ({
		db,
		env: { ...TEST_ENV, APP_URL: 'https://cog.example' },
		user: {
			id: userId,
			email: 'z@localhost',
			timezone: 'UTC',
			totpEnabled: true,
			mfaVerified: true
		},
		authMethod: 'session' as const,
		...overrides
	});
	const connect = (body: unknown, overrides: Record<string, unknown> = {}) =>
		(connectPOST as (event: unknown) => Promise<Response>)({
			request: new Request('http://localhost/api/connections/zernio/connect', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			}),
			locals: locals(overrides),
			cookies: { get: () => 'session-token' },
			url: new URL('http://localhost/api/connections/zernio/connect')
		} as never);
	const callback = (query: string, cookie: string | undefined = 'session-token') =>
		(callbackGET as (event: unknown) => Promise<Response>)({
			url: new URL(`https://cog.example/api/connections/zernio/callback?${query}`),
			locals: locals(),
			cookies: { get: () => cookie }
		} as never).catch((e: unknown) => e);
	const redirectOf = (thrown: unknown) => (thrown as { status?: number; location?: string }) ?? {};

	function stubZernio() {
		const seen: Request[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: unknown, init?: RequestInit) => {
				const req = new Request(String(input), init);
				seen.push(req);
				if (req.url.includes('/v1/connect/twitter')) {
					return Response.json({ authUrl: 'https://x.com/i/oauth2/authorize?state=z' });
				}
				if (req.url.includes('/v1/accounts')) {
					return Response.json({
						accounts: [{ _id: 'acc-new', platform: 'twitter', profileId: 'p1', username: '@fresh' }]
					});
				}
				return new Response('unmocked', { status: 404 });
			})
		);
		return seen;
	}

	/** Start a connect and return the bound state Zernio will send back. */
	async function startedState(seen: Request[]) {
		const res = await connect({ apiKey: 'zk_1', profileId: 'p1', platform: 'x' });
		expect(res.status).toBe(200);
		const redirect = new URL(new URL(seen[0].url).searchParams.get('redirect_url')!);
		return redirect.searchParams.get('pending')!;
	}

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		userId = newId();
		const now = new Date();
		await db.insert(users).values({
			id: userId,
			email: 'z@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
	});
	afterAll(() => close());
	afterEach(() => vi.unstubAllGlobals());

	it('the callback is reachable without a session, like the other callbacks', () => {
		expect(isPublicPath('/api/connections/zernio/callback')).toBe(true);
		expect(isPublicPath('/api/connections/zernio/connect')).toBe(false);
	});

	it('refuses bearer callers and unsupported platforms', async () => {
		expect(
			(await connect({ apiKey: 'zk', profileId: 'p1', platform: 'x' }, { authMethod: 'bearer' }))
				.status
		).toBe(401);
		expect((await connect({ apiKey: 'zk', profileId: 'p1', platform: 'mastodon' })).status).toBe(
			400
		);
		// Zernio's hosted Bluesky flow appends its result with a second `?`, which
		// breaks the bound state, and reports no account id: import it instead.
		const bluesky = await connect({ apiKey: 'zk', profileId: 'p1', platform: 'bluesky' });
		expect(bluesky.status).toBe(400);
		expect(((await bluesky.json()) as { error: string }).error).toMatch(/Bluesky .* Zernio/);
		expect((await connect({ apiKey: 'zk', platform: 'x' })).status).toBe(400);
	});

	it('stores the key on a pending row and sends the visitor to Zernio', async () => {
		const seen = stubZernio();
		const res = await connect({ apiKey: 'zk_1', profileId: 'p1', platform: 'x' });
		expect(res.status).toBe(200);
		expect(((await res.json()) as { authorizeUrl: string }).authorizeUrl).toBe(
			'https://x.com/i/oauth2/authorize?state=z'
		);
		const asked = new URL(seen[0].url);
		expect(asked.searchParams.get('profileId')).toBe('p1');
		const redirect = new URL(asked.searchParams.get('redirect_url')!);
		expect(redirect.origin + redirect.pathname).toBe(
			'https://cog.example/api/connections/zernio/callback'
		);
		const bound = redirect.searchParams.get('pending')!;
		const pending = (
			await db
				.select()
				.from(oauthPending)
				.where(eq(oauthPending.id, bound.split('.')[0]))
		)[0];
		expect(pending.instanceUrl).toBe('zernio');
		expect(pending.clientId).toBe('p1');
		expect(pending.clientSecretEnc).not.toContain('zk_1');
		expect(bound).toMatch(/^[0-9a-f]{32}\.[0-9a-f]{64}$/);
	});

	it('the callback imports the account Zernio names, once', async () => {
		const state = await startedState(stubZernio());
		const done = redirectOf(
			await callback(
				`pending=${encodeURIComponent(state)}&connected=twitter&profileId=p1&accountId=acc-new&username=fresh`
			)
		);
		expect(done.status).toBe(302);
		expect(done.location).toBe('https://cog.example/accounts?connected=x');
		const rows = await db.select().from(connections).where(eq(connections.userId, userId));
		expect(rows.map((r) => [r.platform, r.handle, r.status])).toEqual([['x', 'fresh', 'active']]);
		expect(JSON.parse(rows[0].metaJson).zernioAccountId).toBe('acc-new');
		const again = redirectOf(
			await callback(`pending=${encodeURIComponent(state)}&connected=twitter&accountId=acc-new`)
		);
		expect(again.location).toContain('error=oauth_expired');
	});

	it('a Zernio-side failure comes back as a readable error', async () => {
		const state = await startedState(stubZernio());
		const failed = redirectOf(
			await callback(
				`pending=${encodeURIComponent(state)}&error=access_denied&platform=twitter&error_message=You%20cancelled`
			)
		);
		expect(failed.status).toBe(302);
		expect(failed.location).toBe('https://cog.example/accounts?error=You%20cancelled');
		// Single use either way: the row (and the key inside it) does not outlive
		// the attempt it was made for.
		expect(
			await db
				.select()
				.from(oauthPending)
				.where(eq(oauthPending.id, state.split('.')[0]))
		).toEqual([]);
	});

	it('a state bound to another session is refused', async () => {
		const state = await startedState(stubZernio());
		const wrong = redirectOf(
			await callback(
				`pending=${encodeURIComponent(state)}&connected=twitter&accountId=acc-new`,
				'someone-else'
			)
		);
		expect(wrong.location).toContain('error=oauth_expired');
	});
});

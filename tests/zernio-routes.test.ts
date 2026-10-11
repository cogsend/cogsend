import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { connections, users } from '#lib/server/db/schema.js';
import { createTestDb, TEST_ENV } from '#lib/server/db/test.js';
import { POST as accountsPOST } from '../src/routes/api/connections/zernio/accounts/+server';
import { POST as importPOST } from '../src/routes/api/connections/zernio/import/+server';

const zernioAccounts = [
	{ _id: 'acc-x', platform: 'twitter', profileId: 'p1', username: '@acme', displayName: 'Acme' },
	{ _id: 'acc-ig', platform: 'instagram', profileId: 'p1', username: 'acme' },
	{ _id: 'acc-li', platform: 'linkedin', profileId: 'p1', displayName: 'Acme Inc' }
];

function stubZernio(overrides: Record<string, (req: Request) => Response> = {}) {
	const seen: Request[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: unknown, init?: RequestInit) => {
			const req = new Request(String(input), init);
			seen.push(req);
			for (const [key, handler] of Object.entries(overrides)) {
				if (req.url.includes(key)) return handler(req);
			}
			if (req.url.includes('/v1/profiles')) {
				return Response.json({ profiles: [{ _id: 'p1', name: 'Brand' }] });
			}
			if (req.url.includes('/v1/accounts')) return Response.json({ accounts: zernioAccounts });
			// The publish-access probe: a usable key gets Zernio's dryRun 400.
			if (req.url.endsWith('/v1/posts') && req.method === 'POST') {
				return Response.json({ error: 'dryRun is only supported for TikTok' }, { status: 400 });
			}
			return new Response('unmocked', { status: 404 });
		})
	);
	return seen;
}

describe('zernio list and import routes', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;

	const locals = (overrides: Record<string, unknown> = {}) => ({
		db,
		env: TEST_ENV,
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
	const call = (handler: unknown, body: unknown, overrides: Record<string, unknown> = {}) =>
		(handler as (event: unknown) => Promise<Response>)({
			request: new Request('http://localhost/api/connections/zernio', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			}),
			locals: locals(overrides),
			cookies: { get: () => 'session-token' },
			url: new URL('http://localhost/api/connections/zernio')
		} as never) as Promise<Response>;

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

	it('is session-only', async () => {
		for (const handler of [accountsPOST, importPOST]) {
			const res = await call(handler, { apiKey: 'zk' }, { authMethod: 'bearer' });
			expect(res.status).toBe(401);
		}
	});

	it('needs a key the first time', async () => {
		stubZernio();
		const res = await call(accountsPOST, {});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toMatch(/API key/);
	});

	it('lists the importable accounts with the profiles', async () => {
		const seen = stubZernio();
		const res = await call(accountsPOST, { apiKey: 'zk_1' });
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			profiles: Array<{ id: string; name: string }>;
			accounts: Array<{ id: string; platform: string; imported: boolean }>;
			hasStoredKey: boolean;
		};
		expect(body.profiles).toEqual([{ id: 'p1', name: 'Brand' }]);
		expect(body.accounts.map((a) => [a.id, a.platform, a.imported])).toEqual([
			['acc-x', 'x', false],
			['acc-li', 'linkedin', false]
		]);
		expect(body.hasStoredKey).toBe(false);
		expect(seen.every((r) => r.headers.get('authorization') === 'Bearer zk_1')).toBe(true);
	});

	it('explains a rejected key in words', async () => {
		stubZernio({
			'/v1/profiles': () => Response.json({ error: 'Invalid API key' }, { status: 401 })
		});
		const res = await call(accountsPOST, { apiKey: 'zk_bad' });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe('Zernio rejected this API key');
		expect(body.error).not.toMatch(/401/);
	});

	it('a key missing a resource group is explained', async () => {
		stubZernio({
			'/v1/accounts': () =>
				Response.json(
					{ error: 'This key cannot access accounts', code: 'insufficient_permissions' },
					{ status: 403 }
				)
		});
		const res = await call(accountsPOST, { apiKey: 'zk_ro' });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe(
			'This Zernio API key cannot be used here: This key cannot access accounts'
		);
	});

	it('a key that can list but cannot publish is explained before anything is imported', async () => {
		stubZernio({
			'/v1/posts': () => Response.json({ error: 'This API key is read-only' }, { status: 403 })
		});
		const res = await call(accountsPOST, { apiKey: 'zk_ro' });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe('This Zernio API key cannot be used here: This API key is read-only');
	});

	it('imports the chosen accounts and reuses the stored key afterwards', async () => {
		stubZernio();
		const res = await call(importPOST, { apiKey: 'zk_1', accountIds: ['acc-x', 'acc-li'] });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { connections: Array<{ platform: string; handle: string }> };
		expect(body.connections.map((c) => c.platform).sort()).toEqual(['linkedin', 'x']);
		const rows = await db.select().from(connections).where(eq(connections.userId, userId));
		expect(rows).toHaveLength(2);

		const seen = stubZernio();
		const again = await call(accountsPOST, {});
		expect(again.status).toBe(200);
		const listed = (await again.json()) as {
			accounts: Array<{ id: string; imported: boolean }>;
			hasStoredKey: boolean;
		};
		expect(listed.hasStoredKey).toBe(true);
		expect(listed.accounts.find((a) => a.id === 'acc-x')?.imported).toBe(true);
		expect(seen[0].headers.get('authorization')).toBe('Bearer zk_1');
	});

	it('refuses ids Zernio does not know or CogSend cannot post to', async () => {
		stubZernio();
		const unknown = await call(importPOST, { accountIds: ['nope'] });
		expect(unknown.status).toBe(400);
		expect(((await unknown.json()) as { error: string }).error).toContain('nope');
		const instagram = await call(importPOST, { accountIds: ['acc-ig'] });
		expect(instagram.status).toBe(400);
		const empty = await call(importPOST, { accountIds: [] });
		expect(empty.status).toBe(400);
	});
});

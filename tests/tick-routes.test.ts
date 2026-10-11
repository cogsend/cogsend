import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { users } from '#lib/server/db/schema.js';
import { createTestDb, createTestMedia, TEST_ENV } from '#lib/server/db/test.js';
import { schedulerHealth } from '#lib/server/scheduler.js';
import { rotateTickToken } from '#lib/server/tick-token.js';
import {
	DELETE as tickTokenDELETE,
	GET as tickTokenGET,
	POST as tickTokenPOST
} from '../src/routes/api/scheduler/tick-token/+server';
import { POST as tickTestPOST } from '../src/routes/api/scheduler/test/+server';
import { GET as healthGET } from '../src/routes/api/scheduler/health/+server';

/**
 * The credential an external cron uses, and the button that proves the app side
 * works. Both are managed from Settings, so both are session-only.
 */
describe('tick token routes', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;

	const session = (extra: Record<string, unknown> = {}) => ({
		db,
		env: TEST_ENV,
		media: createTestMedia(),
		queue: null,
		authMethod: 'session',
		apiKeyScopes: null,
		user: {
			id: userId,
			email: 'scheduler@localhost',
			timezone: 'UTC',
			totpEnabled: true,
			mfaVerified: true
		},
		...extra
	});

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'scheduler@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
	});
	afterAll(() => close());

	it('starts empty and reports status after generating one', async () => {
		const before = (await tickTokenGET({ locals: session() } as never)) as Response;
		expect(before.status).toBe(200);
		expect(await before.json()).toEqual({ configured: false, prefix: null, createdAt: null });

		const created = (await tickTokenPOST({ locals: session() } as never)) as Response;
		expect(created.status).toBe(201);
		const body = (await created.json()) as { token: string; prefix: string; createdAt: string };
		expect(body.token.startsWith('tick_')).toBe(true);
		expect(body.prefix.startsWith('tick_')).toBe(true);

		const after = (await tickTokenGET({ locals: session() } as never)) as Response;
		const status = (await after.json()) as { configured: boolean; prefix: string };
		expect(status.configured).toBe(true);
		expect(status.prefix).toBe(body.prefix);
		// The raw token is returned exactly once: later reads cannot show it.
		expect(JSON.stringify(status)).not.toContain(body.token);
	});

	it('revokes, and says so when there is nothing to revoke', async () => {
		const first = (await tickTokenDELETE({ locals: session() } as never)) as Response;
		expect(first.status).toBe(200);
		const second = (await tickTokenDELETE({ locals: session() } as never)) as Response;
		expect(second.status).toBe(404);
	});

	it('refuses bearer credentials, like API-key management does', async () => {
		// A leaked token must not be able to mint or revoke its own replacement.
		const generated = (await tickTokenPOST({
			locals: session({ authMethod: 'bearer', apiKeyScopes: ['read', 'write'] })
		} as never)) as Response;
		expect(generated.status).toBe(401);
		const read = (await tickTokenGET({
			locals: session({ authMethod: 'bearer' })
		} as never)) as Response;
		expect(read.status).toBe(401);
	});

	it('ticks on demand and records the heartbeat', async () => {
		expect((await schedulerHealth(db)).lastTickAt).toBe(null);

		const res = (await tickTestPOST({ locals: session() } as never)) as Response;
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; processed: number };
		expect(body.ok).toBe(true);
		expect(body.processed).toBe(0);

		const after = await schedulerHealth(db);
		expect(after.lastTickAt).toBeInstanceOf(Date);
	});

	it('requires write scope for the on-demand tick', async () => {
		const res = (await tickTestPOST({
			locals: session({ authMethod: 'bearer', apiKeyScopes: ['read'] })
		} as never)) as Response;
		expect(res.status).toBe(403);
	});

	it('surfaces the deploy note and the tick state to the UI', async () => {
		const res = (await healthGET({ locals: session() } as never)) as Response;
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: boolean;
			neverTicked: boolean;
			message: string;
			deployCron: unknown;
		};
		expect(body.neverTicked).toBe(false);
		expect(body.ok).toBe(true);
		expect(body.message).toBe('Scheduled publishing is on time');
		// No deploy has recorded anything in this test database.
		expect(body.deployCron).toBe(null);
	});

	it('reports the refusal reason the deploy recorded', async () => {
		const { writeAppSetting, CRON_STATE_SETTING } = await import('#lib/server/app-settings.js');
		await writeAppSetting(db, CRON_STATE_SETTING, 'unavailable:10072');
		const res = (await healthGET({ locals: session() } as never)) as Response;
		const body = (await res.json()) as {
			deployCron: { status: string; code: string } | null;
			message: string;
		};
		expect(body.deployCron).toEqual({
			status: 'unavailable',
			code: '10072',
			updatedAt: expect.any(String)
		});
		// This instance has ticked, so "on time" still wins over the stale note.
		expect(body.message).toBe('Scheduled publishing is on time');
		await writeAppSetting(db, CRON_STATE_SETTING, '');
	});

	it('accepts the Settings tick token at the route itself', async () => {
		// The hook admits the Settings token for /api/internal/tick; the route
		// must accept the same credential, or the documented external-pinger
		// path (Settings token) 401s after passing the hook.
		const { POST: internalTickPOST } = await import('../src/routes/api/internal/tick/+server');
		const { token } = await rotateTickToken(db);
		const locals = { ...session(), waitUntil: () => {} };
		const res = (await internalTickPOST({
			request: new Request('https://x.test/api/internal/tick', {
				method: 'POST',
				headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
			}),
			locals
		} as never)) as Response;
		expect(res.status).toBe(200);
		const body = (await res.json()) as { processed: number };
		expect(typeof body.processed).toBe('number');
	});

	it('still refuses the tick route without any credential', async () => {
		const { POST: internalTickPOST } = await import('../src/routes/api/internal/tick/+server');
		const res = (await internalTickPOST({
			request: new Request('https://x.test/api/internal/tick', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' }
			}),
			locals: session()
		} as never)) as Response;
		expect(res.status).toBe(401);
	});
});

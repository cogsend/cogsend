import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { handle } from '../src/hooks.server';
import { useWorkerEnv } from './cloudflare-workers';
import { createD1Db } from '#lib/server/db/client.js';
import { rotateTickToken } from '#lib/server/tick-token.js';
import { ensureSchema } from '#lib/server/db/init-sql.js';

/**
 * The authorization boundary around /api/internal/tick, exercised through the
 * real hook.
 *
 * Two credentials can reach the tick, and they are not interchangeable:
 *
 *   - SCHEDULER_SECRET / API_TOKEN (env) reach every internal path, as before;
 *   - the token minted in Settings reaches the tick *only*, never
 *     /api/internal/publish, which can publish a specific draft on demand.
 *
 * A hook is the only place that decision lives, so this test drives the hook
 * rather than the endpoints.
 */

/** D1-shaped shim over in-memory SQLite: the hook builds its own drizzle handle. */
function d1Shim(client: Client): D1Database {
	const rows = async (sql: string, args: unknown[] = []) =>
		(await client.execute({ sql, args: args as never })) as unknown as { rows: unknown[] };
	return {
		exec: (sql: string) => client.executeMultiple(sql) as unknown as Promise<unknown>,
		prepare: (sql: string) => {
			const stmt = (bindArgs: unknown[] = []) => ({
				run: () => client.execute({ sql, args: bindArgs as never }) as Promise<unknown>,
				all: async () => ({ results: (await rows(sql, bindArgs)).rows, success: true, meta: {} }),
				// Drizzle's D1 driver reads rows positionally through `raw()`.
				raw: async () =>
					(await rows(sql, bindArgs)).rows.map((row) =>
						Object.values(row as Record<string, unknown>)
					),
				first: async () => (await rows(sql, bindArgs)).rows[0] ?? null,
				bind: (...args: unknown[]) => stmt(args)
			});
			return stmt();
		}
	} as unknown as D1Database;
}

const SCHEDULER_SECRET = 'scheduler-secret-0123456789abcdef';
const API_TOKEN = 'api-token-0123456789abcdef';

describe('internal api authorization', () => {
	let client: Client;
	let binding: D1Database;
	let tickToken = '';
	let close: () => void;

	beforeAll(async () => {
		client = createClient({ url: ':memory:' });
		close = () => client.close();
		binding = d1Shim(client);
		await ensureSchema(binding);
		tickToken = (await rotateTickToken(createD1Db(binding) as never)).token;
	});
	afterAll(() => close());

	/** Call the hook the way SvelteKit would, and report whether it resolved. */
	async function request(
		path: string,
		bearer?: string
	): Promise<{ bypassed: boolean; status: number; body: string }> {
		let bypassed = false;
		const url = new URL(`https://cogsend.example.com${path}`);
		useWorkerEnv({
			DB: binding,
			APP_URL: 'https://cogsend.example.com',
			APP_ENCRYPTION_KEY: 'feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface',
			SCHEDULER_SECRET,
			API_TOKEN,
			// See tests/rate-limit.test.ts: the binding keeps the hook off its
			// dev-only memory fallback warning.
			MEDIA: {}
		});
		const response = await handle({
			event: {
				url,
				request: new Request(url, {
					method: 'POST',
					headers: bearer ? { Authorization: `Bearer ${bearer}` } : {}
				}),
				cookies: {
					get: () => undefined,
					set: () => {},
					delete: () => {},
					getAll: () => [],
					serialize: () => ''
				},
				locals: {},
				fetch: async () => new Response('ok'),
				params: {},
				route: { id: path },
				setHeaders: {}
			},
			// The hook is what we are testing: reaching this means the request was
			// authorized and handed to the route.
			resolve: async () => {
				bypassed = true;
				return new Response('routed', { status: 200 });
			}
		} as never);
		return { bypassed, status: response.status, body: await response.text() };
	}

	it('lets the Settings token reach the tick', async () => {
		const result = await request('/api/internal/tick', tickToken);
		expect(result.bypassed).toBe(true);
		expect(result.status).toBe(200);
	});

	it('does not let the Settings token reach /api/internal/publish', async () => {
		const result = await request('/api/internal/publish', tickToken);
		expect(result.bypassed).toBe(false);
		expect(result.status).toBe(401);
	});

	it('still lets the env secrets reach both, as before', async () => {
		expect((await request('/api/internal/tick', SCHEDULER_SECRET)).bypassed).toBe(true);
		expect((await request('/api/internal/publish', SCHEDULER_SECRET)).bypassed).toBe(true);
		expect((await request('/api/internal/publish', API_TOKEN)).bypassed).toBe(true);
	});

	it('rejects nonsense, an absent token, and a revoked token', async () => {
		expect((await request('/api/internal/tick')).status).toBe(401);
		expect((await request('/api/internal/tick', 'tick_' + 'f'.repeat(64))).status).toBe(401);
		expect((await request('/api/internal/tick', 'wrong-token')).status).toBe(401);
	});
});

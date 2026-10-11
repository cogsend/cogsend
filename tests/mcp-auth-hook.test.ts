import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { handle } from '../src/hooks.server';
import { useWorkerEnv } from './cloudflare-workers';
import { createD1Db, newId } from '#lib/server/db/client.js';
import { ensureSchema } from '#lib/server/db/init-sql.js';
import { rotateApiKey } from '#lib/server/api-keys.js';
import { createSession, SESSION_COOKIE } from '#lib/server/auth.js';
import { readAppEnv } from '#lib/server/env.js';
import { users } from '#lib/server/db/schema.js';

/** D1-shaped shim over in-memory SQLite; the hook constructs its own Drizzle handle. */
function d1Shim(client: Client): D1Database {
	const rows = async (sql: string, args: unknown[] = []) =>
		(await client.execute({ sql, args: args as never })) as unknown as { rows: unknown[] };
	return {
		exec: (sql: string) => client.executeMultiple(sql) as unknown as Promise<unknown>,
		prepare: (sql: string) => {
			const stmt = (bindArgs: unknown[] = []) => ({
				run: () => client.execute({ sql, args: bindArgs as never }) as Promise<unknown>,
				all: async () => ({ results: (await rows(sql, bindArgs)).rows, success: true, meta: {} }),
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

const ORIGIN = 'https://cogsend.example.com';
const APP_ENCRYPTION_KEY = 'feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface';
const AUTH_SECRET = 'test-auth-secret-0123456789abcdef';

describe('MCP authentication through the request hook', () => {
	let client: Client;
	let binding: D1Database;
	let db: ReturnType<typeof createD1Db>;
	let close: () => void;
	let rawKey: string;
	let rawSession: string;
	beforeAll(async () => {
		client = createClient({ url: ':memory:' });
		close = () => client.close();
		binding = d1Shim(client);
		await ensureSchema(binding);
		db = createD1Db(binding);
		const userId = newId();
		const passwordHash = 'test-password-hash';
		const now = new Date();
		await db.insert(users).values({
			id: userId,
			email: 'mcp-hook@localhost',
			passwordHash,
			timezone: 'UTC',
			totpEnabled: true,
			createdAt: now,
			updatedAt: now
		});
		rawKey = (await rotateApiKey(db, userId)).raw;
		const env = readAppEnv({ APP_URL: ORIGIN, APP_ENCRYPTION_KEY, AUTH_SECRET });
		rawSession = (await createSession(db, env, userId, true, true, passwordHash)).raw;
	});
	afterAll(() => close());

	async function request(method: string, headers: HeadersInit = {}) {
		const url = new URL('/api/mcp', ORIGIN);
		const request = new Request(url, { method, headers });
		const cookies = new Map(
			(request.headers.get('cookie') ?? '')
				.split(';')
				.map((cookie) => cookie.trim().split('='))
				.filter(([name, value]) => name && value)
				.map(([name, ...value]) => [name, value.join('=')])
		);
		let routed = false;
		const pending: Promise<unknown>[] = [];
		useWorkerEnv(
			{ DB: binding, APP_URL: ORIGIN, APP_ENCRYPTION_KEY, AUTH_SECRET, MEDIA: {} },
			(promise) => pending.push(promise)
		);
		const response = await handle({
			event: {
				url,
				request,
				cookies: {
					get: (name: string) => cookies.get(name),
					set: () => {},
					delete: () => {},
					getAll: () => [],
					serialize: () => ''
				},
				locals: {},
				fetch: async () => new Response('ok'),
				params: {},
				route: { id: '/api/mcp' },
				setHeaders: {}
			},
			resolve: async () => {
				routed = true;
				return new Response('routed', { status: 200 });
			}
		} as never);
		await Promise.allSettled(pending);
		return { routed, response };
	}

	it('rejects OPTIONS instead of bypassing MCP auth and origin checks', async () => {
		const unauthenticated = await request('OPTIONS');
		expect(unauthenticated.routed).toBe(false);
		expect(unauthenticated.response.status).toBe(401);
		expect(unauthenticated.response.headers.get('www-authenticate')).toBe('Bearer');

		const wrongOrigin = await request('OPTIONS', { Origin: 'https://evil.example' });
		expect(wrongOrigin.routed).toBe(false);
		expect(wrongOrigin.response.status).toBe(403);
	});

	it('uses a valid bearer key even when the request also has a session cookie', async () => {
		const cookie = `${SESSION_COOKIE}=${rawSession}`;
		const sessionOnly = await request('POST', { Cookie: cookie });
		expect(sessionOnly.routed).toBe(false);
		expect(sessionOnly.response.status).toBe(401);
		expect(sessionOnly.response.headers.get('www-authenticate')).toBe('Bearer');

		const bearerAndSession = await request('POST', {
			Authorization: `Bearer ${rawKey}`,
			Cookie: cookie
		});
		expect(bearerAndSession.routed).toBe(true);
		expect(bearerAndSession.response.status).toBe(200);
	});
});

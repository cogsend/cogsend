import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { handle, isAdminPath, isPublicPath } from '../src/hooks.server';
import { useWorkerEnv } from './cloudflare-workers';
import { createD1Db, newId } from '#lib/server/db/client.js';
import { ensureSchema } from '#lib/server/db/init-sql.js';
import { rotateApiKey } from '#lib/server/api-keys.js';
import { createSession, SESSION_COOKIE } from '#lib/server/auth.js';
import { readAppEnv } from '#lib/server/env.js';
import { sessions, users } from '#lib/server/db/schema.js';

/**
 * The request hook is the first gate a multi-user instance relies on: it must
 * keep members out of /admin, and stop honouring the sessions and API keys of
 * an account that is suspended or still waiting, before any route runs.
 */
function d1Shim(client: Client): D1Database {
	const rows = async (sql: string, args: unknown[] = []) =>
		(await client.execute({ sql, args: args as never })) as unknown as { rows: unknown[] };
	return {
		exec: (sql: string) => client.executeMultiple(sql) as unknown as Promise<unknown>,
		prepare: (sql: string) => {
			const stmt = (bindArgs: unknown[] = []) => ({
				run: () => client.execute({ sql, args: bindArgs as never }) as Promise<unknown>,
				all: async () => ({ results: (await rows(sql, bindArgs)).rows, success: true, meta: {} }),
				// By position, not Object.values: the session read joins two tables
				// that both have `id` and `created_at`, and named keys collapse.
				raw: async () => {
					const res = await client.execute({ sql, args: bindArgs as never });
					return res.rows.map((row) => res.columns.map((_, i) => row[i]));
				},
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
const PASSWORD_HASH = 'test-password-hash';

describe('the request hook on an instance with members', () => {
	let client: Client;
	let binding: D1Database;
	let db: ReturnType<typeof createD1Db>;
	const env = readAppEnv({ APP_URL: ORIGIN, APP_ENCRYPTION_KEY, AUTH_SECRET });
	const ids = { owner: newId(), member: newId(), waiting: newId() };
	const cookies: Record<string, string> = {};
	const keys: Record<string, string> = {};

	beforeAll(async () => {
		client = createClient({ url: ':memory:' });
		binding = d1Shim(client);
		await ensureSchema(binding);
		db = createD1Db(binding);
		const now = Date.now();
		for (const [name, id, role, status] of [
			['owner', ids.owner, 'admin', 'active'],
			['member', ids.member, 'member', 'active'],
			['waiting', ids.waiting, 'member', 'pending']
		] as const) {
			await db.insert(users).values({
				id,
				email: `${name}@localhost`,
				passwordHash: PASSWORD_HASH,
				timezone: 'UTC',
				totpEnabled: true,
				role,
				status,
				createdAt: new Date(now + (name === 'owner' ? 0 : 1000)),
				updatedAt: new Date(now)
			});
			keys[name] = (await rotateApiKey(db, id)).raw;
			cookies[name] = (await createSession(db, env, id, true, true, PASSWORD_HASH)).raw;
		}
	});
	afterAll(() => client.close());

	async function request(path: string, init: { cookie?: string; bearer?: string } = {}) {
		const url = new URL(path, ORIGIN);
		const headers = new Headers();
		if (init.bearer) headers.set('authorization', `Bearer ${init.bearer}`);
		let routed = false;
		let seenUser: { id: string; role: string } | null = null;
		useWorkerEnv({ DB: binding, APP_URL: ORIGIN, APP_ENCRYPTION_KEY, AUTH_SECRET, MEDIA: {} });
		const response = await handle({
			event: {
				url,
				request: new Request(url, { headers }),
				cookies: {
					get: (name: string) => (name === SESSION_COOKIE ? init.cookie : undefined),
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
			resolve: async (event: { locals: { user: { id: string; role: string } | null } }) => {
				routed = true;
				seenUser = event.locals.user;
				return new Response('routed', { status: 200 });
			}
		} as never);
		return { routed, response, user: seenUser as { id: string; role: string } | null };
	}

	it('keeps members out of the admin pages and API', async () => {
		const page = await request('/admin/users', { cookie: cookies.member });
		expect(page.routed).toBe(false);
		expect(page.response.status).toBe(303);
		expect(page.response.headers.get('location')).toBe('/');

		const api = await request('/api/admin/users', { cookie: cookies.member });
		expect(api.routed).toBe(false);
		expect(api.response.status).toBe(403);

		const byKey = await request('/api/admin/users', { bearer: keys.member });
		expect(byKey.routed).toBe(false);
		expect(byKey.response.status).toBe(403);
	});

	it('lets the admin through, and carries the role into the route', async () => {
		const res = await request('/api/admin/users', { cookie: cookies.owner });
		expect(res.routed).toBe(true);
		expect(res.user?.role).toBe('admin');
		const member = await request('/api/drafts', { cookie: cookies.member });
		expect(member.routed).toBe(true);
		expect(member.user).toMatchObject({ id: ids.member, role: 'member' });
	});

	it('honours neither the session nor the key of an account on the waitlist', async () => {
		const session = await request('/api/drafts', { cookie: cookies.waiting });
		expect(session.routed).toBe(false);
		expect(session.response.status).toBe(401);
		const key = await request('/api/drafts', { bearer: keys.waiting });
		expect(key.routed).toBe(false);
		expect(key.response.status).toBe(401);
	});

	it('stops a suspended account at once, and brings its key back when reinstated', async () => {
		await db.update(users).set({ status: 'suspended' }).where(eq(users.id, ids.member));
		const session = await request('/api/drafts', { cookie: cookies.member });
		expect(session.response.status).toBe(401);
		// The session row is gone, not merely refused this once.
		expect(await db.select().from(sessions).where(eq(sessions.userId, ids.member))).toEqual([]);
		const key = await request('/api/drafts', { bearer: keys.member });
		expect(key.response.status).toBe(401);

		await db.update(users).set({ status: 'active' }).where(eq(users.id, ids.member));
		const back = await request('/api/drafts', { bearer: keys.member });
		expect(back.routed).toBe(true);
		expect(back.user?.id).toBe(ids.member);
	});

	it('lists the sign-up paths as public and the admin paths as admin-only', () => {
		for (const path of [
			'/signup',
			'/signup/verify',
			'/api/auth/signup',
			'/api/auth/signup/verify'
		]) {
			expect(isPublicPath(path)).toBe(true);
		}
		for (const path of ['/admin', '/admin/users', '/api/admin/users', '/api/admin/invites/x']) {
			expect(isAdminPath(path)).toBe(true);
			expect(isPublicPath(path)).toBe(false);
		}
		expect(isAdminPath('/administer')).toBe(false);
	});
});

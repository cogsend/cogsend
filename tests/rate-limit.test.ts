import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { handle } from '../src/hooks.server';
import { ensureSchema } from '$lib/server/db/init-sql';
import { captureConsole, loggedLines } from './console-spy';
import {
	RATE_LIMITED_PATHS,
	isRateLimitedPath,
	rateLimitKey,
	rateLimitProblem,
	type RateLimiter
} from '$lib/server/rate-limit';

/** Same D1-shaped shim the tick-token hook test uses: the hook builds its own
 *  drizzle handle from the binding. */
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

describe('which paths are rate limited', () => {
	it('covers exactly the endpoints that take a secret', () => {
		expect(RATE_LIMITED_PATHS).toEqual([
			'/api/auth/login',
			'/api/auth/claim',
			'/api/auth/totp/verify',
			'/api/update/unlock',
			'/api/update/remember'
		]);
		expect(isRateLimitedPath('/api/auth/login')).toBe(true);
		expect(isRateLimitedPath('/api/auth/login/')).toBe(true);
		expect(isRateLimitedPath('/api/auth/totp/verify')).toBe(true);
		expect(isRateLimitedPath('/api/update/unlock')).toBe(true);
		expect(isRateLimitedPath('/api/update/prepare')).toBe(false);
		// Everything else is either session-guarded or bearer-guarded.
		expect(isRateLimitedPath('/api/auth/totp/enroll/start')).toBe(false);
		expect(isRateLimitedPath('/api/auth/me')).toBe(false);
		expect(isRateLimitedPath('/api/internal/tick')).toBe(false);
		expect(isRateLimitedPath('/')).toBe(false);
	});

	it('keys on the client address Cloudflare reports', () => {
		expect(rateLimitKey(new Headers({ 'cf-connecting-ip': '203.0.113.9' }))).toBe('203.0.113.9');
		// No edge header: a local server, a test, or a script on the machine that
		// already holds the instance's secrets. There is nothing to guard, and a
		// shared bucket would only throttle the operator.
		expect(rateLimitKey(new Headers())).toBeNull();
	});
});

describe('the decision', () => {
	it('allows a request when the bucket has room', async () => {
		const limiter: RateLimiter = { limit: async () => ({ success: true }) };
		expect(await rateLimitProblem(limiter, 'k')).toBeNull();
	});

	it('refuses with something a person can act on', async () => {
		const limiter: RateLimiter = { limit: async () => ({ success: false }) };
		expect(await rateLimitProblem(limiter, 'k')).toBe(
			'Too many attempts — wait a minute and try again'
		);
	});

	it('lets the request through when no limiter is bound, or when it throws', async () => {
		// A guard that fails closed would lock every operator out of their own
		// instance; the app's own lockout is what actually gates guessing.
		expect(await rateLimitProblem(undefined, 'k')).toBeNull();
		// And without an edge address (see the key test above).
		expect(await rateLimitProblem({ limit: async () => ({ success: false }) }, null)).toBeNull();
		const broken: RateLimiter = {
			limit: async () => {
				throw new Error('binding unavailable');
			}
		};
		expect(await rateLimitProblem(broken, 'k')).toBeNull();
	});
});

/**
 * The wiring, through the real hook: a limited request must be refused before
 * anything reaches D1 or the route.
 */
describe('the hook', () => {
	let client: Client;
	let binding: D1Database;
	let close: () => void;
	let calls: string[] = [];

	beforeAll(async () => {
		client = createClient({ url: ':memory:' });
		close = () => client.close();
		binding = d1Shim(client);
		await ensureSchema(binding);
	});
	afterAll(() => close());

	async function request(
		path: string,
		options: { limiter?: RateLimiter; ip?: string; media?: boolean } = {}
	): Promise<{ routed: boolean; status: number; body: string }> {
		let routed = false;
		const url = new URL(`https://cogsend.example.com${path}`);
		const headers: Record<string, string> = { 'content-type': 'application/json' };
		if (options.ip) headers['cf-connecting-ip'] = options.ip;
		const response = await handle({
			event: {
				url,
				request: new Request(url, { method: 'POST', headers, body: '{}' }),
				cookies: {
					get: () => undefined,
					set: () => {},
					delete: () => {},
					getAll: () => [],
					serialize: () => ''
				},
				locals: {},
				platform: {
					env: {
						DB: binding,
						APP_URL: 'https://cogsend.example.com',
						APP_ENCRYPTION_KEY: 'feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface',
						AUTH_RATE_LIMITER: options.limiter,
						// A binding, so the hook takes the R2 path: a warn per request
						// about the dev memory fallback is noise in a rate-limit test.
						// The one test that wants the fallback passes media: false.
						MEDIA: options.media === false ? undefined : {}
					},
					ctx: { waitUntil: () => {}, passThroughOnException: () => {} }
				},
				fetch: async () => new Response('ok'),
				params: {},
				route: { id: path },
				setHeaders: {}
			},
			resolve: async () => {
				routed = true;
				return new Response('routed', { status: 200 });
			}
		} as never);
		return { routed, status: response.status, body: await response.text() };
	}

	it('warns once about the memory fallback, not once per request', async () => {
		// No MEDIA binding: the hook warns that media goes to memory for the rest
		// of this isolate. The notice is about the binding, so a second request
		// must not repeat it — a local run makes one request per click. This is
		// the file's only request without a binding, which is what makes the
		// count exact.
		const warned = captureConsole('warn');
		const limiter: RateLimiter = { limit: async () => ({ success: true }) };
		await request('/api/auth/login', { limiter, media: false });
		await request('/api/auth/login', { limiter, media: false });
		expect(
			loggedLines(warned).filter((line) => line.includes('R2 MEDIA binding missing'))
		).toHaveLength(1);
	});

	it('answers 429 on a limited sign-in, without reaching the route', async () => {
		calls = [];
		const limiter: RateLimiter = {
			limit: async ({ key }) => {
				calls.push(key);
				return { success: false };
			}
		};
		const result = await request('/api/auth/login', { limiter, ip: '203.0.113.9' });
		expect(result.status).toBe(429);
		expect(result.body).toContain('Too many attempts');
		expect(result.routed).toBe(false);
		expect(calls).toEqual(['203.0.113.9']);
	});

	it('passes an allowed sign-in to the route', async () => {
		const limiter: RateLimiter = { limit: async () => ({ success: true }) };
		const result = await request('/api/auth/login', { limiter, ip: '203.0.113.9' });
		expect(result.status).toBe(200);
		expect(result.routed).toBe(true);
	});

	it('does not consult the limiter for other endpoints', async () => {
		calls = [];
		const limiter: RateLimiter = {
			limit: async ({ key }) => {
				calls.push(key);
				return { success: false };
			}
		};
		const result = await request('/api/auth/totp/enroll/start', { limiter, ip: '203.0.113.9' });
		expect(calls).toEqual([]);
		// Public (it needs a challenge token, not a session) but not limited: a
		// flood guard on top of a token-guarded route buys nothing.
		expect(result.status).toBe(200);
		expect(result.routed).toBe(true);
	});
});

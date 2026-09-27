/**
 * The workers.dev subdomain check that runs before setup creates anything. The
 * API answers are copies of Cloudflare's: "no subdomain" is error 10007, and
 * a free name is reported as error 10032 on a 404, not as a 200.
 */
import { describe, expect, it } from 'vitest';
import {
	SUBDOMAIN_PATTERN,
	apiHeaders,
	isMissingSubdomainError,
	nameAvailability,
	onboardingUrl,
	readSubdomain,
	registerSubdomain,
	suggestSubdomain,
	toValidSubdomain
} from '../scripts/lib/workers-subdomain.mjs';
import { stripToolNoise } from '../scripts/lib/cli.mjs';
import { subdomainVerdict } from '../scripts/doctor.mjs';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const HEADERS = { authorization: 'Bearer t' };

/** A fetch that answers from a table keyed by "METHOD path". */
function fakeApi(routes: Record<string, { status: number; body: unknown }>) {
	const calls: { method: string; path: string; body?: string }[] = [];
	const fetcher = async (url: string, init: RequestInit = {}) => {
		const path = url.replace('https://api.cloudflare.com/client/v4', '');
		const method = init.method ?? 'GET';
		calls.push({ method, path, body: init.body as string | undefined });
		const hit = routes[`${method} ${path}`];
		if (!hit) throw new Error(`unexpected ${method} ${path}`);
		return new Response(JSON.stringify(hit.body), { status: hit.status });
	};
	return { fetcher, calls };
}

const failure = (code: number, message = 'x') => ({
	success: false,
	errors: [{ code, message }],
	result: null
});

describe('the workers.dev subdomain of an account', () => {
	it('reads the name an account already has', async () => {
		const { fetcher } = fakeApi({
			[`GET /accounts/${ACCOUNT}/workers/subdomain`]: {
				status: 200,
				body: { success: true, errors: [], result: { subdomain: 'sam' } }
			}
		});
		expect(await readSubdomain({ accountId: ACCOUNT, headers: HEADERS, fetch: fetcher })).toEqual({
			status: 'set',
			subdomain: 'sam'
		});
	});

	it('tells a new account without one apart from an API failure', async () => {
		const missing = fakeApi({
			[`GET /accounts/${ACCOUNT}/workers/subdomain`]: { status: 404, body: failure(10007) }
		});
		expect(
			await readSubdomain({ accountId: ACCOUNT, headers: HEADERS, fetch: missing.fetcher })
		).toEqual({ status: 'missing' });

		const denied = fakeApi({
			[`GET /accounts/${ACCOUNT}/workers/subdomain`]: {
				status: 403,
				body: failure(10000, 'Authentication error')
			}
		});
		expect(
			await readSubdomain({ accountId: ACCOUNT, headers: HEADERS, fetch: denied.fetcher })
		).toEqual({ status: 'unknown', reason: 'Authentication error' });
	});

	it('reports a network failure as unknown instead of throwing', async () => {
		const fetcher = async () => {
			throw new Error('getaddrinfo ENOTFOUND');
		};
		expect(await readSubdomain({ accountId: ACCOUNT, headers: HEADERS, fetch: fetcher })).toEqual({
			status: 'unknown',
			reason: 'getaddrinfo ENOTFOUND'
		});
	});

	it('reads availability from the error codes the API answers with', async () => {
		const { fetcher } = fakeApi({
			[`GET /accounts/${ACCOUNT}/workers/subdomains/free`]: { status: 404, body: failure(10032) },
			[`GET /accounts/${ACCOUNT}/workers/subdomains/taken`]: { status: 409, body: failure(10031) },
			[`GET /accounts/${ACCOUNT}/workers/subdomains/odd`]: { status: 500, body: failure(10013) }
		});
		const check = (name: string) =>
			nameAvailability({ accountId: ACCOUNT, headers: HEADERS, name, fetch: fetcher });
		expect(await check('free')).toBe('available');
		expect(await check('taken')).toBe('taken');
		expect(await check('odd')).toBe('unknown');
	});

	it('registers a name with the call wrangler makes', async () => {
		const { fetcher, calls } = fakeApi({
			[`PUT /accounts/${ACCOUNT}/workers/subdomain`]: {
				status: 200,
				body: { success: true, errors: [], result: { subdomain: 'sam' } }
			}
		});
		expect(
			await registerSubdomain({ accountId: ACCOUNT, headers: HEADERS, name: 'sam', fetch: fetcher })
		).toEqual({ ok: true, subdomain: 'sam' });
		expect(JSON.parse(calls[0].body ?? '')).toEqual({ subdomain: 'sam' });
	});

	it('returns the reason when registration is refused', async () => {
		const { fetcher } = fakeApi({
			[`PUT /accounts/${ACCOUNT}/workers/subdomain`]: {
				status: 409,
				body: failure(10031, 'Subdomain unavailable')
			}
		});
		expect(
			await registerSubdomain({ accountId: ACCOUNT, headers: HEADERS, name: 'x', fetch: fetcher })
		).toEqual({ ok: false, reason: 'Subdomain unavailable' });
	});
});

describe('credentials for the API', () => {
	const answer =
		(stdout: string, status = 0) =>
		() => ({ status, stdout, stderr: '' });

	it('uses the OAuth token or API token wrangler holds', () => {
		expect(apiHeaders({ run: answer('{"type":"oauth","token":"abc"}') })).toEqual({
			authorization: 'Bearer abc'
		});
		expect(apiHeaders({ run: answer('{"type":"api_token","token":"def"}') })).toEqual({
			authorization: 'Bearer def'
		});
	});

	it('uses a global API key and its email', () => {
		expect(
			apiHeaders({ run: answer('{"type":"api_key","key":"k","email":"me@example.com"}') })
		).toEqual({ 'X-Auth-Key': 'k', 'X-Auth-Email': 'me@example.com' });
	});

	it('gives up quietly when signed out or on unreadable output', () => {
		expect(apiHeaders({ run: answer('', 1) })).toBeNull();
		expect(apiHeaders({ run: answer('not json') })).toBeNull();
		expect(apiHeaders({ run: answer('{"type":"oauth"}') })).toBeNull();
	});
});

describe('names', () => {
	it('suggests the person behind a new account, not its whole label', () => {
		expect(suggestSubdomain("sam.lee@example.com's Account", 'cogsend')).toBe('sam-lee');
		expect(suggestSubdomain("Acme Corp's Account", 'cogsend')).toBe('acme-corp');
		expect(suggestSubdomain(null, 'cogsend')).toBe('cogsend');
		expect(suggestSubdomain('!!!', 'cogsend')).toBe('cogsend');
	});

	it('accepts only what Cloudflare accepts', () => {
		for (const ok of ['a', 'sam', 'my-name-2', 'a'.repeat(63)]) {
			expect(SUBDOMAIN_PATTERN.test(ok)).toBe(true);
		}
		for (const bad of ['', '-a', 'a-', 'My_Name', 'a.b', 'a'.repeat(64)]) {
			expect(SUBDOMAIN_PATTERN.test(bad)).toBe(false);
		}
		expect(toValidSubdomain('My Name!')).toBe('my-name');
	});

	it('links to the account onboarding page', () => {
		expect(onboardingUrl(ACCOUNT)).toBe(
			`https://dash.cloudflare.com/${ACCOUNT}/workers/onboarding`
		);
	});
});

describe('a deploy that failed for want of a subdomain', () => {
	// Trimmed from a real `wrangler deploy` on a new account, with no terminal.
	const OUTPUT = `Cloudflare collects anonymous telemetry about your usage of Wrangler. Learn more at https://github.com/cloudflare/workers-sdk/tree/main/packages/wrangler/telemetry.md
? Would you like to register a workers.dev subdomain now?
▲ [WARNING] You need to register a workers.dev subdomain before publishing to workers.dev
✘ [ERROR] You can either deploy your worker to one or more routes by specifying them in your wrangler.jsonc file, or register a workers.dev subdomain here:
  https://dash.cloudflare.com/${ACCOUNT}/workers/onboarding`;

	it('is recognised', () => {
		expect(isMissingSubdomainError(OUTPUT)).toBe(true);
		expect(isMissingSubdomainError('✘ [ERROR] Authentication error [code: 10000]')).toBe(false);
	});

	it('loses the telemetry notice when printed', () => {
		expect(stripToolNoise(OUTPUT)).not.toMatch(/telemetry/);
		expect(stripToolNoise(OUTPUT)).toMatch(/register a workers\.dev subdomain here/);
	});
});

describe('doctor', () => {
	it('fails an account with no subdomain, with the page that fixes it', () => {
		const check = subdomainVerdict({
			workersDev: true,
			accountId: ACCOUNT,
			result: { status: 'missing' }
		});
		expect(check?.status).toBe('fail');
		expect(check?.fix).toContain(onboardingUrl(ACCOUNT));
	});

	it('names the subdomain an account has', () => {
		expect(
			subdomainVerdict({
				workersDev: undefined,
				accountId: ACCOUNT,
				result: { status: 'set', subdomain: 'sam' }
			})
		).toMatchObject({ status: 'ok', label: 'workers.dev subdomain sam.workers.dev' });
	});

	it('says nothing when workers.dev is off or nothing could be read', () => {
		expect(
			subdomainVerdict({ workersDev: false, accountId: ACCOUNT, result: { status: 'missing' } })
		).toBeNull();
		expect(subdomainVerdict({ workersDev: true, accountId: null, result: null })).toBeNull();
		expect(
			subdomainVerdict({
				workersDev: true,
				accountId: ACCOUNT,
				result: { status: 'unknown', reason: 'timeout' }
			})
		).toMatchObject({ status: 'warn', detail: 'timeout' });
	});
});

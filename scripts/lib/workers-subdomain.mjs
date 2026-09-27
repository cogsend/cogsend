/**
 * The account's workers.dev subdomain: the one account-wide name every Worker
 * on workers.dev is served under (`<worker>.<subdomain>.workers.dev`).
 *
 * A new Cloudflare account has none until someone picks it, and a deploy to
 * workers.dev needs it. `wrangler deploy` offers to register one, but only at a
 * terminal: setup captures the deploy's output to read the URL back, so the
 * offer answers itself with "no" and the deploy fails at the very last step,
 * after the database, the bucket and the account were already created. Setup
 * therefore asks first, through the same API wrangler's own prompt uses.
 *
 * The credentials come from `wrangler auth token`, through the repo wrapper, so
 * the login and profile are the ones the deploy itself will use.
 */
import { spawnSync } from 'node:child_process';

/** Cloudflare's own rule for the name, as wrangler enforces it. */
export const SUBDOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** "This account has no workers.dev subdomain." */
const NO_SUBDOMAIN = 10007;
const NAME_TAKEN = 10031;
const NAME_AVAILABLE = 10032;

/** @param {string} accountId */
export const onboardingUrl = (accountId) =>
	`https://dash.cloudflare.com/${accountId}/workers/onboarding`;

/**
 * Anything typed or derived, made into a name Cloudflare would accept.
 *
 * @param {unknown} input
 * @returns {string} '' when nothing usable is left
 */
export function toValidSubdomain(input) {
	return String(input ?? '')
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^-+/, '')
		.slice(0, 63)
		.replace(/-+$/, '');
}

/**
 * A default to offer: the account's own name, which for a new account is
 * "<email>'s Account", cut down to the part a person would recognise.
 *
 * @param {string | null | undefined} accountName
 * @param {string} fallback
 */
export function suggestSubdomain(accountName, fallback) {
	const person = String(accountName ?? '').split(/@|'s\b/i)[0];
	return toValidSubdomain(person) || toValidSubdomain(fallback);
}

/** Does a failed `wrangler deploy` say the account has no workers.dev subdomain?
 *  @param {unknown} text */
export const isMissingSubdomainError = (text) =>
	/register a workers\.dev subdomain/i.test(String(text));

/**
 * @typedef {{ status: number | null, stdout?: string | null, stderr?: string | null }} RunResult
 * @typedef {(args: string[]) => RunResult} Run
 * @typedef {(url: string, init?: RequestInit) => Promise<Response>} Fetch
 */

/** @type {Run} */
function runWrapper(args) {
	return spawnSync('node', ['scripts/wrangler.mjs', ...args], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 60_000
	});
}

/**
 * The headers wrangler itself would authenticate with, or null. The token is
 * only ever held in memory, never printed.
 *
 * @param {{ run?: Run }} [options]
 * @returns {Record<string, string> | null}
 */
export function apiHeaders({ run = runWrapper } = {}) {
	const result = run(['auth', 'token', '--json']);
	if (result.status !== 0) return null;
	try {
		const parsed = JSON.parse(result.stdout ?? '');
		if (parsed?.type === 'api_key' && parsed.key && parsed.email) {
			return { 'X-Auth-Key': parsed.key, 'X-Auth-Email': parsed.email };
		}
		return typeof parsed?.token === 'string' && parsed.token
			? { authorization: `Bearer ${parsed.token}` }
			: null;
	} catch {
		return null;
	}
}

/** Wrangler honours this override, so the requests here do too. */
const apiBase = () =>
	(process.env.CLOUDFLARE_API_BASE_URL || 'https://api.cloudflare.com/client/v4').replace(
		/\/$/,
		''
	);

/**
 * One Cloudflare API call, reduced to what the callers branch on.
 *
 * @param {Fetch} fetcher @param {string} path @param {Record<string, string>} headers
 * @param {RequestInit} [init]
 * @returns {Promise<{ ok: boolean, code: number | null, result: any, message: string }>}
 */
async function call(fetcher, path, headers, init = {}) {
	try {
		const res = await fetcher(`${apiBase()}${path}`, {
			...init,
			headers: { ...headers, ...(init.body ? { 'content-type': 'application/json' } : {}) },
			signal: AbortSignal.timeout(30_000)
		});
		const body = await res.json().catch(() => null);
		const first = body?.errors?.[0];
		return {
			ok: res.ok && body?.success !== false,
			code: typeof first?.code === 'number' ? first.code : null,
			result: body?.result ?? null,
			message: first?.message ?? `HTTP ${res.status}`
		};
	} catch (err) {
		return {
			ok: false,
			code: null,
			result: null,
			message: err instanceof Error ? err.message : String(err)
		};
	}
}

/**
 * @param {{ accountId: string, headers: Record<string, string>, fetch?: Fetch }} options
 * @returns {Promise<{ status: 'set', subdomain: string } | { status: 'missing' } | { status: 'unknown', reason: string }>}
 */
export async function readSubdomain({ accountId, headers, fetch: fetcher = fetch }) {
	const res = await call(fetcher, `/accounts/${accountId}/workers/subdomain`, headers);
	if (res.ok && typeof res.result?.subdomain === 'string' && res.result.subdomain) {
		return { status: 'set', subdomain: res.result.subdomain };
	}
	if (res.code === NO_SUBDOMAIN) return { status: 'missing' };
	return { status: 'unknown', reason: res.message };
}

/**
 * Whether a name is free. Names are global across Cloudflare, not per account.
 *
 * @param {{ accountId: string, headers: Record<string, string>, name: string, fetch?: Fetch }} options
 * @returns {Promise<'available' | 'taken' | 'unknown'>}
 */
export async function nameAvailability({ accountId, headers, name, fetch: fetcher = fetch }) {
	const res = await call(fetcher, `/accounts/${accountId}/workers/subdomains/${name}`, headers);
	// The API answers "available" with an error code, not a 200.
	if (res.code === NAME_AVAILABLE) return 'available';
	if (res.code === NAME_TAKEN) return 'taken';
	return 'unknown';
}

/**
 * @param {{ accountId: string, headers: Record<string, string>, name: string, fetch?: Fetch }} options
 * @returns {Promise<{ ok: true, subdomain: string } | { ok: false, reason: string }>}
 */
export async function registerSubdomain({ accountId, headers, name, fetch: fetcher = fetch }) {
	const res = await call(fetcher, `/accounts/${accountId}/workers/subdomain`, headers, {
		method: 'PUT',
		body: JSON.stringify({ subdomain: name })
	});
	return res.ok
		? { ok: true, subdomain: res.result?.subdomain || name }
		: { ok: false, reason: res.message };
}

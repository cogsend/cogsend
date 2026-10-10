import { spawn } from 'node:child_process';
import {
	chmodSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Each test starts real Node processes, which take far longer than vitest's
// 5 s default on a busy machine.
const RUNS_A_SCRIPT = { timeout: 30_000 };

/**
 * A new Cloudflare account has no workers.dev subdomain, and `wrangler deploy`
 * only offers to register one at a terminal, which setup's captured deploy is
 * not. Setup used to find out at step 8, after it had created the database and
 * the bucket. These run the real script against a fake `npx` and a local
 * stand-in for the Cloudflare API, and check that the question is settled
 * before anything is created.
 */

const ACCOUNT = '0123456789abcdef0123456789abcdef';

let dir: string | null = null;
let server: Server | null = null;
afterEach(async () => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = null;
	await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
	server = null;
});

/** The API, answering as Cloudflare does for an account with `subdomain`. */
async function fakeApi(subdomain: string | null) {
	const requests: { method: string; path: string; body: string }[] = [];
	server = createServer((req, res) => {
		let body = '';
		req.on('data', (chunk) => (body += chunk));
		req.on('end', () => {
			const path = req.url ?? '';
			requests.push({ method: req.method ?? 'GET', path, body });
			const send = (status: number, payload: unknown) => {
				res.writeHead(status, { 'content-type': 'application/json' });
				res.end(JSON.stringify(payload));
			};
			const fail = (status: number, code: number) =>
				send(status, { success: false, errors: [{ code, message: `code ${code}` }], result: null });
			if (path === `/accounts/${ACCOUNT}/workers/subdomain` && req.method === 'GET') {
				return subdomain
					? send(200, { success: true, errors: [], result: { subdomain } })
					: fail(404, 10007);
			}
			if (path === `/accounts/${ACCOUNT}/workers/subdomain` && req.method === 'PUT') {
				return send(200, { success: true, errors: [], result: JSON.parse(body) });
			}
			if (path === `/accounts/${ACCOUNT}/workers/subdomains/taken`) return fail(409, 10031);
			if (path.startsWith(`/accounts/${ACCOUNT}/workers/subdomains/`)) return fail(404, 10032);
			fail(404, 7003);
		});
	});
	await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
	const { port } = server!.address() as AddressInfo;
	return { base: `http://127.0.0.1:${port}`, requests };
}

/** A scratch checkout whose `npx` is a signed-in wrangler, and whose `npm`
 *  fails, so a run that gets as far as the build stops there. */
function scratch() {
	const created = mkdtempSync(join(tmpdir(), 'cogsend-subdomain-'));
	dir = created;
	cpSync(join(process.cwd(), 'scripts'), join(created, 'scripts'), { recursive: true });
	cpSync(join(process.cwd(), 'wrangler.jsonc'), join(created, 'wrangler.jsonc'));
	writeFileSync(
		join(created, 'package.json'),
		'{\n\t"name": "cogsend",\n\t"version": "0.0.0"\n}\n'
	);
	writeFileSync(
		join(created, '.dev.vars'),
		'APP_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n'
	);
	const bin = join(created, 'bin');
	mkdirSync(bin);
	writeFileSync(
		join(bin, 'npx'),
		`#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(created, 'calls.log'))}, JSON.stringify(args) + '\\n');
if (process.env.WRANGLER_LOG === 'debug' && args.includes('secret')) {
	console.error('GET https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/cogsend/secrets');
	process.exit(1);
}
if (args.includes('whoami')) {
	console.log(JSON.stringify({ loggedIn: true, email: 'sam@example.com', accounts: [{ id: '${ACCOUNT}', name: "sam@example.com's Account" }] }));
	process.exit(0);
}
if (args.includes('auth') && args.includes('token')) { console.log(JSON.stringify({ type: 'oauth', token: 't' })); process.exit(0); }
if (args.includes('d1') && args.includes('list')) { console.log('[]'); process.exit(0); }
if (args.includes('d1') && args.includes('create')) { console.log('database_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"'); process.exit(0); }
if (args.includes('secret') && args.includes('list')) { console.log('[]'); process.exit(0); }
process.exit(0);
`
	);
	writeFileSync(join(bin, 'npm'), '#!/bin/sh\necho "build stopped by the test" >&2\nexit 1\n');
	chmodSync(join(bin, 'npx'), 0o755);
	chmodSync(join(bin, 'npm'), 0o755);
	return { root: created, bin };
}

/** Async, so the API above can answer while setup waits on it. */
function runSetup(
	{ root, bin }: { root: string; bin: string },
	base: string,
	args: string[]
): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [join(root, 'scripts/setup.mjs'), '--yes', ...args], {
			cwd: root,
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLOUDFLARE_API_BASE_URL: base },
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk) => (stdout += chunk));
		child.stderr.on('data', (chunk) => (stderr += chunk));
		child.on('close', (status) => resolve({ status, stdout, stderr }));
	});
}

const createdAnything = (root: string) =>
	readFileSync(join(root, 'calls.log'), 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line) as string[])
		.some((args) => args.includes('create'));

describe('npm run setup on an account with no workers.dev subdomain', RUNS_A_SCRIPT, () => {
	it('stops before creating anything when it cannot ask, and says how to fix it', async () => {
		const api = await fakeApi(null);
		const box = scratch();
		const result = await runSetup(box, api.base, []);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('no workers.dev subdomain to deploy to');
		expect(result.stderr).toContain(`https://dash.cloudflare.com/${ACCOUNT}/workers/onboarding`);
		expect(createdAnything(box.root)).toBe(false);
		expect(api.requests.some((r) => r.method === 'PUT')).toBe(false);
	});

	it('registers the name passed with --subdomain, then carries on', async () => {
		const api = await fakeApi(null);
		const box = scratch();
		const result = await runSetup(box, api.base, ['--subdomain', 'sam']);
		expect(result.stdout).toContain('registered sam.workers.dev');
		expect(api.requests.find((r) => r.method === 'PUT')?.body).toBe('{"subdomain":"sam"}');
		expect(result.stdout).toContain('3. D1 database');
	});

	it('refuses a --subdomain that is taken, before creating anything', async () => {
		const api = await fakeApi(null);
		const box = scratch();
		const result = await runSetup(box, api.base, ['--subdomain', 'taken']);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('--subdomain: taken.workers.dev is taken');
		expect(createdAnything(box.root)).toBe(false);
	});

	it('only reports what a dry run would need', async () => {
		const api = await fakeApi(null);
		const box = scratch();
		const result = await runSetup(box, api.base, ['--dry-run']);
		expect(result.stdout).toContain('has no workers.dev subdomain yet');
		expect(api.requests.some((r) => r.method === 'PUT')).toBe(false);
	});
});

describe('npm run setup on an account that has one', RUNS_A_SCRIPT, () => {
	it('names it and changes nothing', async () => {
		const api = await fakeApi('sam');
		const box = scratch();
		const result = await runSetup(box, api.base, []);
		expect(result.stdout).toContain('workers.dev subdomain sam.workers.dev');
		expect(api.requests.some((r) => r.method === 'PUT')).toBe(false);
	});
});

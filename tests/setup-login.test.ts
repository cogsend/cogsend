import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Each test starts real Node processes, which take far longer than vitest's
// 5 s default on a busy machine.
const RUNS_A_SCRIPT = { timeout: 30_000 };

/**
 * `npm run setup` has to work whether or not wrangler is signed in, and the two
 * cases look identical by exit code alone: a signed-out wrangler 4.x prints
 * `{"loggedIn": false}` and exits 1 — the same exit code as a broken install.
 * Reading the status as the answer (which setup used to do) left the login
 * branch below it unreachable, so a fresh clone was never offered a login.
 *
 * These run the real script in a scratch checkout with a fake `npx` on PATH.
 * Signed out on a terminal, setup has to start the login itself and carry on;
 * signed out in a pipe, it has to name the command to run. Anything that is not
 * `whoami`'s JSON must stay a real failure, not be mistaken for "signed out".
 */

let dir: string | null = null;
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = null;
});

/**
 * A scratch checkout with a fake `npx`.
 *
 * `whoami` answers from a state file the way wrangler really does:
 * `{"loggedIn": false}` with exit 1 until `login` flips it, then a signed-in
 * account. `garbage` stands in for a wrangler that cannot reach the API, and
 * `shape` for output that parses as JSON but is not the whoami answer.
 */
function scratch({
	whoami = 'flip',
	loginFails = false,
	profileAccount = null
}: {
	whoami?: 'flip' | 'signed-in' | 'garbage' | 'shape';
	loginFails?: boolean;
	profileAccount?: string | null;
} = {}) {
	const created = mkdtempSync(join(tmpdir(), 'cogsend-login-'));
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
	// What the terminal run loads: the login branch asks `process.stdin.isTTY`,
	// and this is the smallest honest way to answer yes for a child process.
	writeFileSync(
		join(created, 'fake-tty.cjs'),
		"Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });\n"
	);
	const state = join(created, 'state');
	writeFileSync(state, whoami === 'signed-in' ? 'signed-in' : 'signed-out');
	const bin = join(created, 'bin');
	mkdirSync(bin);
	const whoamiBranch =
		whoami === 'garbage'
			? `console.error('ERROR could not reach the Cloudflare API'); process.exit(1);`
			: whoami === 'shape'
				? `console.log('{}'); process.exit(0);`
				: `
	if (readFileSync(state, 'utf8').trim() === 'signed-in') {
		console.log(JSON.stringify({ loggedIn: true, email: 'me@example.com', accounts: [{ name: 'Acme' }] }));
		process.exit(0);
	}
	console.log(JSON.stringify({ loggedIn: false }));
	process.exit(1);`;
	writeFileSync(
		join(bin, 'npx'),
		`#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(created, 'calls.log'))}, JSON.stringify(args) + '\\n');
const state = ${JSON.stringify(state)};
if (process.env.WRANGLER_LOG === 'debug' && args.includes('secret')) {
	const account = ${JSON.stringify(profileAccount)};
	if (account) console.error('GET https://api.cloudflare.com/client/v4/accounts/' + account + '/workers/scripts/cogsend/secrets');
	else console.error('✘ [ERROR] Not logged in.');
	process.exit(1);
}
if (args.includes('whoami')) {${whoamiBranch}
}
if (args.includes('login')) { ${loginFails ? 'process.exit(1);' : "writeFileSync(state, 'signed-in'); process.exit(0);"} }
if (args.includes('d1') && args.includes('list')) { console.log(JSON.stringify([{ name: 'cogsend', uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }])); process.exit(0); }
if (args.includes('secret') && args.includes('list')) { console.log(JSON.stringify([{ name: 'APP_ENCRYPTION_KEY' }])); process.exit(0); }
process.exit(0);
`
	);
	chmodSync(join(bin, 'npx'), 0o755);
	return { root: created, bin };
}

/** The non-terminal path: a pipe, a CI job or `--yes`. */
function runSetup(
	{ root, bin }: { root: string; bin: string },
	args: string[] = [],
	env: Record<string, string> = {}
) {
	return spawnSync(process.execPath, [join(root, 'scripts/setup.mjs'), '--yes', ...args], {
		cwd: root,
		encoding: 'utf8',
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
		timeout: 60_000
	});
}

/**
 * The terminal path: a preload sets `process.stdin.isTTY` in the child, which is
 * the one thing the login branch checks. A real pty would be closer, but
 * `script(1)` refuses to start unless its own stdin is a terminal — which is
 * exactly what a CI job does not have.
 */
function runSetupOnTerminal(
	{ root, bin }: { root: string; bin: string },
	args: string[] = ['--yes', '--skip-deploy']
) {
	return spawnSync(
		process.execPath,
		['--require', join(root, 'fake-tty.cjs'), join(root, 'scripts/setup.mjs'), ...args],
		{
			cwd: root,
			encoding: 'utf8',
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
			timeout: 60_000
		}
	);
}

const calls = (root: string) =>
	readFileSync(join(root, 'calls.log'), 'utf8')
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line) as string[]);

const loggedIn = (root: string) => calls(root).some((args) => args.includes('login'));

describe('npm run setup, with wrangler signed out', RUNS_A_SCRIPT, () => {
	it('starts the login itself on a terminal, then carries on', () => {
		const scratchDir = scratch();
		const result = runSetupOnTerminal(scratchDir);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('not signed in yet — starting the browser login');
		// It continued past the account step: the login was not a dead end.
		expect(result.stdout).toContain('2. Configuration');
		expect(result.stdout).toContain('Stopped before the deploy');
		expect(loggedIn(scratchDir.root)).toBe(true);
		// Probed before and after, so "signed in" is the answer to the login and
		// not an assumption about it.
		expect(calls(scratchDir.root).filter((args) => args.includes('whoami'))).toHaveLength(2);
	});

	it('names the command to run when there is no terminal', () => {
		const scratchDir = scratch();
		const result = runSetup(scratchDir, ['--dry-run']);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('You are not signed in. Run `npx wrangler login`');
		// The old failure: the exit code read as "could not read your account".
		expect(result.stderr).not.toContain('whoami --json failed');
		// No browser is opened where one cannot complete the flow.
		expect(loggedIn(scratchDir.root)).toBe(false);
	});

	it('does not mistake an unreadable account for a signed-out one', () => {
		const scratchDir = scratch({ whoami: 'garbage' });
		const result = runSetup(scratchDir);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('wrangler could not read your account');
		// The detail is the message: wrangler's own output has to survive.
		expect(result.stderr).toContain('could not reach the Cloudflare API');
		// A login would not fix this, and a browser prompt would hide the error.
		expect(loggedIn(scratchDir.root)).toBe(false);
	});

	it('does not read JSON without an answer as "signed out"', () => {
		const scratchDir = scratch({ whoami: 'shape' });
		const result = runSetup(scratchDir);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('wrangler could not read your account');
		// `{}` parses, but it is not the answer: no login is offered for it.
		expect(loggedIn(scratchDir.root)).toBe(false);
	});

	it('reports a login that did not finish, without a bare exit code', () => {
		const scratchDir = scratch({ loginFails: true });
		const result = runSetupOnTerminal(scratchDir);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('Still not signed in. Run `npx wrangler login` and try again.');
		// Attempted once: a failed login is an answer, not a reason to loop.
		expect(calls(scratchDir.root).filter((args) => args.includes('login'))).toHaveLength(1);
	});

	it('never starts a login in a dry run, even on a terminal', () => {
		const scratchDir = scratch();
		const result = runSetupOnTerminal(scratchDir, ['--dry-run']);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('You are not signed in. Run `npx wrangler login`');
		// A dry run creates nothing, and a browser prompt is not read-only.
		expect(loggedIn(scratchDir.root)).toBe(false);
	});
});

describe('npm run setup, already signed in', RUNS_A_SCRIPT, () => {
	it('does not login again', () => {
		const scratchDir = scratch({ whoami: 'signed-in' });
		const result = runSetup(scratchDir, ['--skip-deploy']);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('signed in as me@example.com');
		expect(loggedIn(scratchDir.root)).toBe(false);
	});
});

/**
 * `whoami` refuses `--profile` and answers for the folder's login, so with
 * WRANGLER_PROFILE set it said nothing about the profile, and setup stopped at
 * step 1. The fake's folder login is signed out on purpose: only the profile is
 * signed in.
 */
describe('npm run setup, with WRANGLER_PROFILE', RUNS_A_SCRIPT, () => {
	const ACCOUNT = '0123456789abcdef0123456789abcdef';

	it('reads the account through the profile, not whoami', () => {
		const scratchDir = scratch({ profileAccount: ACCOUNT });
		const result = runSetup(scratchDir, ['--skip-deploy'], { WRANGLER_PROFILE: 'personal' });

		expect(result.status).toBe(0);
		expect(result.stdout).toContain(`signed in through profile personal on ${ACCOUNT}`);
		expect(result.stdout).toContain('2. Configuration');
		expect(loggedIn(scratchDir.root)).toBe(false);
		// whoami still runs to name the account, but never with the flag it refuses.
		const whoamis = calls(scratchDir.root).filter((args) => args.includes('whoami'));
		expect(whoamis.some((args) => args.includes('--profile'))).toBe(false);
		// Everything else does carry the profile.
		expect(calls(scratchDir.root)).toContainEqual(
			expect.arrayContaining(['d1', 'list', '--profile', 'personal'])
		);
	});

	it('names the profile to sign in when it reaches no account', () => {
		const scratchDir = scratch();
		const result = runSetup(scratchDir, ['--skip-deploy'], { WRANGLER_PROFILE: 'personal' });

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain(
			'could not reach Cloudflare through profile personal: Not logged in.'
		);
		expect(result.stderr).toContain('npx wrangler auth create personal');
		// `wrangler login` would sign in the folder's login, not the profile.
		expect(loggedIn(scratchDir.root)).toBe(false);
	});
});

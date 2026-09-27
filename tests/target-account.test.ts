import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	accountIdFromLog,
	checkTarget,
	explainTarget,
	isGuardedCommand,
	recordAccount,
	recordedAccount
} from '../scripts/lib/target-account.mjs';

/**
 * A command run without WRANGLER_PROFILE, or from a checkout moved out of the
 * folder its profile is bound to, reaches the default login's account. With a
 * Worker of the same name there, secrets land on it and the verification pass
 * agrees. These pin the account read from wrangler's own request, the record a
 * deploy leaves, and the refusal when the two disagree.
 */
const HOME = '0123456789abcdef0123456789abcdef';
const OTHER = 'fedcba9876543210fedcba9876543210';

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function scratch() {
	const dir = mkdtempSync(join(tmpdir(), 'cogsend-target-'));
	dirs.push(dir);
	return dir;
}

const requestLine = (account: string) =>
	`-- START CF API REQUEST: GET https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/cogsend/secrets`;

/** A wrangler that answers the probe from `account` and whoami with `names`. */
function fakeRun(account: string | null, names: Record<string, string> = {}) {
	const calls: { args: string[]; env: Record<string, string> }[] = [];
	const run = (args: string[], env: Record<string, string>) => {
		calls.push({ args, env });
		if (args[0] === 'whoami') {
			const accounts = Object.entries(names).map(([id, name]) => ({ id, name }));
			return { status: 0, stdout: JSON.stringify({ loggedIn: true, accounts }), stderr: '' };
		}
		if (!account) {
			return { status: 1, stdout: '', stderr: '✘ [ERROR] Not logged in.' };
		}
		return { status: 1, stdout: '', stderr: `${requestLine(account)}\n✘ [ERROR] not found` };
	};
	return { run, calls };
}

describe('reading the account', () => {
	it('takes the id from the first API path in the debug log', () => {
		expect(accountIdFromLog(`noise\n${requestLine(HOME)}\n${requestLine(OTHER)}`)).toBe(HOME);
	});

	it('skips account paths that are not the Worker request', () => {
		const listing = `GET https://api.cloudflare.com/client/v4/accounts/${OTHER}/memberships`;
		expect(accountIdFromLog(`${listing}\n${requestLine(HOME)}`)).toBe(HOME);
	});

	it('finds none when wrangler never reached the API', () => {
		expect(accountIdFromLog('✘ [ERROR] Not logged in.')).toBeNull();
		expect(accountIdFromLog(`/client/v4/accounts/${HOME}ff/workers`)).toBeNull();
	});
});

describe('which commands are checked', () => {
	it.each([
		[['deploy'], true],
		[['deploy', '--dry-run'], false],
		[['secret', 'put', 'X'], true],
		[['secret', 'delete', 'X'], true],
		[['secret', 'list'], false],
		[['versions', 'upload'], true],
		[['d1', 'execute', 'DB', '--remote', '--command', 'x'], true],
		[['d1', 'execute', 'DB', '--local', '--command', 'x'], false],
		[['d1', 'migrations', 'apply', 'DB', '--remote'], true],
		[['d1', 'migrations', 'list', 'DB', '--remote'], false],
		[['d1', 'create', 'cogsend'], true],
		[['r2', 'bucket', 'create', 'media'], true],
		[['r2', 'bucket', 'list'], false],
		[['whoami'], false],
		[['dev'], false]
	])('%j → %s', (args, guarded) => {
		expect(isGuardedCommand(args)).toBe(guarded);
	});
});

describe('the deploy record', () => {
	it('keeps one account per Worker and rewrites only on a change', () => {
		const file = join(scratch(), '.wrangler', 'deployed-accounts.json');
		expect(recordedAccount('cogsend', file)).toBeNull();
		expect(recordAccount('cogsend', HOME, { file })).toBe(true);
		expect(recordAccount('cogsend', HOME, { file })).toBe(false);
		expect(recordAccount('other-instance', OTHER, { file })).toBe(true);
		expect(recordedAccount('cogsend', file)).toBe(HOME);
		expect(recordedAccount('other-instance', file)).toBe(OTHER);
	});

	it('ignores a record that is not an account id', () => {
		const dir = scratch();
		const file = join(dir, 'records.json');
		writeFileSync(file, JSON.stringify({ cogsend: { accountId: 'not-an-id' } }));
		expect(recordedAccount('cogsend', file)).toBeNull();
		writeFileSync(file, 'not json');
		expect(recordedAccount('cogsend', file)).toBeNull();
		expect(recordAccount('cogsend', 'nope', { file })).toBe(false);
	});
});

describe('checking the target', () => {
	function setup(recorded: string | null) {
		const dir = scratch();
		const config = join(dir, 'wrangler.jsonc');
		writeFileSync(config, JSON.stringify({ name: 'cogsend' }));
		const file = join(dir, 'records.json');
		if (recorded) recordAccount('cogsend', recorded, { file });
		return { args: ['--config', config], file };
	}

	it('refuses when the command reaches another account than the deploy', () => {
		const { args, file } = setup(HOME);
		const check = checkTarget({ args, file, env: {}, run: fakeRun(OTHER).run });
		expect(check.verdict).toBe('mismatch');
		const told = explainTarget(check);
		expect(told.refuse).toBe(true);
		expect(told.headline).toContain(`deployed cogsend to account ${HOME}`);
		expect(told.headline).toContain(`would reach ${OTHER}`);
		// Pinning account_id is not the fix here: with the wrong login it only
		// turns this refusal into an authentication error.
		expect(told.notes.join('\n')).toContain(`use a login that reaches ${HOME}`);
		expect(told.notes.join('\n')).toContain('npx wrangler auth activate <profile>');
		expect(told.notes.join('\n')).not.toContain('account_id');
		expect(told.notes.join('\n')).toContain('COGSEND_ALLOW_ACCOUNT_CHANGE=1 npm run deploy');
	});

	it('lets a deliberate move through', () => {
		const { args, file } = setup(HOME);
		const check = checkTarget({
			args,
			file,
			env: { COGSEND_ALLOW_ACCOUNT_CHANGE: '1' },
			run: fakeRun(OTHER).run
		});
		expect(check.verdict).toBe('changing');
		expect(explainTarget(check).refuse).toBe(false);
	});

	it('names the account when the login lists it, and the profile in use', () => {
		const { args, file } = setup(HOME);
		const check = checkTarget({
			args,
			file,
			env: { WRANGLER_PROFILE: 'personal' },
			run: fakeRun(HOME, { [HOME]: 'Home' }).run
		});
		expect(check.verdict).toBe('match');
		expect(explainTarget(check).headline).toBe(
			`target: cogsend on Home (${HOME}) · profile personal`
		);
	});

	it('probes with the command’s own config and profile', () => {
		const { args, file } = setup(null);
		const { run, calls } = fakeRun(HOME);
		checkTarget({ args: [...args, '--profile', 'personal'], file, env: {}, run });
		expect(calls[0].args).toEqual(['secret', 'list', ...args, '--profile', 'personal']);
		expect(calls[0].env.WRANGLER_LOG).toBe('debug');
		expect(calls[1].args).toEqual(['whoami', '--json']);
	});

	it('never refuses on an account it could not read', () => {
		const { args, file } = setup(HOME);
		const check = checkTarget({ args, file, env: {}, run: fakeRun(null).run });
		expect(check.verdict).toBe('unknown');
		const told = explainTarget(check);
		expect(told.refuse).toBe(false);
		expect(told.headline).toContain('account not confirmed (Not logged in.)');
	});

	it('looks up the record under a Worker name the caller already knows', () => {
		const { args, file } = setup(null);
		recordAccount('second-instance', HOME, { file });
		const check = checkTarget({
			args,
			worker: 'second-instance',
			file,
			env: {},
			run: fakeRun(OTHER).run
		});
		expect(check.worker).toBe('second-instance');
		expect(check.verdict).toBe('mismatch');
	});

	it('says a first deploy records the account', () => {
		const { args, file } = setup(null);
		const check = checkTarget({ args, file, env: {}, run: fakeRun(HOME).run });
		expect(check.verdict).toBe('new');
		expect(explainTarget(check).notes[0]).toContain('deploying records this account');
	});
});

/**
 * The wrapper end to end, with a fake `npx` on PATH standing in for wrangler:
 * it names `account` in its debug log and records every command it was given.
 */
describe('scripts/wrangler.mjs', () => {
	function checkout(account: string) {
		const dir = scratch();
		cpSync('scripts', join(dir, 'scripts'), { recursive: true });
		writeFileSync(join(dir, 'wrangler.jsonc'), JSON.stringify({ name: 'cogsend' }));
		const bin = join(dir, 'bin');
		mkdirSync(bin);
		writeFileSync(
			join(bin, 'npx'),
			`#!${process.execPath}
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (process.env.WRANGLER_LOG === 'debug') {
	process.stderr.write(${JSON.stringify(requestLine(account))} + '\\n');
	process.exit(1);
}
appendFileSync(${JSON.stringify(join(dir, 'npx.log'))}, JSON.stringify(args) + '\\n');
if (args[1] === 'whoami') process.stdout.write(JSON.stringify({ loggedIn: true, accounts: [] }));
if (args[1] === 'deploy') process.stdout.write('Uploaded cogsend\\n  https://cogsend.example.workers.dev\\n');
process.exit(0);
`
		);
		chmodSync(join(bin, 'npx'), 0o755);
		const wrangler = (args: string[], env: Record<string, string> = {}) => {
			const result = spawnSync(process.execPath, ['scripts/wrangler.mjs', ...args], {
				cwd: dir,
				encoding: 'utf8',
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH}`,
					COGSEND_NOTE_TIMEOUT_MS: '5000',
					...env
				}
			});
			const log = join(dir, 'npx.log');
			const commands = existsSync(log)
				? readFileSync(log, 'utf8')
						.trim()
						.split('\n')
						.map((line) => (JSON.parse(line) as string[]).slice(1))
				: [];
			return { result, commands };
		};
		const record = join(dir, '.wrangler', 'deployed-accounts.json');
		return { dir, wrangler, record };
	}

	it('records the account a deploy went to', () => {
		const { wrangler, record } = checkout(HOME);
		const { result } = wrangler(['deploy']);
		expect(result.status).toBe(0);
		expect(result.stderr).toContain(`target: cogsend on ${HOME}`);
		expect(JSON.parse(readFileSync(record, 'utf8')).cogsend.accountId).toBe(HOME);
	});

	it('refuses a secret for another account before wrangler sees it', () => {
		const { wrangler, record } = checkout(OTHER);
		recordAccount('cogsend', HOME, { file: record });
		const { result, commands } = wrangler(['secret', 'put', 'THREADS_APP_ID']);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('refusing: this checkout deployed cogsend');
		expect(commands.some((args) => args[0] === 'secret' && args[1] === 'put')).toBe(false);
	});

	it('runs it on the recorded account', () => {
		const { wrangler, record } = checkout(HOME);
		recordAccount('cogsend', HOME, { file: record });
		const { result, commands } = wrangler(['secret', 'put', 'THREADS_APP_ID']);
		expect(result.status).toBe(0);
		expect(commands).toContainEqual(['secret', 'put', 'THREADS_APP_ID']);
	});

	it('moves the record on a deliberate account change', () => {
		const { wrangler, record } = checkout(OTHER);
		recordAccount('cogsend', HOME, { file: record });
		expect(wrangler(['deploy']).result.status).toBe(1);
		const moved = wrangler(['deploy'], { COGSEND_ALLOW_ACCOUNT_CHANGE: '1' });
		expect(moved.result.status).toBe(0);
		expect(recordedAccount('cogsend', record)).toBe(OTHER);
	});

	it('leaves the check to a script that already made it', () => {
		const { wrangler, record } = checkout(OTHER);
		recordAccount('cogsend', HOME, { file: record });
		const { result } = wrangler(['secret', 'put', 'X'], { COGSEND_TARGET_CHECKED: HOME });
		expect(result.status).toBe(0);
		expect(result.stderr).not.toContain('target:');
	});
});

/**
 * Which Cloudflare account a command in this checkout reaches, and whether that
 * is the account the checkout deployed to.
 *
 * Wrangler picks the account from `account_id` in the config,
 * CLOUDFLARE_ACCOUNT_ID, `--profile`, the profile bound to the directory or the
 * default login, and says nothing about which one won. A checkout moved out of
 * a bound directory, or one command run without WRANGLER_PROFILE, therefore
 * writes to another account without a word: when both accounts have a Worker
 * of the same name, even the secret list afterwards agrees that it worked.
 *
 * `whoami` cannot answer this: it refuses `--profile`. So the account is read
 * from a request wrangler itself makes, with everything above applied: its
 * debug log names the account in every API path. Only that id is kept; the log
 * is never printed.
 *
 * Each deploy records the account per Worker name in RECORD_FILE, and the
 * commands that write refuse to run against a different one. An unreadable
 * account never blocks anything: the refusal needs two ids that disagree.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { effectiveConfigPath, parseJsonc } from './wrangler-config.mjs';

/** Relative to the checkout, like `wrangler.personal.jsonc`. `.wrangler/` is
 *  already gitignored, and deleting it only means the next deploy records again. */
export const RECORD_FILE = '.wrangler/deployed-accounts.json';

/** Set once a script has checked, so the wrangler calls it makes do not each
 *  check again. Holds the account id, or `unknown`. */
export const CHECKED_ENV = 'COGSEND_TARGET_CHECKED';

/** The deliberate way to move an instance to another account. */
export const ALLOW_CHANGE_ENV = 'COGSEND_ALLOW_ACCOUNT_CHANGE';

const ACCOUNT_ID = /^[0-9a-f]{32}$/;

/**
 * The account in the first Worker-script request of a wrangler debug log. Only
 * that path: it is the probe's own request, so an account-listing call made on
 * the way cannot be mistaken for the target.
 *
 * @param {string} text
 * @returns {string | null}
 */
export function accountIdFromLog(text) {
	return (
		/\/client\/v4\/accounts\/([0-9a-f]{32})\/workers\/scripts\//.exec(String(text))?.[1] ?? null
	);
}

/**
 * Commands that change something on the account. Reads are left alone: they
 * cannot do damage, and the account check itself is one.
 *
 * @param {string[]} args
 */
export function isGuardedCommand(args) {
	if (args.includes('--dry-run')) return false;
	const [command, sub, third] = args;
	const remote = args.includes('--remote');
	switch (command) {
		case 'deploy':
			return true;
		case 'secret':
			return ['put', 'delete', 'bulk'].includes(sub);
		case 'versions':
			return ['upload', 'deploy'].includes(sub) || (sub === 'secret' && third !== 'list');
		case 'd1':
			return (
				['create', 'delete'].includes(sub) ||
				(remote && (sub === 'execute' || (sub === 'migrations' && third === 'apply')))
			);
		case 'r2':
			return (
				(sub === 'bucket' && ['create', 'delete'].includes(third)) ||
				(sub === 'object' && remote && ['put', 'delete'].includes(third))
			);
		default:
			return false;
	}
}

/**
 * The Worker name from the config a command with these args uses.
 *
 * @param {string[]} [args]
 * @returns {string | null}
 */
export function workerName(args = []) {
	try {
		const config = parseJsonc(readFileSync(effectiveConfigPath(args, existsSync), 'utf8'));
		return typeof config?.name === 'string' && config.name ? config.name : null;
	} catch {
		return null;
	}
}

/**
 * @param {string} [file]
 * @returns {Record<string, { accountId: string, recordedAt?: string }>}
 */
export function readRecords(file = RECORD_FILE) {
	try {
		const parsed = JSON.parse(readFileSync(file, 'utf8'));
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/**
 * @param {string} worker
 * @param {string} [file]
 * @returns {string | null}
 */
export function recordedAccount(worker, file = RECORD_FILE) {
	const id = readRecords(file)[worker]?.accountId;
	return typeof id === 'string' && ACCOUNT_ID.test(id) ? id : null;
}

/**
 * Remember the account a Worker was deployed to. Written only when it changes.
 *
 * @param {string} worker
 * @param {string} accountId
 * @param {{ file?: string, now?: Date }} [options]
 * @returns {boolean} whether the record changed
 */
export function recordAccount(worker, accountId, { file = RECORD_FILE, now = new Date() } = {}) {
	if (!worker || !ACCOUNT_ID.test(accountId)) return false;
	const records = readRecords(file);
	if (records[worker]?.accountId === accountId) return false;
	records[worker] = { accountId, recordedAt: now.toISOString() };
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(records, null, '\t')}\n`);
	return true;
}

/**
 * @typedef {{ status: number | null, stdout?: string | null, stderr?: string | null }} RunResult
 * @typedef {(args: string[], env: Record<string, string>) => RunResult} Run
 */

/**
 * Through the repo wrapper, so the config and profile it applies are the ones
 * the real command gets. Bounded: a stalled request must not hang a deploy.
 *
 * @type {Run}
 */
function runWrapper(args, env) {
	return spawnSync('node', ['scripts/wrangler.mjs', ...args], {
		encoding: 'utf8',
		env: { ...process.env, ...env },
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 60_000,
		maxBuffer: 32 * 1024 * 1024
	});
}

/**
 * The flags of a command that decide its account, for the probe to repeat.
 *
 * @param {string[]} args
 */
function accountFlags(args) {
	const out = [];
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (['--profile', '--config', '-c'].includes(arg) && args[i + 1] !== undefined) {
			out.push(arg, args[i + 1]);
			i += 1;
		} else if (/^(--profile|--config|-c)=/.test(arg)) {
			out.push(arg);
		}
	}
	return out;
}

/**
 * The error wrangler printed, without its debug lines, for a failure line.
 *
 * @param {string} text
 */
function failureReason(text) {
	const found = String(text)
		// eslint-disable-next-line no-control-regex -- terminal colours
		.replace(/\u001b\[[0-9;]*m/g, '')
		.split('\n')
		.map((line) => line.trim())
		.find((line) => /\[ERROR\]/.test(line));
	return found
		? found.replace(/^.*\[ERROR\]\s*/, '').slice(0, 200)
		: 'wrangler made no API request';
}

/**
 * The account a command with these args reaches, and its name when the active
 * login lists it.
 *
 * `secret list` is the probe because it is a read scoped to the Worker's own
 * account, and it names the account even when the Worker does not exist yet.
 *
 * @param {{ args?: string[], run?: Run }} [options]
 * @returns {{ accountId: string | null, accountName: string | null, reason?: string }}
 */
export function resolveAccount({ args = [], run = runWrapper } = {}) {
	const probe = run(['secret', 'list', ...accountFlags(args)], {
		WRANGLER_LOG: 'debug',
		[CHECKED_ENV]: 'unknown'
	});
	const log = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
	const accountId = accountIdFromLog(log);
	if (!accountId) return { accountId: null, accountName: null, reason: failureReason(log) };

	// `whoami` answers for the folder's login, never a profile (see
	// profileArgs), but a name belongs to its id whichever login lists it.
	const who = run(['whoami', '--json'], { [CHECKED_ENV]: 'unknown' });
	let accountName = null;
	try {
		const parsed = JSON.parse(who.stdout ?? '');
		const match = (parsed?.accounts ?? []).find((/** @type {any} */ a) => a?.id === accountId);
		accountName = typeof match?.name === 'string' ? match.name : null;
	} catch {
		// No name is fine: the id is the answer.
	}
	return { accountId, accountName };
}

/**
 * @typedef {{
 *   verdict: 'match' | 'new' | 'changing' | 'mismatch' | 'unknown',
 *   worker: string | null,
 *   current: { accountId: string | null, accountName: string | null, reason?: string },
 *   recorded: string | null,
 *   profile: string | null
 * }} TargetCheck
 */

/**
 * Compare the account a command would reach with the one recorded for its
 * Worker.
 *
 * `worker` is for a caller that knows the name before the config says it
 * (`setup` in a dry run, or before it writes the config).
 *
 * @param {{ args?: string[], worker?: string | null, env?: Record<string, string | undefined>, run?: Run, file?: string }} [options]
 * @returns {TargetCheck}
 */
export function checkTarget({
	args = [],
	worker = workerName(args),
	env = process.env,
	run,
	file = RECORD_FILE
} = {}) {
	const current = resolveAccount({ args, run });
	const recorded = worker ? recordedAccount(worker, file) : null;
	const flagged = args.find((arg) => arg.startsWith('--profile='))?.slice('--profile='.length);
	const profileIndex = args.indexOf('--profile');
	const profile =
		flagged ||
		(profileIndex >= 0 ? args[profileIndex + 1] : undefined) ||
		env.WRANGLER_PROFILE?.trim() ||
		null;
	const allowChange = ['1', 'true', 'yes'].includes(
		String(env[ALLOW_CHANGE_ENV] ?? '').toLowerCase()
	);
	/** @type {TargetCheck['verdict']} */
	let verdict;
	if (!current.accountId) verdict = 'unknown';
	else if (!recorded) verdict = 'new';
	else if (recorded === current.accountId) verdict = 'match';
	else verdict = allowChange ? 'changing' : 'mismatch';
	return { verdict, worker, current, recorded, profile };
}

/** @param {{ accountId: string | null, accountName: string | null }} account */
function accountLabel({ accountId, accountName }) {
	return accountName ? `${accountName} (${accountId})` : String(accountId);
}

/**
 * What to print for a check, in whichever style the calling script uses.
 *
 * @param {TargetCheck} check
 * @returns {{ refuse: boolean, headline: string, notes: string[] }}
 */
export function explainTarget(check) {
	const worker = check.worker ?? 'the Worker';
	const via = check.profile ? ` · profile ${check.profile}` : '';
	const target = `target: ${worker} on ${accountLabel(check.current)}${via}`;
	switch (check.verdict) {
		case 'match':
			return { refuse: false, headline: target, notes: [] };
		case 'new':
			return {
				refuse: false,
				headline: target,
				notes: ['no deploy recorded from this checkout yet; deploying records this account']
			};
		case 'changing':
			return {
				refuse: false,
				headline: target,
				notes: [`${ALLOW_CHANGE_ENV} is set: moving away from account ${check.recorded}`]
			};
		case 'unknown':
			return {
				refuse: false,
				headline: `target: ${worker}, account not confirmed (${check.current.reason})`,
				notes: []
			};
		default:
			return {
				refuse: true,
				headline: `refusing: this checkout deployed ${worker} to account ${check.recorded}, but this command would reach ${accountLabel(check.current)}${via}`,
				notes: [
					`use a login that reaches ${check.recorded}: WRANGLER_PROFILE=<profile> before the command, or bind this folder to that profile once with npx wrangler auth activate <profile>`,
					`moving the instance on purpose: ${ALLOW_CHANGE_ENV}=1 npm run deploy`
				]
			};
	}
}

/**
 * Check once for a script that makes several wrangler calls, and tell those
 * calls it was done.
 *
 * `args` are the flags the script passes on to wrangler, such as `--config`.
 *
 * @param {{ print: (headline: string, notes: string[], verdict: TargetCheck['verdict']) => void, refuse: (headline: string, notes: string[]) => never | void, args?: string[], worker?: string | null, env?: NodeJS.ProcessEnv, run?: Run }} io
 * @returns {TargetCheck}
 */
export function guardTarget({ print, refuse, args = [], worker, env = process.env, run }) {
	const check = checkTarget({ args, worker: worker ?? workerName(args), env, run });
	const told = explainTarget(check);
	if (told.refuse) {
		refuse(told.headline, told.notes);
		return check;
	}
	print(told.headline, told.notes, check.verdict);
	env[CHECKED_ENV] = check.current.accountId ?? 'unknown';
	return check;
}

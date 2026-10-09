#!/usr/bin/env node
/**
 * Wrangler wrapper used by every npm script, so a checkout can keep its own
 * deployment details out of version control.
 *
 * 1. Config: if `wrangler.personal.jsonc` exists it is passed via `--config`.
 *    That file is gitignored and holds instance-specific values — your Worker
 *    name, your D1 `database_id`, your R2 bucket — so `wrangler.jsonc` in the
 *    repo can stay generic and upstream-friendly.
 * 2. Profile: when WRANGLER_PROFILE is set, `--profile` is added. Multi-account
 *    users pick an account with `WRANGLER_PROFILE=my-account npm run deploy`
 *    instead of the repo hardcoding a profile name.
 * 3. Account: a command that writes (deploy, secrets, remote D1) first checks
 *    that it reaches the account this checkout last deployed to, and refuses
 *    when it does not; a deploy records that account. See
 *    ./lib/target-account.mjs. A script that already checked says so through
 *    COGSEND_TARGET_CHECKED, so its calls are not each checked again.
 * 4. Cron quota: a deploy that Cloudflare refuses only because the account has
 *    no cron-trigger slot left (free plan: five per account) is retried once
 *    with the trigger removed, so the Worker still ships and the build is not
 *    marked failed. The outcome is recorded in D1 for the app and
 *    `npm run doctor` to read. COGSEND_STRICT_CRON=1 opts out of the retry.
 * 5. Release tag: a deploy is tagged `v<package version>`, and refuses to
 *    replace a Worker already running a newer tag (one updated from Settings,
 *    say) unless given --allow-downgrade. See ./lib/deployed-version.mjs.
 *
 * Explicit flags always win: passing `--config` or `--profile` yourself
 * disables the corresponding inference.
 *
 * Usage: node scripts/wrangler.mjs <wrangler args...>
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
	NO_CRON_CONFIG_NAME,
	configArg,
	cronCount,
	cronFallbackWarning,
	cronStateValue,
	effectiveConfigPath as configPathFor,
	isCronQuotaError,
	parseJsonc,
	profileArgs,
	withoutConfigArg,
	withoutCronTriggers
} from './lib/wrangler-config.mjs';
import { isToolNoise, isVerbose } from './lib/cli.mjs';
import { downgradeProblem, servingTag } from './lib/deployed-version.mjs';
import {
	CHECKED_ENV,
	checkTarget,
	explainTarget,
	isGuardedCommand,
	recordAccount,
	workerName
} from './lib/target-account.mjs';

const PERSONAL_CONFIG = 'wrangler.personal.jsonc';
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
/** The D1 note is metadata: give it a minute, then carry on regardless. The
 *  environment override exists so a test can shrink it. */
const NOTE_TIMEOUT_MS = Number(process.env.COGSEND_NOTE_TIMEOUT_MS) || 60_000;
// `--verbose` and `--allow-downgrade` are ours, not wrangler's: they are
// stripped before the command line is built, so
// `node scripts/wrangler.mjs deploy --verbose` works too.
const OWN_FLAGS = ['--verbose', '--allow-downgrade'];
const rawArgs = process.argv.slice(2);
let args = rawArgs.filter((arg) => !OWN_FLAGS.includes(arg));

const hasFlag = (...names) =>
	args.some((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)));

// Every deploy names the release it ships, so a later deploy (or the in-app
// updater) can tell what is running; see ./lib/deployed-version.mjs.
// Outside a checkout (no package.json) there is no release to name or protect.
const LOCAL_VERSION = (() => {
	try {
		const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
		return typeof version === 'string' ? version : null;
	} catch {
		return null;
	}
})();
if (LOCAL_VERSION && args[0] === 'deploy' && !hasFlag('--tag')) {
	args = [...args, '--tag', `v${LOCAL_VERSION}`];
}
const allowDowngrade =
	rawArgs.includes('--allow-downgrade') ||
	['1', 'true', 'yes'].includes((process.env.COGSEND_ALLOW_DOWNGRADE ?? '').toLowerCase());

const configArgs =
	!existsSync(PERSONAL_CONFIG) || hasFlag('-c', '--config') ? [] : ['--config', PERSONAL_CONFIG];

// The account selector, from the helper in ./lib/wrangler-config.mjs: an
// explicit `--profile` in the caller's argv wins over the environment.
const accountArgs = profileArgs(args, process.env);

const overrides = [...accountArgs, ...configArgs];
const fullArgs = [...args, ...overrides];

/** The command line, for `--verbose` and for failures — not for every call. */
function announce() {
	console.error(`\n$ npx wrangler ${fullArgs.join(' ')}`);
	if (overrides.length) {
		console.error(`  (${overrides.join(' ')} applied by scripts/wrangler.mjs)`);
	}
}
if (isVerbose()) announce();

/**
 * Pass output through while dropping wrangler's chatter: the update banner and
 * its rule on every call, and the "using fallback value" lines it prints when it
 * is not attached to a terminal. A line is held only until its newline arrives,
 * so progress still appears as it happens.
 *
 * @param {NodeJS.WriteStream} target
 */
function noiseFilter(target) {
	let pending = '';
	return {
		write(chunk) {
			pending += chunk;
			const lines = pending.split('\n');
			pending = lines.pop() ?? '';
			const kept = lines.filter((line) => !isToolNoise(line));
			if (kept.length) target.write(`${kept.join('\n')}\n`);
		},
		end() {
			if (pending) target.write(pending);
			pending = '';
		}
	};
}

/**
 * Run wrangler.
 *
 * `capture` pipes the output so we can read it (and still streams it live, so
 * nothing disappears); everything else inherits our stdio, which keeps the TTY
 * for interactive commands like `dev`, `login` and `secret put` — colours,
 * prompts and progress included. `quiet` keeps a capture to ourselves (used for
 * the D1 note, whose output nobody asked to see).
 *
 * `timeout` bounds a call whose result is optional (the D1 note): a stalled API
 * request must not hold up a deploy that has already succeeded.
 *
 * @param {string[]} wranglerArgs
 * @param {{ capture?: boolean, quiet?: boolean, timeoutMs?: number }} [options]
 * @returns {Promise<{ status: number, output: string }>}
 */
function runWrangler(wranglerArgs, { capture = false, quiet = false, timeoutMs = 0 } = {}) {
	/** Kill a run that overstays, and report it like any other failure. */
	const withTimeout = (child, settle) => {
		if (!timeoutMs) return;
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			settle({ status: 124, output: `timed out after ${timeoutMs}ms` });
		}, timeoutMs);
		child.on('close', () => clearTimeout(timer));
	};

	if (!capture && !quiet) {
		return new Promise((resolve) => {
			const child = spawn('npx', ['wrangler', ...wranglerArgs], { stdio: 'inherit' });
			child.on('error', (err) => {
				process.stderr.write(`could not run wrangler: ${err.message}\n`);
				resolve({ status: 1, output: '' });
			});
			child.on('close', (status) => resolve({ status: status ?? 1, output: '' }));
		});
	}
	return new Promise((resolve) => {
		let settled = false;
		const settle = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		const child = spawn('npx', ['wrangler', ...wranglerArgs], {
			stdio: ['inherit', 'pipe', 'pipe']
		});
		withTimeout(child, settle);
		let output = '';
		/** Where a captured chunk goes: filtered by default, raw under
		 *  `--verbose`, nowhere when the caller asked for quiet. */
		const filters = [];
		const sink = (stream) => {
			if (quiet) return () => {};
			if (isVerbose()) return (chunk) => stream.write(chunk);
			const filter = noiseFilter(stream);
			filters.push(filter);
			return (chunk) => filter.write(chunk);
		};
		const writeStdout = sink(process.stdout);
		const writeStderr = sink(process.stderr);
		child.stdout.on('data', (chunk) => {
			output += chunk;
			writeStdout(chunk);
		});
		child.stderr.on('data', (chunk) => {
			output += chunk;
			writeStderr(chunk);
		});
		child.on('error', (err) => {
			process.stderr.write(`could not run wrangler: ${err.message}\n`);
			settle({ status: 1, output });
		});
		child.on('close', (status) => {
			for (const filter of filters) filter.end();
			settle({ status: status ?? 1, output });
		});
	});
}

/** The config file this run actually deploys. */
function effectiveConfigPath() {
	return configPathFor(args, existsSync);
}

/** Read the config that will be deployed, or null when it is unreadable. */
function readConfig(path) {
	try {
		return parseJsonc(readFileSync(path, 'utf8'));
	} catch {
		return null;
	}
}

/**
 * Record what happened to the trigger, for the app's Settings page and
 * `npm run doctor`. Best effort by design: a brand-new database has no
 * `app_settings` table until the first request bootstraps it, and a missing
 * note only ever means "the app falls back to its other signals".
 */
async function noteCronState(value) {
	const sql =
		`INSERT INTO app_settings (key, value, updated_at) VALUES ('cron_state', '${value}', ${Date.now()}) ` +
		`ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;
	await runWrangler(
		[
			...accountArgs,
			'--config',
			effectiveConfigPath(),
			'd1',
			'execute',
			'DB',
			'--remote',
			'--yes',
			'--command',
			sql
		],
		{ quiet: true, timeoutMs: NOTE_TIMEOUT_MS }
	);
}

const isDeploy = args[0] === 'deploy';
const isDryRun = hasFlag('--dry-run');
const strict = ['1', 'true', 'yes'].includes((process.env.COGSEND_STRICT_CRON ?? '').toLowerCase());

const alreadyChecked = process.env[CHECKED_ENV];
let targetAccount = ACCOUNT_ID.test(alreadyChecked ?? '') ? alreadyChecked : null;
if (isGuardedCommand(args) && !alreadyChecked) {
	const check = checkTarget({ args });
	const told = explainTarget(check);
	console.error(told.headline);
	for (const line of told.notes) console.error(`  ${line}`);
	if (told.refuse) process.exit(1);
	targetAccount = check.current.accountId;
}

if (isDeploy && !isDryRun && LOCAL_VERSION && !allowDowngrade) {
	// Read-only, with the same account and config as the deploy it guards.
	// The deploy's own config, whether it was passed explicitly or inferred.
	const explicitConfig = configArg(args);
	const statusOverrides = [
		...accountArgs,
		...(explicitConfig ? ['--config', explicitConfig] : configArgs)
	];
	const serving = servingTag((wranglerArgs) => {
		const run = spawnSync('npx', ['wrangler', ...wranglerArgs, ...statusOverrides], {
			encoding: 'utf8',
			maxBuffer: 16 * 1024 * 1024
		});
		return { status: run.status, stdout: run.stdout ?? '' };
	});
	const problem = downgradeProblem(serving.tag, LOCAL_VERSION);
	if (problem) {
		console.error(`\n${problem}`);
		process.exit(1);
	}
}

const result = await runWrangler(fullArgs, { capture: isDeploy });
let status = result.status;
let fellBack = false;

// A failure is the one time the operator needs the command that produced it.
if (status !== 0 && !isVerbose()) announce();

if (isDeploy && status !== 0 && !strict && isCronQuotaError(result.output)) {
	// The code and assets are already uploaded; only the schedule was refused.
	// Retry with the trigger removed so the deploy finishes cleanly and the
	// schedule state is explicit (`crons: []`) instead of half-applied.
	const source = effectiveConfigPath();
	const config = readConfig(source);
	if (!config) {
		console.error(`could not read ${source} to retry without the cron trigger`);
	} else {
		const tempPath = join(dirname(source), NO_CRON_CONFIG_NAME);
		console.error(cronFallbackWarning());
		console.error(
			`\n$ npx wrangler ${[...withoutConfigArg(args), ...accountArgs, '--config', tempPath].join(' ')}`
		);
		try {
			writeFileSync(tempPath, `${JSON.stringify(withoutCronTriggers(config), null, '\t')}\n`);
			const retried = await runWrangler(
				[...withoutConfigArg(args), ...accountArgs, '--config', tempPath],
				{ capture: true }
			);
			status = retried.status;
			fellBack = retried.status === 0;
		} catch (err) {
			// Never let the fallback turn into a confusing error of its own: the
			// original failure is still on screen and still decides the exit code.
			console.error(`could not retry the deploy without the cron trigger: ${err?.message ?? err}`);
		} finally {
			rmSync(tempPath, { force: true });
		}
	}
}

if (isDeploy && !isDryRun && status === 0 && targetAccount) {
	const worker = workerName(args);
	if (worker && recordAccount(worker, targetAccount)) {
		console.error(`recorded: ${worker} is deployed to account ${targetAccount}`);
	}
}

if (isDeploy && !isDryRun && status === 0) {
	// One extra D1 round trip per deploy buys the app a precise answer instead
	// of "no tick yet": attached / disabled / unavailable. Skipped when the
	// config cannot be read: a wrong note is worse than no note.
	const config = readConfig(effectiveConfigPath());
	if (config) {
		await noteCronState(cronStateValue({ fallback: fellBack, crons: cronCount(config) }));
	}
}

process.exitCode = status;

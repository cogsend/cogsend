#!/usr/bin/env node
/**
 * One command to update a deployment: tests, remote migrations, build, deploy.
 *
 * One line per step instead of each tool's full output — a first run of
 * `d1 migrations apply` alone is a few hundred lines of box drawing. A step that
 * fails prints everything it said, because then the detail is the message, and
 * `--verbose` prints it all even when it works.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as ui from './lib/cli.mjs';
import { downgradeProblem, servingTag } from './lib/deployed-version.mjs';
import { syncMigrations } from './lib/migration-sync.mjs';
import { guardTarget } from './lib/target-account.mjs';
import { runWrangler, wranglerOutput } from './lib/wrangler-run.mjs';

/** One line in place of the progress line, then the progress line again. */
function retryNotice(progressText) {
	return () => {
		ui.clearProgress();
		ui.note('Cloudflare login was just refreshed, retrying…');
		ui.progress(progressText);
	};
}

/**
 * Run one step quietly.
 *
 * @param {string} label what the step is, for the failure line
 * @param {string} cmd @param {string[]} args `cmd` of `wrangler` goes through
 *   scripts/wrangler.mjs, with a retry for a refused fresh login
 * @param {string} [progressText] what the terminal shows while it runs
 * @returns {{ text: string, elapsedMs: number }}
 */
function run(label, cmd, args, progressText = label) {
	const startedAt = Date.now();
	ui.progress(progressText);
	const result =
		cmd === 'wrangler'
			? runWrangler(args, { onRetry: retryNotice(progressText) })
			: spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
	ui.clearProgress();
	const status = result.status ?? 1;
	const text = wranglerOutput(result);
	const verbose = ui.isVerbose();
	if (verbose) {
		ui.note(`$ ${cmd} ${args.join(' ')}`);
		if (text.trim()) process.stdout.write(`${ui.stripToolNoise(text)}\n`);
	}
	if (status !== 0) {
		if (!verbose && text.trim()) process.stderr.write(`${ui.stripToolNoise(text)}\n`);
		ui.error(`${label} failed — nothing was deployed.`);
		process.exit(status);
	}
	return { text, elapsedMs: Date.now() - startedAt };
}

/** `wrangler d1 execute --json`, through the repo wrapper. */
function d1Json(sql) {
	const result = runWrangler(['d1', 'execute', 'DB', '--remote', '--json', '--command', sql], {
		onRetry: retryNotice('checking the database')
	});
	if (result.status !== 0) {
		// Both streams: the wrapper's command line is on stderr, and with --json
		// wrangler writes Cloudflare's error to stdout.
		process.stderr.write(`${ui.stripToolNoise(wranglerOutput(result))}\n`);
		ui.error('checking the database failed — nothing was deployed.');
		process.exit(result.status ?? 1);
	}
	const parsed = JSON.parse(result.stdout);
	return parsed[0]?.results ?? [];
}

ui.headline('Deploying CogSend');

// Before the tests: a deploy to the wrong account should not cost a test run
// first.
ui.progress('checking the Cloudflare account');
guardTarget({
	print: (headline, notes, verdict) => {
		ui.clearProgress();
		(verdict === 'unknown' ? ui.warn : ui.ok)(headline);
		for (const line of notes) ui.note(line);
	},
	refuse: (headline, notes) => {
		ui.clearProgress();
		ui.error(`${headline}\n`);
		for (const line of notes) ui.note(line);
		ui.error('nothing was deployed.');
		process.exit(1);
	}
});

// Before the tests and the migrations: an instance updated from Settings runs
// a newer release than this checkout, and redeploying would roll it back.
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const allowDowngrade =
	process.argv.includes('--allow-downgrade') ||
	['1', 'true', 'yes'].includes((process.env.COGSEND_ALLOW_DOWNGRADE ?? '').toLowerCase());
if (!allowDowngrade) {
	ui.progress('checking the deployed version');
	const serving = servingTag((args) => {
		const result = runWrangler(args);
		return { status: result.status, stdout: result.stdout ?? '' };
	});
	ui.clearProgress();
	const problem = downgradeProblem(serving.tag, version);
	if (problem) {
		ui.error(`${problem}\n`);
		ui.error('nothing was deployed.');
		process.exit(1);
	}
	if (serving.tag) ui.ok(`deployed version is ${serving.tag}; this checkout is v${version}`);
}

const tests = run('the test suite', 'npx', ['vitest', 'run'], 'running the test suite');
ui.ok(`tests passed in ${ui.duration(tests.elapsedMs)}`);

// A database the app bootstrapped has the schema but no migration history, so
// record what it already satisfies before wrangler replays anything. Shared with
// `npm run db:migrate:remote` and `db:seed:local` so the three cannot drift
// apart; see scripts/lib/migration-sync.mjs.
const { recorded } = await syncMigrations({
	exec: async (sql) => {
		d1Json(sql);
	},
	query: async (sql) => d1Json(sql)
});
if (recorded.length) ui.note(`${recorded.length} migrations already present, recorded as applied`);

const migrate = run(
	'the migrations',
	'wrangler',
	['d1', 'migrations', 'apply', 'DB', '--remote'],
	'applying migrations'
);
ui.ok(ui.migrationsSummary(migrate.text) ?? 'remote database up to date');

const build = run('the build', 'npm', ['run', 'build'], 'building');
ui.ok(`built in ${ui.duration(build.elapsedMs)}`);

const deploy = run(
	'the deploy',
	'wrangler',
	['deploy', ...(allowDowngrade ? ['--allow-downgrade'] : [])],
	'deploying'
);
const facts = ui.deployFacts(deploy.text);
ui.ok(`deployed in ${ui.duration(deploy.elapsedMs)}`);
if (facts.bindings.length) ui.note(facts.bindings.join(' · '));
console.log(ui.box([ui.bold('deployed'), ui.url(facts.url ?? 'see the deploy output above')]));
console.log(`
  ${ui.bold('Next')}
    ${ui.green('·')} set a script token if you have not already: ${ui.dim('npm run secrets:put -- API_TOKEN')}
    ${ui.green('·')} scheduled posts tick from the Worker cron trigger (wrangler.jsonc → triggers);
      if the trigger could not be attached, Settings → Scheduled publishing has the
      tick URL and a token for an external cron.`);

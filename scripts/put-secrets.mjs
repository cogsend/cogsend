#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
	inspectDevVarsKey,
	isPlaceholderValue,
	parseDevVars,
	readDevVarsText
} from './lib/dev-vars.mjs';
import { guardTarget } from './lib/target-account.mjs';
import { readWorkerSecrets } from './lib/worker-secrets.mjs';

const DEV_VARS = '.dev.vars';
const API_TOKEN_FILE = '.api-token';

// Trimmed and deduplicated: a stray empty argument would otherwise match the
// first line with an `=` in it, and a repeated key would upload — and redeploy
// the Worker — once per mention.
const keys = [
	...new Set(
		process.argv
			.slice(2)
			.map((key) => key.trim())
			.filter(Boolean)
	)
];
// The app derives AUTH_SECRET and SCHEDULER_SECRET from APP_ENCRYPTION_KEY and
// takes APP_URL from the request, so those three are only uploaded when they are
// deliberately set locally (the loop below skips anything absent). The login
// itself is not a secret: `npm run setup` writes it into D1 as a PBKDF2 hash.
// Everything the app reads from the environment and that belongs in a secret.
// APP_NAME is a `[vars]` entry, and SKIP_TOTP is a local-development flag that
// must never travel — both are deliberately absent.
const wanted = keys.length
	? keys
	: [
			'APP_ENCRYPTION_KEY',
			'AUTH_SECRET',
			'APP_URL',
			'API_TOKEN',
			'SCHEDULER_SECRET',
			'LINKEDIN_CLIENT_ID',
			'LINKEDIN_CLIENT_SECRET',
			'THREADS_APP_ID',
			'THREADS_APP_SECRET',
			'INSTAGRAM_APP_ID',
			'INSTAGRAM_APP_SECRET',
			'X_CLIENT_ID',
			'X_CLIENT_SECRET',
			'MEDIA_PUBLIC_BASE_URL',
			'RESEND_API_KEY',
			'NOTIFY_EMAIL',
			'NOTIFY_FROM',
			'SUBREQUEST_LIMIT'
		];

// One read, one parser: `parseDevVars` answers "what would the Worker load",
// and the raw text is kept so a skip can name the line it looked at.
const devVarsText = readDevVarsText(DEV_VARS);
const devVars = parseDevVars(devVarsText);

function valueFromApiTokenFile() {
	try {
		return readFileSync(API_TOKEN_FILE, 'utf8').trim();
	} catch {
		return null;
	}
}

/**
 * Why a key is not being uploaded. "No local value" covers four different
 * situations — a commented-out example line, an empty one, a key that is not in
 * the file, and a missing `.api-token` — and the fix is different for each.
 * @param {string} key
 */
function missingReason(key) {
	if (key === 'API_TOKEN' && !existsSync(API_TOKEN_FILE) && !devVars.has(key)) {
		return `no ${API_TOKEN_FILE} and no API_TOKEN in ${DEV_VARS} — write one of them`;
	}
	const info = inspectDevVarsKey(devVarsText, key);
	if (info.status === 'commented') {
		return info.value
			? `${DEV_VARS}:${info.line} has it commented out — remove the leading "#"`
			: `${DEV_VARS}:${info.line} is still the commented example — uncomment it and add a value`;
	}
	if (info.status === 'empty') return `${DEV_VARS}:${info.line} has no value after the "="`;
	return `not in ${DEV_VARS} — add a line: ${key}=<value>`;
}

/**
 * The value cannot be read back from Cloudflare, so the only proof that an
 * upload landed is the Worker's own secret list. Wrangler exiting 0 is not that
 * proof: a `secret put` aimed at another Worker (a different
 * `wrangler.personal.jsonc`, another account) reports success too.
 */
function verifyUploads() {
	if (!uploaded.length) return;
	const secrets = readWorkerSecrets({
		run: (args) => {
			const result = spawnSync('node', ['scripts/wrangler.mjs', ...args], { encoding: 'utf8' });
			return {
				status: result.status ?? 1,
				stdout: result.stdout ?? '',
				stderr: result.stderr ?? ''
			};
		}
	});
	if (!secrets.ok) {
		// Not being able to ask is not the same as the answer being "no": a
		// logged-out shell must not turn a good upload into a failure.
		console.error(`could not verify against the Worker: ${secrets.reason}`);
		console.error('  check with: npm run doctor');
		return;
	}
	if (secrets.missingWorker) {
		console.error('the Worker does not exist yet, so nothing was uploaded to it');
		console.error('  deploy first: npm run deploy');
		process.exitCode = 1;
		return;
	}
	const missing = uploaded.filter((key) => !secrets.names.includes(key));
	if (missing.length) {
		console.error(`still missing on the Worker: ${missing.join(', ')}`);
		console.error('  check with: npm run doctor');
		process.exitCode = 1;
		return;
	}
	console.log(
		`verified: ${uploaded.length} secret${uploaded.length === 1 ? '' : 's'} on the Worker`
	);
}

function isLocalAppUrl(value) {
	try {
		const host = new URL(value).hostname.toLowerCase();
		return host === 'localhost' || host === '127.0.0.1' || host === '::1';
	} catch {
		return true;
	}
}

const uploaded = [];
const skipped = [];

for (const key of wanted) {
	const value =
		key === 'API_TOKEN' ? valueFromApiTokenFile() || devVars.get(key) : devVars.get(key);
	if (!value) {
		console.error(`skip ${key}: ${missingReason(key)}`);
		skipped.push(key);
		continue;
	}
	// The same refusal `setup` and the app's own boot guard apply: an example
	// value is not a configuration, and uploading one either breaks the deploy
	// (the app refuses to boot on it) or, for a longer list, hides the fact that
	// the real value is missing.
	if (isPlaceholderValue(value)) {
		console.error(`skip ${key}: still an example value`);
		skipped.push(key);
		continue;
	}
	if (key === 'APP_URL' && isLocalAppUrl(value)) {
		console.error('skip APP_URL: local .dev.vars points at localhost. Set production with:');
		console.error('  node scripts/wrangler.mjs secret put APP_URL');
		console.error('  (your production URL, e.g. https://cogsend.<account>.workers.dev)');
		skipped.push(key);
		continue;
	}
	// Checked at the first upload rather than up front, so a run that only
	// skips never waits on Cloudflare.
	if (!uploaded.length) {
		guardTarget({
			print: (headline, notes) => {
				console.log(headline);
				for (const line of notes) console.log(`  ${line}`);
			},
			refuse: (headline, notes) => {
				console.error(headline);
				for (const line of notes) console.error(`  ${line}`);
				console.error('nothing was uploaded');
				process.exit(1);
			}
		});
	}
	console.log(`uploading ${key}`);
	const result = spawnSync('node', ['scripts/wrangler.mjs', 'secret', 'put', key], {
		input: value,
		stdio: ['pipe', 'inherit', 'inherit']
	});
	if (result.status !== 0) {
		console.error(`failed ${key}: wrangler exited ${result.status ?? 1}`);
		process.exit(result.status ?? 1);
	}
	uploaded.push(key);
}

verifyUploads();

console.log(
	`uploaded ${uploaded.length} of ${wanted.length}${skipped.length ? `, skipped ${skipped.length}` : ''}`
);
// A key named on the command line is an instruction, not a preference: one that
// was skipped means the command did not do what it was asked, and a bare "done"
// would send someone off to debug the Worker instead of the file.
if (keys.length && uploaded.length < wanted.length) {
	const missed = wanted.filter((key) => !uploaded.includes(key));
	console.error(`not uploaded: ${missed.join(', ')}`);
	console.error('  fix the skips above and re-run, or set them in the Cloudflare dashboard');
	process.exitCode = 1;
}

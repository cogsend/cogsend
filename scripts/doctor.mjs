#!/usr/bin/env node
/**
 * Read-only preflight for a deployment: everything `npm run setup` would check,
 * without changing anything.
 *
 * Run it before a first deploy, or whenever the app misbehaves. It never
 * writes to Cloudflare, never applies migrations and never sets a secret — the
 * only network calls are reads, plus an unauthenticated GET of the app's own
 * `/api/health` when a URL is known.
 *
 * Usage:
 *   npm run doctor
 *   npm run doctor -- --app-url https://cogsend.example.com
 *
 * Exit code is 1 when something is broken (✗), 0 when only warnings (!) or
 * everything passed.
 */
import { spawnSync } from 'node:child_process';
import { bold, cyan, dim, green, red, yellow } from './lib/cli.mjs';
import { readWorkerSecrets } from './lib/worker-secrets.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLACEHOLDER_VALUES, readDevVars } from './lib/dev-vars.mjs';
import { readAccount } from './lib/account.mjs';
import { CHECKED_ENV, checkTarget, explainTarget } from './lib/target-account.mjs';
import { apiHeaders, onboardingUrl, readSubdomain } from './lib/workers-subdomain.mjs';

/**
 * @typedef {{ id: string, status: 'ok' | 'warn' | 'fail' | 'skip', label: string, detail?: string, fix?: string }} Check
 * @typedef {{ status: number, stdout: string, stderr: string }} RunResult
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PERSONAL_CONFIG = 'wrangler.personal.jsonc';
const COMMITTED_CONFIG = 'wrangler.jsonc';
const DEV_VARS = '.dev.vars';
const MIN_NODE = [22, 13, 0];

/**
 * Minimal JSONC reader: the configs carry comments.
 *
 * @param {string} file @returns {any}
 */
export function readJsonc(file) {
	const text = readFileSync(file, 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/.*$/gm, '$1')
		.replace(/,(\s*[}\]])/g, '$1');
	return JSON.parse(text);
}

/**
 * `.dev.vars` values as dotenv would read them: unquoted, comments stripped.
 *
 * @param {string} file @returns {Map<string, string>}
 */

/**
 * Everything that can be judged from the files alone.
 *
 * @param {any} config
 * @param {{ configFile?: string, devVars?: Map<string, string> | null }} [options]
 * @returns {Check[]}
 */
export function evaluateConfig(config, { configFile, devVars } = {}) {
	/** @type {Check[]} */
	const checks = [];
	const name = config?.name;
	checks.push(
		name
			? { id: 'config', status: 'ok', label: `Worker name: ${name}`, detail: configFile }
			: {
					id: 'config',
					status: 'fail',
					label: 'No Worker name in the config',
					fix: `Set "name" in ${configFile ?? COMMITTED_CONFIG}`
				}
	);

	const d1 = config?.d1_databases?.[0];
	if (!d1?.binding) {
		checks.push({
			id: 'd1-binding',
			status: 'fail',
			label: 'No D1 binding',
			fix: 'Add a d1_databases entry with binding "DB"'
		});
	} else if (d1.database_id) {
		checks.push({ id: 'd1-binding', status: 'ok', label: `D1 binding DB → ${d1.database_name}` });
	} else {
		checks.push({
			id: 'd1-binding',
			status: 'ok',
			label: `D1 binding DB → ${d1.database_name ?? '(named by Wrangler)'}`,
			detail: 'no database_id: Wrangler creates or adopts it on deploy'
		});
	}

	const bucket = config?.r2_buckets?.[0];
	checks.push(
		bucket?.bucket_name
			? { id: 'r2-binding', status: 'ok', label: `R2 binding MEDIA → ${bucket.bucket_name}` }
			: {
					id: 'r2-binding',
					status: 'warn',
					label: 'R2 binding has no bucket_name',
					detail: 'Wrangler derives one from the Worker name',
					fix: 'Set bucket_name so every path uses the same bucket'
				}
	);

	const crons = config?.triggers?.crons ?? [];
	checks.push(
		crons.length > 0
			? {
					id: 'cron',
					status: 'ok',
					label: `Cron trigger: ${crons.join(', ')}`,
					detail: 'one of the five per account the Workers free plan allows'
				}
			: {
					id: 'cron',
					status: 'warn',
					label: 'No cron trigger configured',
					detail: 'scheduled posts will not fire by themselves',
					fix: 'Add "triggers": { "crons": ["* * * * *"] }, or point an external cron at POST /api/internal/tick using the token from Settings -> Scheduled publishing'
				}
	);

	const key = devVars?.get('APP_ENCRYPTION_KEY');
	if (!devVars) {
		// No local file: nothing to judge, and that is normal for a deployment.
	} else if (!key) {
		checks.push({
			id: 'local-key',
			status: 'warn',
			label: `${DEV_VARS} has no APP_ENCRYPTION_KEY`,
			detail: 'local dev and `npm run secrets:put` need one',
			fix: 'openssl rand -hex 32 → APP_ENCRYPTION_KEY in .dev.vars'
		});
	} else if (PLACEHOLDER_VALUES.has(key)) {
		// Fine for localhost, refused on a real host (env.ts), so it never breaks
		// a deployment — it just must not be the value that gets deployed.
		checks.push({
			id: 'local-key',
			status: 'warn',
			label: `${DEV_VARS} has the example APP_ENCRYPTION_KEY`,
			detail: 'localhost works with it; a deployment refuses it',
			fix: 'openssl rand -hex 32 → replace APP_ENCRYPTION_KEY in .dev.vars before deploying'
		});
	} else {
		checks.push({ id: 'local-key', status: 'ok', label: `${DEV_VARS} has an APP_ENCRYPTION_KEY` });
	}

	return checks;
}

/**
 * Databases from `wrangler d1 list --json`; [] when the output is unusable.
 *
 * @param {string} stdout @returns {any[]}
 */
export function parseD1List(stdout) {
	try {
		const parsed = JSON.parse(stdout);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/**
 * AWS-style table output: look for the bucket name as a whole token.
 *
 * @param {string} stdout @param {string | undefined} bucketName @returns {boolean}
 */
export function bucketWasListed(stdout, bucketName) {
	if (!bucketName) return false;
	return new RegExp(
		`(^|[^\\w-])${bucketName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`
	).test(stdout);
}

/**
 * Number of unapplied migrations from `wrangler d1 migrations list` output.
 *
 * @param {string} stdout @returns {number | null}
 */
export function countUnappliedMigrations(stdout) {
	if (/No migrations to apply/i.test(stdout)) return 0;
	if (!/Migrations to be applied/i.test(stdout)) return null;
	return new Set(stdout.match(/[\w.-]+\.sql/g) ?? []).size;
}

/**
 * What a `/api/health` response means. A 503 carrying our own configuration
 * message is the placeholder-secret guard firing, which is a failure with a
 * fix; any other non-200 is a warning (network, proxy, wrong URL).
 *
 * @param {number} status @param {string} [body] @returns {Check}
 */
export function healthVerdict(status, body = '') {
	if (status === 200) return { id: 'app', status: 'ok', label: 'Deployment answers /api/health' };
	if (status === 503 && /Invalid environment|not configured/i.test(body)) {
		const detail = body.replace(/\s+/g, ' ').trim().slice(0, 200);
		return {
			id: 'app',
			status: 'fail',
			label: 'The deployment is up but not configured',
			detail,
			fix: 'Set real Worker secrets (`npm run secrets:put`), then redeploy'
		};
	}
	return {
		id: 'app',
		status: 'warn',
		label: `Deployment answered HTTP ${status}`,
		detail: body.replace(/\s+/g, ' ').trim().slice(0, 120) || undefined
	};
}

/**
 * What a `/api/scheduler/health` response means.
 *
 * The app cannot read its own cron schedule, so this is inference plus the note
 * the last deploy left in D1: a deployment whose trigger was refused (error
 * 10072) is the one case worth failing the run over, because scheduled posts
 * will silently wait for a tick that never comes.
 *
 * @param {number} status @param {any} body @returns {Check}
 */
export function schedulerVerdict(status, body = {}) {
	if (status === 401 || status === 403) {
		return {
			id: 'scheduler',
			status: 'warn',
			label: `Scheduler probe rejected (HTTP ${status})`,
			fix: 'API_TOKEN in .dev.vars must match the Worker secret of the same name'
		};
	}
	if (status !== 200) {
		return {
			id: 'scheduler',
			status: 'skip',
			label: `Scheduler check skipped (HTTP ${status})`
		};
	}
	const deploy = body?.deployCron ?? null;
	const lastTick = body?.lastTickAt ? new Date(body.lastTickAt) : null;
	if (body?.ok) {
		return {
			id: 'scheduler',
			status: 'ok',
			label: 'Scheduler ticks are arriving',
			detail:
				lastTick && !Number.isNaN(lastTick.getTime())
					? `last tick ${lastTick.toISOString()}`
					: undefined
		};
	}
	if (deploy?.status === 'unavailable') {
		return {
			id: 'scheduler',
			status: 'fail',
			label: `No cron trigger on the Worker${deploy.code ? ` (Cloudflare error ${deploy.code})` : ''}`,
			detail:
				'the last deploy was refused a schedule: the account is at its cron-trigger limit, so scheduled posts are not being published',
			fix: 'Free a trigger slot (another Worker -> Settings -> Trigger events), upgrade to Workers Paid, or point an external cron at POST /api/internal/tick with the token from Settings -> Scheduled publishing'
		};
	}
	if (deploy?.status === 'disabled') {
		return {
			id: 'scheduler',
			status: 'warn',
			label: 'No cron trigger is configured',
			detail: 'scheduled posts only publish when something calls the tick',
			fix: 'Add "triggers": { "crons": ["* * * * *"] } to the config, or use an external cron with the token from Settings -> Scheduled publishing'
		};
	}
	if (body?.neverTicked) {
		return {
			id: 'scheduler',
			status: 'warn',
			label: 'No tick has arrived yet',
			detail: 'nothing has published a scheduled post on this deployment',
			fix: 'Check the Worker cron trigger (Settings -> Trigger events), or use an external cron with the token from Settings -> Scheduled publishing'
		};
	}
	return {
		id: 'scheduler',
		status: 'warn',
		label: 'The scheduler has gone quiet',
		detail:
			lastTick && !Number.isNaN(lastTick.getTime())
				? `last tick ${lastTick.toISOString()}`
				: undefined,
		fix: 'Check the Worker cron trigger (Settings -> Trigger events), or point an external cron at POST /api/internal/tick'
	};
}

/**
 * Which shape of install this checkout is, from its git remotes.
 *
 * There is one way to install — a clone — but a deployment can still live in a
 * repository of your own (a fork, or a copy), and those update differently: a
 * plain clone pulls from here, the other two sync from upstream and push.
 *
 * @param {string} remotes @returns {'clone' | 'fork' | 'copy' | 'unknown'}
 */
export function installShape(remotes) {
	const text = (remotes ?? '').toLowerCase();
	if (!text.trim()) return 'unknown';
	// Any URL form: https://, ssh://, or the scp-like git@host:owner/repo. The
	// remote *name* is what identifies the relationship, so match that and then
	// look for the upstream slug anywhere in its URL. The repository moved from
	// deepakness/cogsend, and checkouts made before the move still name it.
	/** @param {string} name @returns {RegExp} */
	const remote = (name) =>
		new RegExp(`(^|\\n)${name}\\s+\\S*[/:](?:deepakness|cogsend)/cogsend\\b`);
	if (remote('upstream').test(text)) return 'fork';
	if (remote('origin').test(text)) return 'clone';
	if (/(^|\n)origin\s+\S+/.test(text)) return 'copy';
	return 'unknown';
}

/**
 * The command that updates this shape of install.
 *
 * @param {'clone' | 'fork' | 'copy' | 'unknown'} shape @returns {string}
 */
export function updateHint(shape) {
	if (shape === 'clone') return 'git pull && npm ci && npm run deploy:release';
	if (shape === 'fork')
		return 'Sync fork → Update branch in your fork, then deploy — or from a checkout: git pull upstream main && npm ci && npm run deploy:release';
	if (shape === 'copy')
		return 'git remote add upstream https://github.com/cogsend/cogsend && git pull upstream main && npm ci && npm run deploy:release';
	return 'see docs/deploy.md → Updating (git pull && npm ci && npm run deploy:release from a checkout)';
}

/**
 * What the latest release means for this deployment.
 *
 * `current` is the version the *deployed* Worker reports when an app URL is
 * known (that is what matters), and the local package.json otherwise.
 *
 * @param {{ current?: string, latest?: string | null, error?: string, shape?: string }} input @returns {Check}
 */
export function releaseVerdict({ current, latest, error, shape = 'unknown' } = {}) {
	if (!current) {
		return { id: 'release', status: 'skip', label: 'Update check skipped (no version to compare)' };
	}
	if (!latest) {
		return {
			id: 'release',
			status: 'skip',
			label: `Update check skipped (${error ?? 'GitHub did not answer'})`
		};
	}
	if (latest === current) {
		return { id: 'release', status: 'ok', label: `Version ${current} is the latest release` };
	}
	if (!isNewerVersion(latest, current)) {
		return {
			id: 'release',
			status: 'ok',
			label: `Version ${current} is newer than the latest release (${latest})`
		};
	}
	return {
		id: 'release',
		status: 'warn',
		label: `Version ${latest} is available (this deployment runs ${current}): install it from Settings → Instance, or from a checkout`,
		fix: updateHint(/** @type {any} */ (shape))
	};
}

/**
 * Numeric version comparison; unparsable versions are never "newer".
 *
 * @param {string} candidate @param {string} current @returns {boolean}
 */
export function isNewerVersion(candidate, current) {
	/** @param {string} value @returns {number[] | null} */
	const parse = (value) => {
		const match = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(value ?? '');
		return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
	};
	const a = parse(candidate);
	const b = parse(current);
	if (!a || !b) return false;
	for (let i = 0; i < 3; i += 1) {
		if (a[i] !== b[i]) return a[i] > b[i];
	}
	return false;
}

/**
 * Highest semver tag from a `/tags` listing: the fallback for a repository that
 * tags releases without publishing release objects (`/releases/latest` 404s).
 *
 * @param {any} json @returns {string | null}
 */
export function highestVersionTag(json) {
	if (!Array.isArray(json)) return null;
	let best = null;
	for (const entry of json) {
		const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
		if (!/^\s*v?\d+\.\d+\.\d+/.test(name)) continue;
		if (!best || isNewerVersion(name, best)) best = name;
	}
	return best ? best.replace(/^v/, '') : null;
}

/**
 * Latest release tag from GitHub's API response, or null when unusable.
 *
 * @param {any} json @returns {string | null}
 */
export function latestReleaseTag(json) {
	const tag = json?.tag_name;
	return typeof tag === 'string' && tag.trim() ? tag.trim().replace(/^v/, '') : null;
}

/**
 * Counts for the closing line.
 *
 * @param {Check[]} checks @returns {{ failed: number, warnings: number, ok: number, skipped: number }}
 */
export function summarize(checks) {
	return {
		failed: checks.filter((c) => c.status === 'fail').length,
		warnings: checks.filter((c) => c.status === 'warn').length,
		ok: checks.filter((c) => c.status === 'ok').length,
		skipped: checks.filter((c) => c.status === 'skip').length
	};
}

/** @type {Record<Check['status'], string>} */
const SYMBOL = { ok: '✓', warn: '!', fail: '✗', skip: '–' };

/**
 * Human report. Returns the text; the caller decides the exit code.
 *
 * @param {Check[]} checks @returns {string}
 */
export function formatReport(checks) {
	/** @param {keyof typeof SYMBOL} status */
	const symbol = (status) => {
		const glyph = SYMBOL[status] ?? '?';
		if (status === 'ok') return green(glyph);
		if (status === 'warn') return yellow(glyph);
		if (status === 'fail') return red(glyph);
		return dim(glyph);
	};
	const lines = [];
	for (const check of checks) {
		lines.push(
			`${symbol(check.status)} ${check.status === 'ok' ? check.label : bold(check.label)}`
		);
		if (check.detail) lines.push(dim(`    ${check.detail}`));
		if (check.fix) lines.push(`    ${cyan('fix:')} ${check.fix}`);
	}
	const { failed, warnings, ok, skipped } = summarize(checks);
	lines.push('');
	lines.push(
		`${ok} ok · ${warnings} warning${warnings === 1 ? '' : 's'} · ${failed} failure${failed === 1 ? '' : 's'}${skipped ? ` · ${skipped} skipped` : ''}`
	);
	lines.push('Nothing was changed.');
	return lines.join('\n');
}

/**
 * Run a command through the repo wrapper, captured and bounded.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ timeout?: number, env?: NodeJS.ProcessEnv }} [options]
 * @returns {RunResult}
 */
function run(command, args, { timeout = 90_000, env } = {}) {
	const result = spawnSync(command, args, { encoding: 'utf8', timeout, env });
	return {
		status: result.status ?? -1,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? ''
	};
}

/** @param {string[]} args @param {{ timeout?: number, env?: NodeJS.ProcessEnv }} [opts] @returns {RunResult} */
const wrangler = (args, opts) => run('node', ['scripts/wrangler.mjs', ...args], opts);

/** @returns {Check} */
function checkNode() {
	const [major, minor, patch] = process.versions.node.split('.').map(Number);
	const tooOld =
		major < MIN_NODE[0] ||
		(major === MIN_NODE[0] &&
			(minor < MIN_NODE[1] || (minor === MIN_NODE[1] && patch < MIN_NODE[2])));
	return tooOld
		? {
				id: 'node',
				status: 'fail',
				label: `Node ${process.versions.node} is too old`,
				fix: `Install Node ${MIN_NODE.join('.')} or newer`
			}
		: { id: 'node', status: 'ok', label: `Node ${process.versions.node}` };
}

/**
 * Which of the three platforms that need an app registered at the provider
 * (LinkedIn, Threads, X) this deployment could connect. Presence, not
 * validity: a wrong id still counts as set up and is rejected by the provider
 * when someone tries to connect.
 *
 * `ok` either way, on purpose. A deployment without them is complete — Mastodon
 * and Bluesky connect with what the user already has — so the line says what is
 * possible rather than adding a warning to every fresh install.
 *
 * @param {string[]} secretNames
 * @returns {Check}
 */
export function platformVerdict(secretNames) {
	const platforms = {
		LinkedIn: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
		Threads: ['THREADS_APP_ID', 'THREADS_APP_SECRET'],
		X: ['X_CLIENT_ID']
	};
	const missing = Object.entries(platforms)
		.filter(([, needed]) => !needed.every((name) => secretNames.includes(name)))
		.map(([platform]) => platform);
	if (!missing.length) {
		return {
			id: 'platforms',
			status: 'ok',
			label: 'LinkedIn, Threads and X have app credentials',
			detail: 'all five platforms can be connected'
		};
	}
	const ready = Object.keys(platforms).filter((platform) => !missing.includes(platform));
	return {
		id: 'platforms',
		status: 'ok',
		label: `${missing.join(', ')}: no app credentials (optional)`,
		detail: ready.length
			? `${ready.join(', ')} can be connected`
			: 'Mastodon and Bluesky can be connected',
		fix: 'docs/oauth-apps.md — register the app, then `npm run secrets:put`'
	};
}

/**
 * Whether the deployment has an account yet.
 *
 * `npm run setup` creates the account in D1 from the terminal, before the URL
 * answers its first request, so a deployment without one is not a live instance:
 * its login page shows a notice instead of a form, and only a terminal can fix
 * it. A deployment that has an account but no authenticator is simply one whose
 * owner has not signed in yet, which is worth a nudge rather than a failure.
 *
 * The app does not tell anonymous callers whether 2FA is set up, so that comes
 * from the database (`stored`) when doctor is signed in; an older deployment
 * that still reports it is believed. Unknown either way, the account is only
 * reported as created.
 *
 * @param {{ created?: boolean, totpEnrolled?: boolean } | null} account
 * @param {{ ok: boolean, totpEnrolled?: boolean } | null} [stored]
 * @returns {Check}
 */
export function accountVerdict(account, stored = null) {
	if (!account || typeof account.created !== 'boolean') {
		return { id: 'account', status: 'skip', label: 'Account check skipped (no health payload)' };
	}
	if (!account.created) {
		return {
			id: 'account',
			status: 'fail',
			label: 'The deployment has no account yet',
			detail: 'Its login page shows a notice instead of a form.',
			fix: 'Run `npm run setup` from your checkout: it creates the account in D1'
		};
	}
	const totpEnrolled =
		typeof account.totpEnrolled === 'boolean'
			? account.totpEnrolled
			: stored?.ok && typeof stored.totpEnrolled === 'boolean'
				? stored.totpEnrolled
				: undefined;
	if (totpEnrolled === undefined) {
		return { id: 'account', status: 'ok', label: 'Account created' };
	}
	if (!totpEnrolled) {
		return {
			id: 'account',
			status: 'warn',
			label: 'The account exists, but 2FA is not set up yet',
			detail: 'The authenticator is enrolled on the first browser sign-in.',
			fix: 'Open the app and sign in once to set it up'
		};
	}
	return { id: 'account', status: 'ok', label: 'Account created, authenticator enrolled' };
}

/**
 * Probe the running app. Returns the check *and* whatever version it reported,
 * so the update check can compare the deployed code rather than the checkout.
 *
 * @param {string} appUrl
 * @returns {Promise<{ check: Check, version: string | null, account: { created?: boolean, totpEnrolled?: boolean } | null }>}
 */
async function probeApp(appUrl) {
	try {
		const res = await fetch(`${appUrl.replace(/\/$/, '')}/api/health`, {
			signal: AbortSignal.timeout(10_000)
		});
		const raw = await res.text().catch(() => '');
		let version = null;
		let account = null;
		try {
			const parsed = JSON.parse(raw);
			version = typeof parsed?.version === 'string' ? parsed.version : null;
			account = parsed?.account && typeof parsed.account === 'object' ? parsed.account : null;
		} catch {
			// Not JSON: healthVerdict reads the text instead.
		}
		return { check: healthVerdict(res.status, raw), version, account };
	} catch (err) {
		return {
			check: {
				id: 'app',
				status: 'warn',
				label: `Could not reach ${appUrl}`,
				detail: err instanceof Error ? err.message : String(err)
			},
			version: null,
			account: null
		};
	}
}

/**
 * Whether commands can reach Cloudflare at all.
 *
 * Without a profile `whoami` is the answer. With one it is not: `whoami`
 * refuses `--profile` and describes the folder's login, which can be another
 * login entirely. So the account a request made through the profile reached
 * decides, and no email is shown, because none is known for that profile.
 *
 * @param {{ profile?: string | null, whoami?: any, reached?: { accountId: string | null, accountName: string | null, reason?: string } }} input
 * @returns {Check}
 */
export function loginVerdict({ profile, whoami, reached }) {
	if (profile) {
		return reached?.accountId
			? {
					id: 'login',
					status: 'ok',
					label: `Signed in through profile ${profile} → ${reached.accountName ?? reached.accountId}`
				}
			: {
					id: 'login',
					status: 'fail',
					label: `Could not reach Cloudflare through profile ${profile}`,
					detail: reached?.reason,
					fix: `npx wrangler auth create ${profile}`
				};
	}
	if (!whoami?.loggedIn) {
		return {
			id: 'login',
			status: 'fail',
			label: 'Not signed in to Cloudflare',
			fix: 'npx wrangler login (or set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID)'
		};
	}
	return {
		id: 'login',
		status: 'ok',
		label: `Signed in as ${whoami.email ?? '(unknown)'} → ${(whoami.accounts ?? [])
			.map((/** @type {any} */ a) => a.name)
			.join(', ')}`
	};
}

/**
 * Whether the config pins the Cloudflare account.
 *
 * Without `account_id` a command goes wherever the active login points, which
 * for someone with more than one account depends on the shell and the folder.
 * With a single account there is nothing to mix up, so no line at all.
 *
 * @param {{ config: any, configFile: string, profile?: string | null, accountCount?: number, recorded?: string | null }} input
 * @returns {Check | null}
 */
export function accountPinVerdict({ config, configFile, profile, accountCount = 0, recorded }) {
	const id = config?.account_id;
	if (typeof id === 'string' && id) {
		return { id: 'account-pin', status: 'ok', label: `Account pinned in ${configFile}: ${id}` };
	}
	if (!profile && accountCount <= 1) return null;
	return {
		id: 'account-pin',
		status: 'warn',
		label: `No account_id in ${configFile}`,
		detail: profile
			? `a command goes to whichever account its login reaches, so one run without WRANGLER_PROFILE=${profile} goes to another`
			: 'commands use whichever login this shell and folder have',
		fix: `Add "account_id": "${recorded ?? '<your account id>'}" to ${PERSONAL_CONFIG}`
	};
}

/** Binding lists compared by name, and the field that names an entry. */
const BINDING_LISTS = /** @type {const} */ ([
	['d1_databases', 'binding'],
	['r2_buckets', 'binding'],
	['kv_namespaces', 'binding'],
	['ratelimits', 'name'],
	['services', 'binding']
]);

/**
 * What the committed config has that `wrangler.personal.jsonc` lacks.
 *
 * The personal file replaces the committed one wholesale, so whatever a release
 * adds to `wrangler.jsonc` (a binding, a compatibility date, a flag) never
 * reaches an instance until it is copied over by hand. Names and ids are the
 * personal file's own business; only what is missing is reported.
 *
 * @param {any} committed @param {any} personal
 * @returns {string[]} one entry per missing thing, readable as is
 */
export function configDrift(committed, personal) {
	if (!committed || !personal) return [];
	/** @type {string[]} */
	const missing = [];
	/** @type {Set<string>} */
	const listKeys = new Set(BINDING_LISTS.map(([key]) => key));
	for (const key of Object.keys(committed)) {
		if (key === '$schema' || listKeys.has(key)) continue;
		if (!(key in personal)) missing.push(`"${key}"`);
	}
	if (
		typeof committed.compatibility_date === 'string' &&
		typeof personal.compatibility_date === 'string' &&
		personal.compatibility_date < committed.compatibility_date
	) {
		missing.push(
			`compatibility_date ${committed.compatibility_date} (yours: ${personal.compatibility_date})`
		);
	}
	const flags = Array.isArray(personal.compatibility_flags) ? personal.compatibility_flags : [];
	for (const flag of committed.compatibility_flags ?? []) {
		if ('compatibility_flags' in personal && !flags.includes(flag)) {
			missing.push(`compatibility flag ${flag}`);
		}
	}
	for (const [key, field] of BINDING_LISTS) {
		const theirs = Array.isArray(committed[key]) ? committed[key] : [];
		const ours = Array.isArray(personal[key]) ? personal[key] : [];
		for (const entry of theirs) {
			const name = entry?.[field];
			if (name && !ours.some((/** @type {any} */ e) => e?.[field] === name)) {
				missing.push(`the ${name} binding (${key})`);
			}
		}
	}
	return missing;
}

/**
 * The drift above as a check line, or null without a personal config.
 *
 * @param {any} committed @param {any} personal
 * @returns {Check | null}
 */
export function configDriftVerdict(committed, personal) {
	if (!personal) return null;
	const missing = configDrift(committed, personal);
	if (!missing.length) {
		return {
			id: 'config-drift',
			status: 'ok',
			label: `${PERSONAL_CONFIG} has everything ${COMMITTED_CONFIG} adds`
		};
	}
	return {
		id: 'config-drift',
		status: 'warn',
		label: `${PERSONAL_CONFIG} is missing what ${COMMITTED_CONFIG} now has`,
		detail: missing.join('; '),
		fix: `Copy those from ${COMMITTED_CONFIG} into ${PERSONAL_CONFIG}, keeping your own names and ids, then deploy`
	};
}

/**
 * The account commands reach, against the one this checkout deployed to.
 *
 * @param {import('./lib/target-account.mjs').TargetCheck} check
 * @returns {Check}
 */
export function targetVerdict(check) {
	const reached = explainTarget({ ...check, profile: null }).headline.replace(/^target: /, '');
	if (check.verdict === 'unknown') {
		return {
			id: 'target',
			status: 'warn',
			label: 'Could not tell which Cloudflare account commands reach',
			detail: check.current.reason
		};
	}
	if (check.verdict === 'match') {
		return { id: 'target', status: 'ok', label: `Commands reach ${reached}, where it is deployed` };
	}
	if (check.verdict === 'new') {
		return {
			id: 'target',
			status: 'ok',
			label: `Commands reach ${reached}`,
			detail: 'no deploy recorded from this checkout yet'
		};
	}
	return {
		id: 'target',
		status: 'fail',
		label: `Commands reach account ${check.current.accountId}, but ${check.worker} was deployed to ${check.recorded}`,
		detail: 'deploys, secrets and migrations from here refuse to run',
		fix: `Use a login that reaches ${check.recorded}: set WRANGLER_PROFILE, or bind this folder once with npx wrangler auth activate <profile>`
	};
}

/**
 * A new account has no workers.dev subdomain, and a deploy to workers.dev
 * fails until one is picked. Irrelevant once the config turns workers.dev off.
 *
 * @param {{ workersDev: unknown, accountId: string | null, result: Awaited<ReturnType<typeof readSubdomain>> | null }} input
 * @returns {Check | null}
 */
export function subdomainVerdict({ workersDev, accountId, result }) {
	if (workersDev === false || !accountId || !result) return null;
	if (result.status === 'set') {
		return {
			id: 'subdomain',
			status: 'ok',
			label: `workers.dev subdomain ${result.subdomain}.workers.dev`
		};
	}
	if (result.status === 'missing') {
		return {
			id: 'subdomain',
			status: 'fail',
			label: 'This account has no workers.dev subdomain, so a deploy to workers.dev fails',
			fix: `Pick one at ${onboardingUrl(accountId)}, or let npm run setup ask for it`
		};
	}
	return {
		id: 'subdomain',
		status: 'warn',
		label: 'Could not read the workers.dev subdomain',
		detail: result.reason
	};
}

async function main() {
	const argv = process.argv.slice(2);
	/** @param {string} name @returns {string | undefined} */
	const flag = (name) => {
		const i = argv.indexOf(name);
		return i >= 0 ? argv[i + 1] : undefined;
	};

	const configFile = existsSync(PERSONAL_CONFIG) ? PERSONAL_CONFIG : COMMITTED_CONFIG;
	const devVars = existsSync(resolve(root, DEV_VARS)) ? readDevVars(resolve(root, DEV_VARS)) : null;
	const checks = [checkNode()];

	let config = null;
	try {
		config = readJsonc(resolve(root, configFile));
	} catch (err) {
		checks.push({
			id: 'config',
			status: 'fail',
			label: `Could not read ${configFile}`,
			detail: err instanceof Error ? err.message : String(err)
		});
	}
	if (config) checks.push(...evaluateConfig(config, { configFile, devVars }));
	if (config && configFile === PERSONAL_CONFIG) {
		try {
			const drift = configDriftVerdict(readJsonc(resolve(root, COMMITTED_CONFIG)), config);
			if (drift) checks.push(drift);
		} catch {
			// No readable committed config to compare with: nothing to say.
		}
	}

	// Before the login line: with WRANGLER_PROFILE set, the account a request
	// made through the profile reached is what says whether it is signed in.
	const target = checkTarget({ env: { ...process.env, COGSEND_ALLOW_ACCOUNT_CHANGE: '' } });
	/** @type {any} */
	let account = null;
	if (!target.profile) {
		const who = wrangler(['whoami', '--json'], { timeout: 60_000 });
		try {
			account = JSON.parse(who.stdout);
		} catch {
			// Not JSON: the command failed, so this reads as signed out.
		}
	}
	const login = loginVerdict({ profile: target.profile, whoami: account, reached: target.current });
	checks.push(login);
	const signedIn = login.status === 'ok';
	// Signed out, "could not tell which account" only repeats the line above.
	if (signedIn || target.verdict !== 'unknown') checks.push(targetVerdict(target));
	const pin = accountPinVerdict({
		config,
		configFile,
		profile: target.profile,
		accountCount: account?.accounts?.length ?? 0,
		recorded: target.recorded
	});
	if (pin) checks.push(pin);

	const d1Name = config?.d1_databases?.[0]?.database_name;
	const d1Id = config?.d1_databases?.[0]?.database_id;
	const binding = config?.d1_databases?.[0]?.binding ?? 'DB';
	const bucket = config?.r2_buckets?.[0]?.bucket_name;

	/** The account row as D1 holds it, when doctor could read it. */
	let storedAccount = null;
	if (signedIn) {
		const listed = wrangler(['d1', 'list', '--json'], { timeout: 60_000 });
		const databases = parseD1List(listed.stdout);
		const found = databases.find((db) => (d1Id ? db.uuid === d1Id : db.name === d1Name));
		checks.push(
			found
				? { id: 'd1', status: 'ok', label: `D1 database ${found.name} exists` }
				: d1Id
					? {
							id: 'd1',
							status: 'fail',
							label: `D1 id ${d1Id} is not in this account`,
							fix: 'Check the account/profile, or put the right database_id in the config'
						}
					: {
							id: 'd1',
							status: 'warn',
							label: `D1 database ${d1Name ?? '(unnamed)'} does not exist yet`,
							detail: 'Wrangler creates it on the next deploy',
							fix: 'npm run deploy'
						}
		);

		// Whether 2FA is set up, which the app only tells a signed-in owner. Read
		// only from the database this checkout deploys to, and only once the
		// account check above said the commands reach it.
		if (found && (target.verdict === 'match' || target.verdict === 'new')) {
			const env = { ...process.env, [CHECKED_ENV]: target.current.accountId ?? '' };
			storedAccount = await readAccount({
				wrangler: async (args) => wrangler(args, { timeout: 60_000, env })
			});
		}

		const buckets = wrangler(['r2', 'bucket', 'list'], { timeout: 60_000 });
		if (buckets.status !== 0) {
			checks.push({
				id: 'r2',
				status: 'warn',
				label: 'Could not list R2 buckets',
				detail: (buckets.stderr || buckets.stdout).trim().split('\n')[0] || undefined,
				fix: 'R2 may not be enabled on this account (it needs a payment method on file)'
			});
		} else if (!bucket) {
			checks.push({
				id: 'r2',
				status: 'skip',
				label: 'R2 bucket check skipped (no bucket_name in the config)'
			});
		} else {
			checks.push(
				bucketWasListed(buckets.stdout, bucket)
					? { id: 'r2', status: 'ok', label: `R2 bucket ${bucket} exists` }
					: {
							id: 'r2',
							status: 'warn',
							label: `R2 bucket ${bucket} does not exist yet`,
							detail: 'Wrangler creates it on the next deploy',
							fix: 'npm run deploy (names are global, so change it if the deploy reports a conflict)'
						}
			);
		}

		const accountId = target.current.accountId;
		const headers = config?.workers_dev !== false && accountId ? apiHeaders() : null;
		const subdomain = subdomainVerdict({
			workersDev: config?.workers_dev,
			accountId,
			result: accountId && headers ? await readSubdomain({ accountId, headers }) : null
		});
		if (subdomain) checks.push(subdomain);

		const secrets = readWorkerSecrets({
			run: (args) => wrangler(args, { timeout: 60_000 })
		});
		const names = secrets.ok ? secrets.names : null;
		if (!names) {
			checks.push({
				id: 'secrets',
				status: 'warn',
				label: 'Could not read the Worker secret list',
				detail: secrets.reason ?? 'wrangler did not print a usable list',
				fix: 'node scripts/wrangler.mjs secret list'
			});
		} else if (secrets.missingWorker) {
			checks.push({
				id: 'secrets',
				status: 'warn',
				label: 'Worker is not deployed yet, so it has no secrets',
				detail: 'wrangler creates the Worker and its secrets on the first deploy',
				fix: 'npm run deploy'
			});
		} else {
			checks.push(
				names.includes('APP_ENCRYPTION_KEY')
					? { id: 'secrets', status: 'ok', label: 'Worker secret APP_ENCRYPTION_KEY is set' }
					: {
							id: 'secrets',
							status: 'fail',
							label: 'Worker secret APP_ENCRYPTION_KEY is missing',
							fix: 'npm run secrets:put (or npm run setup)'
						}
			);
			checks.push(platformVerdict(names));
			if (!names.includes('SCHEDULER_SECRET') && !names.includes('API_TOKEN')) {
				checks.push({
					id: 'tick-credential',
					status: 'warn',
					label: 'No SCHEDULER_SECRET or API_TOKEN',
					detail: 'the built-in cron still works; an external pinger cannot authenticate',
					fix: 'Set SCHEDULER_SECRET if you run your own cron'
				});
			}
		}

		const migrations = wrangler(['d1', 'migrations', 'list', binding, '--remote'], {
			timeout: 120_000
		});
		const pending = countUnappliedMigrations(`${migrations.stdout}${migrations.stderr}`);
		if (pending === null) {
			// The first line of a failed wrangler run is its banner, which says
			// nothing: quote the first line that looks like a reason instead.
			const lines = `${migrations.stdout}${migrations.stderr}`
				// eslint-disable-next-line no-control-regex -- terminal colours
				.replace(/\u001b\[[0-9;]*m/g, '')
				.split('\n')
				.map((line) => line.trim())
				.filter(Boolean)
				// Drop the banner (version, "update available", rule lines, the
				// log-file footer) so the detail is a reason, not decoration.
				.filter((line) => /[a-z0-9]/i.test(line))
				.filter((line) => !/wrangler \d|update available|logs were written/i.test(line));
			const reason =
				lines.find((line) => /\berror\b|failed|couldn't|no such|not found/i.test(line)) ??
				lines.at(-1) ??
				'';
			checks.push({
				id: 'migrations',
				status: 'warn',
				label: 'Could not read the migration list',
				detail: reason.slice(0, 200) || undefined
			});
		} else {
			checks.push(
				pending === 0
					? { id: 'migrations', status: 'ok', label: 'D1 migrations are up to date' }
					: {
							id: 'migrations',
							status: 'warn',
							label: `${pending} migration${pending === 1 ? '' : 's'} not applied`,
							fix: 'npm run db:migrate:remote'
						}
			);
		}

		const deployed = wrangler(['deployments', 'status'], { timeout: 60_000 });
		checks.push(
			deployed.status === 0
				? { id: 'worker', status: 'ok', label: 'Worker has a deployment' }
				: {
						id: 'worker',
						status: 'fail',
						label: 'Worker is not deployed yet',
						fix: 'npm run deploy'
					}
		);
	} else {
		const skipped = {
			d1: 'D1 database',
			r2: 'R2 bucket',
			secrets: 'Worker secrets',
			migrations: 'D1 migrations',
			worker: 'Worker deployment'
		};
		for (const [id, name] of Object.entries(skipped)) {
			checks.push({ id, status: 'skip', label: `${name} check skipped (not signed in)` });
		}
	}

	const appUrl = flag('--app-url') ?? devVars?.get('APP_URL') ?? config?.vars?.APP_URL ?? undefined;
	/** The version the deployment reports, when we could reach it. */
	let deployedVersion = null;
	if (appUrl && !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(appUrl)) {
		const probed = await probeApp(appUrl);
		checks.push(probed.check);
		checks.push(accountVerdict(probed.account, storedAccount));
		deployedVersion = probed.version;
		const token = devVars?.get('API_TOKEN');
		if (token) {
			try {
				const res = await fetch(`${appUrl.replace(/\/$/, '')}/api/scheduler/health`, {
					headers: { Authorization: `Bearer ${token}` },
					signal: AbortSignal.timeout(10_000)
				});
				const body = await res.json().catch(() => ({}));
				checks.push(schedulerVerdict(res.status, body));
			} catch {
				checks.push({ id: 'scheduler', status: 'skip', label: 'Scheduler check skipped' });
			}
		} else {
			checks.push({
				id: 'scheduler',
				status: 'skip',
				label: 'Scheduler check skipped (no local API_TOKEN)'
			});
		}
	} else {
		checks.push({
			id: 'app',
			status: 'skip',
			label: appUrl ? `Deployment probe skipped (${appUrl} is local)` : 'Deployment probe skipped',
			detail: 'pass --app-url https://your-worker.example to check the running app'
		});
	}

	// Update check last: it is the one piece that needs GitHub, and a failure
	// here must never look like a broken deployment.
	const localVersion = (() => {
		try {
			return JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version ?? null;
		} catch {
			return null;
		}
	})();
	const currentVersion = deployedVersion ?? localVersion;
	const remotes = run('git', ['remote', '-v'], { timeout: 15_000 });
	const shape = installShape(`${remotes.stdout}${remotes.stderr}`);
	try {
		const headers = { accept: 'application/vnd.github+json', 'user-agent': 'cogsend' };
		const res = await fetch('https://api.github.com/repos/cogsend/cogsend/releases/latest', {
			headers,
			signal: AbortSignal.timeout(10_000)
		});
		const body = await res.json().catch(() => null);
		let latest = res.ok ? latestReleaseTag(body) : null;
		let error = res.ok
			? 'GitHub returned an unexpected document'
			: `GitHub answered HTTP ${res.status}`;
		if (!latest && res.status === 404) {
			// Tagged, but no published release object: compare against the tags.
			const tags = await fetch('https://api.github.com/repos/cogsend/cogsend/tags?per_page=100', {
				headers,
				signal: AbortSignal.timeout(10_000)
			});
			const tagBody = await tags.json().catch(() => null);
			latest = tags.ok ? highestVersionTag(tagBody) : null;
			error = latest ? 'no published release' : 'no version tags published yet';
		}
		checks.push(releaseVerdict({ current: currentVersion, latest, error, shape }));
	} catch (err) {
		checks.push(
			releaseVerdict({
				current: currentVersion,
				latest: null,
				error: err instanceof Error ? err.message : String(err),
				shape
			})
		);
	}

	console.log(formatReport(checks));
	process.exit(summarize(checks).failed > 0 ? 1 : 0);
}

// Only run when invoked directly: the helpers above are imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((err) => {
		console.error(`doctor failed: ${err?.message ?? err}`);
		process.exit(1);
	});
}

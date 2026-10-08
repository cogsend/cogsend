import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	accountPinVerdict,
	loginVerdict,
	bucketWasListed,
	countUnappliedMigrations,
	evaluateConfig,
	formatReport,
	healthVerdict,
	parseD1List,
	platformVerdict,
	highestVersionTag,
	accountVerdict,
	installShape,
	isNewerVersion,
	latestReleaseTag,
	releaseVerdict,
	schedulerVerdict,
	summarize,
	updateHint
} from '../scripts/doctor.mjs';
import { readDevVars } from '../scripts/lib/dev-vars.mjs';

/**
 * `npm run doctor` is the first thing a stuck self-hoster runs, so its
 * judgements are pinned here: the checks are pure functions over command
 * output, and the CLI only prints them.
 */
const goodConfig = {
	name: 'cogsend',
	d1_databases: [{ binding: 'DB', database_name: 'cogsend', database_id: '' }],
	r2_buckets: [{ binding: 'MEDIA', bucket_name: 'cogsend-media' }],
	triggers: { crons: ['* * * * *'] }
};

const ids = (checks: { id: string }[]) => checks.map((c) => c.id);

/**
 * The three platforms that need an app registered at the provider are optional:
 * a deployment without them still connects Mastodon and Bluesky. So the line
 * says what is possible, and must never look like a warning — a fresh install
 * runs doctor on a clean checkout, where a yellow line would read as a defect.
 */
describe('platform credentials', () => {
	it('marks a deployment without them as complete, not as a problem', () => {
		const check = platformVerdict(['APP_ENCRYPTION_KEY']);
		expect(check.status).toBe('ok');
		expect(check.label).toBe('LinkedIn, Threads, X: no app credentials (optional)');
		expect(check.detail).toBe('Mastodon and Bluesky can be connected');
		expect(check.fix).toMatch(/oauth-apps\.md/);
	});

	it('names only what is missing, and what is not', () => {
		const check = platformVerdict(['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET', 'X_CLIENT_ID']);
		expect(check.label).toBe('Threads: no app credentials (optional)');
		expect(check.detail).toBe('LinkedIn, X can be connected');
	});

	it('needs both halves of a client id and secret pair', () => {
		// Half a pair cannot connect anything, which is what the accounts dialog
		// says too: it is the same presence check.
		expect(platformVerdict(['LINKEDIN_CLIENT_ID']).label).toContain('LinkedIn');
	});

	it('reports all five platforms once the credentials are there', () => {
		const check = platformVerdict([
			'LINKEDIN_CLIENT_ID',
			'LINKEDIN_CLIENT_SECRET',
			'THREADS_APP_ID',
			'THREADS_APP_SECRET',
			'X_CLIENT_ID'
		]);
		expect(check.status).toBe('ok');
		expect(check.label).toBe('LinkedIn, Threads and X have app credentials');
		expect(check.detail).toBe('all five platforms can be connected');
	});
});

describe('config checks', () => {
	it('passes a config that has everything the app needs', () => {
		const checks = evaluateConfig(goodConfig, { configFile: 'wrangler.jsonc' });
		expect(summarize(checks)).toEqual({ failed: 0, warnings: 0, ok: 4, skipped: 0 });
		expect(checks.find((c) => c.id === 'd1-binding')?.detail).toMatch(/creates or adopts/);
	});

	it('fails without a Worker name, and flags a missing binding', () => {
		const checks = evaluateConfig({ d1_databases: [], r2_buckets: [] });
		expect(checks.find((c) => c.id === 'config')?.status).toBe('fail');
		expect(checks.find((c) => c.id === 'd1-binding')?.status).toBe('fail');
		expect(checks.find((c) => c.id === 'r2-binding')?.status).toBe('warn');
	});

	it('warns when nothing would run the schedule', () => {
		const checks = evaluateConfig({ ...goodConfig, triggers: { crons: [] } });
		const cron = checks.find((c) => c.id === 'cron');
		expect(cron?.status).toBe('warn');
		expect(cron?.fix).toMatch(/triggers/);
	});

	it('fails when the local .dev.vars still carries the example key', () => {
		const devVars = new Map([
			['APP_ENCRYPTION_KEY', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef']
		]);
		const local = evaluateConfig(goodConfig, { devVars }).find((c) => c.id === 'local-key');
		expect(local?.status).toBe('warn');
		expect(local?.detail).toMatch(/localhost works/);

		const real = new Map([['APP_ENCRYPTION_KEY', 'a'.repeat(64)]]);
		expect(
			evaluateConfig(goodConfig, { devVars: real }).find((c) => c.id === 'local-key')?.status
		).toBe('ok');
		expect(
			evaluateConfig(goodConfig, { devVars: new Map() }).find((c) => c.id === 'local-key')?.status
		).toBe('warn');
	});
});

describe('command output parsing', () => {
	it('reads the D1 list and returns [] for junk', () => {
		expect(parseD1List(JSON.stringify([{ name: 'cogsend', uuid: 'abc' }]))).toHaveLength(1);
		expect(parseD1List('boom')).toEqual([]);
	});

	it('finds a bucket name in the table output without matching substrings', () => {
		const table = 'name           creation_date\ncogsend-media  2026-01-01\n';
		expect(bucketWasListed(table, 'cogsend-media')).toBe(true);
		expect(bucketWasListed(table, 'cogsend')).toBe(false);
		expect(bucketWasListed('', 'cogsend-media')).toBe(false);
	});

	it('counts unapplied migrations', () => {
		expect(countUnappliedMigrations('✅ No migrations to apply!')).toBe(0);
		expect(
			countUnappliedMigrations('Migrations to be applied:\n0001_init.sql\n0002_totp.sql\n')
		).toBe(2);
		// The same file listed twice (table + summary) is one migration.
		expect(
			countUnappliedMigrations('Migrations to be applied:\n0001_init.sql\n0001_init.sql')
		).toBe(1);
		expect(countUnappliedMigrations('something else entirely')).toBeNull();
	});
});

describe('health verdict', () => {
	it('treats a 200 as healthy', () => {
		expect(healthVerdict(200, '{"ok":true}')).toMatchObject({ status: 'ok' });
	});

	it('recognises our own not-configured guard and offers the fix', () => {
		const verdict = healthVerdict(
			503,
			'This deployment is not configured: Invalid environment: APP_ENCRYPTION_KEY must not be an example value. Set real Worker secrets...'
		);
		expect(verdict.status).toBe('fail');
		expect(verdict.fix).toMatch(/secrets:put/);
	});

	it('warns on anything else without pretending to know why', () => {
		expect(healthVerdict(502, '<html>gateway</html>')).toMatchObject({ status: 'warn' });
	});
});

describe('scheduler verdict', () => {
	const health = (over: Record<string, unknown> = {}) => ({
		ok: true,
		lastTickAt: '2026-09-17T06:40:00.000Z',
		neverTicked: false,
		message: 'Scheduled publishing is on time',
		deployCron: { status: 'attached', code: null, updatedAt: '2026-09-17T06:30:00.000Z' },
		...over
	});

	it('passes when ticks arrive', () => {
		const check = schedulerVerdict(200, health());
		expect(check.status).toBe('ok');
		expect(check.detail).toContain('2026-09-17');
	});

	it('fails when the deploy could not attach the trigger', () => {
		// The one case worth a non-zero exit: scheduled posts silently wait.
		const check = schedulerVerdict(
			200,
			health({
				ok: false,
				lastTickAt: null,
				neverTicked: true,
				deployCron: { status: 'unavailable', code: '10072', updatedAt: null }
			})
		);
		expect(check.status).toBe('fail');
		expect(check.label).toContain('10072');
		expect(check.fix).toContain('Settings');
	});

	it('warns when no trigger is configured, or nothing has ticked yet', () => {
		expect(
			schedulerVerdict(
				200,
				health({
					ok: false,
					lastTickAt: null,
					neverTicked: true,
					deployCron: { status: 'disabled', code: null, updatedAt: null }
				})
			).status
		).toBe('warn');
		expect(
			schedulerVerdict(
				200,
				health({ ok: false, lastTickAt: null, neverTicked: true, deployCron: null })
			).label
		).toContain('No tick');
	});

	it('warns when the scheduler went quiet after ticking', () => {
		const check = schedulerVerdict(200, health({ ok: false }));
		expect(check.status).toBe('warn');
		expect(check.detail).toContain('2026-09-17');
	});

	it('explains a rejected probe instead of guessing', () => {
		expect(schedulerVerdict(401, {}).fix).toContain('API_TOKEN');
		expect(schedulerVerdict(500, {}).status).toBe('skip');
	});
});

describe('update check', () => {
	const cloneRemotes =
		'origin\thttps://github.com/deepakness/cogsend.git (fetch)\norigin\thttps://github.com/deepakness/cogsend.git (push)';
	const forkRemotes =
		'origin\thttps://github.com/me/cogsend.git (fetch)\nupstream\thttps://github.com/deepakness/cogsend.git (fetch)';
	const copyRemotes = 'origin\thttps://github.com/me/cogsend-demo.git (fetch)';

	it('reads the install shape from the remotes', () => {
		expect(installShape(cloneRemotes)).toBe('clone');
		expect(installShape(forkRemotes)).toBe('fork');
		expect(installShape(copyRemotes)).toBe('copy');
		expect(installShape('')).toBe('unknown');
		expect(installShape('origin\thttps://gitlab.com/me/x.git (fetch)')).toBe('copy');
		// ssh clones are just as common as https ones.
		expect(installShape('origin\tgit@github.com:deepakness/cogsend.git (fetch)')).toBe('clone');
		expect(
			installShape(
				'origin\tgit@github.com:me/cogsend.git (fetch)\nupstream\tgit@github.com:deepakness/cogsend.git (fetch)'
			)
		).toBe('fork');
		expect(installShape('origin\tssh://git@github.com/deepakness/cogsend.git (fetch)')).toBe(
			'clone'
		);
		// The new home, and an owner that only ends in "cogsend".
		expect(installShape('origin\thttps://github.com/cogsend/cogsend.git (fetch)')).toBe('clone');
		expect(
			installShape(
				'origin\tgit@github.com:me/cogsend.git (fetch)\nupstream\tgit@github.com:cogsend/cogsend.git (fetch)'
			)
		).toBe('fork');
		expect(installShape('origin\thttps://github.com/notcogsend/cogsend.git (fetch)')).toBe('copy');
	});

	it('gives each shape its own update command', () => {
		expect(updateHint('clone')).toContain('git pull');
		expect(updateHint('fork')).toContain('Sync fork');
		expect(updateHint('copy')).toContain('git remote add upstream');
		expect(updateHint('unknown')).toContain('docs/deploy.md');
	});

	it('tells "ready" apart from "nobody ran setup"', () => {
		expect(accountVerdict({ created: true, totpEnrolled: true })).toMatchObject({
			id: 'account',
			status: 'ok'
		});
		// An account without an authenticator is a nudge, not a failure: it is the
		// state between running setup and the first sign-in.
		expect(accountVerdict({ created: true, totpEnrolled: false }).status).toBe('warn');
		const missing = accountVerdict({ created: false, totpEnrolled: false });
		expect(missing.status).toBe('fail');
		expect(missing.fix).toContain('npm run setup');
		// An older deployment that reports no account field at all.
		expect(accountVerdict(null).status).toBe('skip');
		expect(accountVerdict({}).status).toBe('skip');
	});

	it('takes 2FA status from the database once the app no longer reports it', () => {
		// Signed out: nothing says whether 2FA is set up, so none is claimed.
		expect(accountVerdict({ created: true })).toEqual({
			id: 'account',
			status: 'ok',
			label: 'Account created'
		});
		expect(accountVerdict({ created: true }, { ok: true, totpEnrolled: false }).status).toBe(
			'warn'
		);
		expect(accountVerdict({ created: true }, { ok: true, totpEnrolled: true }).label).toBe(
			'Account created, authenticator enrolled'
		);
		// A failed read decides nothing.
		expect(accountVerdict({ created: true }, { ok: false }).label).toBe('Account created');
		// A deployment that still reports it is believed over the database.
		expect(
			accountVerdict({ created: true, totpEnrolled: true }, { ok: true, totpEnrolled: false })
				.status
		).toBe('ok');
	});

	it('warns only when a newer release exists', () => {
		const outdated = releaseVerdict({ current: '1.0.0', latest: '1.2.0', shape: 'clone' });
		expect(outdated.status).toBe('warn');
		expect(outdated.label).toContain('1.2.0');
		expect(outdated.fix).toContain('npm run deploy:release');

		expect(releaseVerdict({ current: '1.2.0', latest: '1.2.0' }).status).toBe('ok');
		expect(releaseVerdict({ current: '1.3.0', latest: '1.2.0' }).label).toContain('newer');
		expect(releaseVerdict({ current: '1.0.0', latest: null, error: 'HTTP 503' }).status).toBe(
			'skip'
		);
		expect(releaseVerdict({ latest: '1.2.0' }).status).toBe('skip');
	});

	it('compares versions numerically', () => {
		expect(isNewerVersion('1.10.0', '1.9.0')).toBe(true);
		expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false);
		expect(isNewerVersion('nightly', '1.0.0')).toBe(false);
	});

	it('reads the newest tag, and the release tag', () => {
		expect(latestReleaseTag({ tag_name: 'v2.0.0' })).toBe('2.0.0');
		expect(latestReleaseTag({})).toBe(null);
		expect(highestVersionTag([{ name: 'v1.0.0' }, { name: 'v1.11.0' }])).toBe('1.11.0');
		expect(highestVersionTag([{ name: 'main' }])).toBe(null);
		expect(highestVersionTag(null)).toBe(null);
	});
});

describe('report', () => {
	it('prints every check with its fix, then the summary', () => {
		const report = formatReport([
			{ id: 'a', status: 'ok', label: 'fine' },
			{ id: 'b', status: 'warn', label: 'meh', detail: 'why', fix: 'do this' },
			{ id: 'c', status: 'fail', label: 'broken', fix: 'do that' }
		]);
		expect(report).toContain('✓ fine');
		expect(report).toContain('    fix: do this');
		expect(report).toContain('✗ broken');
		expect(report).toContain('1 ok · 1 warning · 1 failure');
		expect(report).toContain('Nothing was changed.');
	});

	it('pluralises the summary correctly', () => {
		expect(formatReport([{ id: 'a', status: 'ok', label: 'x' }])).toContain(
			'1 ok · 0 warnings · 0 failures'
		);
	});
});

describe('dev vars parsing', () => {
	it('reads values from the committed fixture', () => {
		const values = readDevVars('tests/e2e/fixtures/dev.vars');
		expect(values.get('APP_NAME')).toBe('CogSend');
		expect(values.get('APP_ENCRYPTION_KEY')).toMatch(/^deadbeef/);
		expect(values.get('SKIP_TOTP')).toBe('1');
	});

	it('strips quotes and trailing comments, and keeps a blank value empty', () => {
		const file = join(tmpdir(), `cogsend-doctor-${process.pid}.vars`);
		writeFileSync(
			file,
			[
				'# a comment',
				'QUOTED="a value" # trailing',
				"SINGLE='another'",
				'BLANK=',
				'SPACED=   padded   '
			].join('\n')
		);
		try {
			const values = readDevVars(file);
			expect(values.get('QUOTED')).toBe('a value');
			expect(values.get('SINGLE')).toBe('another');
			// An empty value is kept as an empty string: the checks treat it as
			// "not set" by falsiness, and dropping the key would lose the
			// distinction between "absent" and "present but empty".
			expect(values.get('BLANK')).toBe('');
			expect(values.get('SPACED')).toBe('padded');
		} finally {
			rmSync(file, { force: true });
		}
	});

	it('returns an empty map for a file that does not exist', () => {
		expect([...readDevVars('tests/e2e/fixtures/nope.vars').keys()]).toEqual([]);
	});
});

describe('check ids stay stable', () => {
	it('produces the documented set for a healthy config', () => {
		expect(ids(evaluateConfig(goodConfig, { configFile: 'x.jsonc' }))).toEqual([
			'config',
			'd1-binding',
			'r2-binding',
			'cron'
		]);
	});
});

describe('account pinning', () => {
	const recorded = '0123456789abcdef0123456789abcdef';

	it('says nothing for a single account with no profile', () => {
		expect(
			accountPinVerdict({ config: {}, configFile: 'wrangler.jsonc', accountCount: 1 })
		).toBeNull();
	});

	it('warns when a profile picks the account, and suggests the deployed id', () => {
		const check = accountPinVerdict({
			config: {},
			configFile: 'wrangler.personal.jsonc',
			profile: 'personal',
			recorded
		});
		expect(check?.status).toBe('warn');
		expect(check?.detail).toContain('WRANGLER_PROFILE=personal');
		expect(check?.fix).toBe(`Add "account_id": "${recorded}" to wrangler.personal.jsonc`);
	});

	it('warns when the login has several accounts', () => {
		const check = accountPinVerdict({ config: {}, configFile: 'wrangler.jsonc', accountCount: 2 });
		expect(check?.status).toBe('warn');
		expect(check?.fix).toContain('<your account id>');
	});

	it('is satisfied by an account_id', () => {
		const check = accountPinVerdict({
			config: { account_id: recorded },
			configFile: 'wrangler.personal.jsonc',
			profile: 'personal'
		});
		expect(check?.status).toBe('ok');
	});
});

describe('login verdict', () => {
	const reached = { accountId: '0123456789abcdef0123456789abcdef', accountName: 'Home' };

	it('trusts whoami without a profile', () => {
		expect(
			loginVerdict({
				whoami: { loggedIn: true, email: 'me@example.com', accounts: [{ name: 'Home' }] }
			})
		).toMatchObject({ status: 'ok', label: 'Signed in as me@example.com → Home' });
		expect(loginVerdict({ whoami: { loggedIn: false } }).status).toBe('fail');
	});

	it('ignores whoami under a profile, which describes another login', () => {
		const check = loginVerdict({
			profile: 'personal',
			whoami: { loggedIn: false },
			reached
		});
		expect(check).toMatchObject({
			status: 'ok',
			label: 'Signed in through profile personal → Home'
		});
	});

	it('fails with the profile to sign in when the profile reaches nothing', () => {
		const check = loginVerdict({
			profile: 'personal',
			whoami: { loggedIn: true, email: 'other@example.com' },
			reached: { accountId: null, accountName: null, reason: 'Not logged in.' }
		});
		expect(check).toMatchObject({
			status: 'fail',
			detail: 'Not logged in.',
			fix: 'npx wrangler auth create personal'
		});
	});
});

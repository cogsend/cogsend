import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The rest of tests/doctor.test.ts pins doctor's judgements as pure functions;
 * this runs the script itself.
 *
 * It exists because of what that cannot see: the platform line is one
 * `checks.push(...)` in the CLI, so dropping it (in a refactor, say) left every
 * unit test green while `npm run doctor` silently stopped mentioning the three
 * platforms that need an app registered at the provider. The scratch checkout
 * replaces `scripts/wrangler.mjs` with canned answers, which is the only thing
 * the CLI talks to.
 */
const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function scratchCheckout(
	secretNames: string[],
	{
		account = null,
		deployedTo = null
	}: { account?: string | null; deployedTo?: string | null } = {}
) {
	const dir = mkdtempSync(join(tmpdir(), 'cogsend-doctor-'));
	dirs.push(dir);
	cpSync('scripts', join(dir, 'scripts'), { recursive: true });
	writeFileSync(
		join(dir, 'wrangler.jsonc'),
		JSON.stringify({
			name: 'cogsend',
			d1_databases: [{ binding: 'DB', database_name: 'cogsend', database_id: 'db-1' }],
			r2_buckets: [{ binding: 'MEDIA', bucket_name: 'cogsend-media' }],
			triggers: { crons: ['* * * * *'] }
		})
	);
	writeFileSync(
		join(dir, 'scripts', 'wrangler.mjs'),
		`const args = process.argv.slice(2);
if (process.env.WRANGLER_LOG === 'debug') {
	const account = ${JSON.stringify(account)};
	if (account) process.stderr.write('GET https://api.cloudflare.com/client/v4/accounts/' + account + '/workers/scripts/cogsend/secrets\\n');
	process.exit(1);
}
const out = (value) => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
if (args[0] === 'whoami') out({ loggedIn: true, email: 'op@example.com', accounts: [{ name: 'Acct' }] });
else if (args[0] === 'd1' && args[1] === 'list') out([{ uuid: 'db-1', name: 'cogsend' }]);
else if (args[0] === 'r2') out('cogsend-media');
else if (args[0] === 'secret') out(${JSON.stringify(secretNames.map((name) => ({ name })))});
else if (args[0] === 'd1' && args[1] === 'migrations') out('✅ No migrations to apply!');
else if (args[0] === 'deployments') out('Deployed\\n  Created: 1 minute ago');
else out('');
`
	);
	if (deployedTo) {
		mkdirSync(join(dir, '.wrangler'));
		writeFileSync(
			join(dir, '.wrangler', 'deployed-accounts.json'),
			JSON.stringify({ cogsend: { accountId: deployedTo } })
		);
	}
	return dir;
}

function runDoctor(dir: string, env: Record<string, string> = {}) {
	const result = spawnSync(process.execPath, ['scripts/doctor.mjs'], {
		cwd: dir,
		encoding: 'utf8',
		env: { ...process.env, NO_COLOR: '1', ...env }
	});
	return `${result.stdout}${result.stderr}`;
}

describe('doctor CLI', () => {
	it('reports the optional platforms, and that nothing is broken without them', () => {
		const output = runDoctor(scratchCheckout(['APP_ENCRYPTION_KEY', 'SCHEDULER_SECRET']));
		expect(output).toContain('LinkedIn, Threads, Instagram, X: no app credentials (optional)');
		expect(output).toContain('Mastodon and Bluesky can be connected');
		// Exit 0: a deployment without app credentials is complete.
		expect(output).not.toMatch(/✗/);
	});

	it('reports the platforms that do have credentials', () => {
		const output = runDoctor(
			scratchCheckout([
				'APP_ENCRYPTION_KEY',
				'SCHEDULER_SECRET',
				'LINKEDIN_CLIENT_ID',
				'LINKEDIN_CLIENT_SECRET'
			])
		);
		expect(output).toContain('Threads, Instagram, X: no app credentials (optional)');
		expect(output).toContain('LinkedIn can be connected');
	});

	it('reports all six platforms once every credential is set', () => {
		const output = runDoctor(
			scratchCheckout([
				'APP_ENCRYPTION_KEY',
				'SCHEDULER_SECRET',
				'LINKEDIN_CLIENT_ID',
				'LINKEDIN_CLIENT_SECRET',
				'THREADS_APP_ID',
				'THREADS_APP_SECRET',
				'INSTAGRAM_APP_ID',
				'INSTAGRAM_APP_SECRET',
				'X_CLIENT_ID'
			])
		);
		expect(output).toContain('LinkedIn, Threads, Instagram and X have app credentials');
		expect(output).toContain('all six platforms can be connected');
	});

	it('fails when commands reach another account than the deploy', () => {
		const output = runDoctor(
			scratchCheckout(['APP_ENCRYPTION_KEY'], {
				account: 'fedcba9876543210fedcba9876543210',
				deployedTo: '0123456789abcdef0123456789abcdef'
			})
		);
		expect(output).toContain(
			'✗ Commands reach account fedcba9876543210fedcba9876543210, but cogsend was deployed to 0123456789abcdef0123456789abcdef'
		);
	});

	it('confirms the account commands reach is the deployed one', () => {
		const output = runDoctor(
			scratchCheckout(['APP_ENCRYPTION_KEY'], {
				account: '0123456789abcdef0123456789abcdef',
				deployedTo: '0123456789abcdef0123456789abcdef'
			})
		);
		expect(output).toContain(
			'✓ Commands reach cogsend on 0123456789abcdef0123456789abcdef, where it is deployed'
		);
	});

	// The fake's whoami answers for another login (op@example.com), as the real
	// one does for the folder's login when a profile is set.
	it('reads the login through WRANGLER_PROFILE, and runs the remote checks', () => {
		const output = runDoctor(
			scratchCheckout(['APP_ENCRYPTION_KEY'], { account: '0123456789abcdef0123456789abcdef' }),
			{ WRANGLER_PROFILE: 'personal' }
		);
		expect(output).toContain(
			'✓ Signed in through profile personal → 0123456789abcdef0123456789abcdef'
		);
		expect(output).not.toContain('op@example.com');
		expect(output).not.toContain('skipped (not signed in)');
		expect(output).toContain('D1 database cogsend exists');
	});

	it('names the profile to sign in when it reaches no account', () => {
		const output = runDoctor(scratchCheckout(['APP_ENCRYPTION_KEY']), {
			WRANGLER_PROFILE: 'personal'
		});
		expect(output).toContain('✗ Could not reach Cloudflare through profile personal');
		expect(output).toContain('fix: npx wrangler auth create personal');
		expect(output).toContain('D1 database check skipped (not signed in)');
	});
});

import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseJsonc } from '../scripts/lib/wrangler-config.mjs';

/**
 * The repository the Deploy to Cloudflare button copies. What it must get
 * right: the button asks for every line in .dev.vars.example (so only the key),
 * the config keeps every binding but provisions its own database, and its
 * deploy script tags the release, refuses to roll a newer instance back, and
 * survives an account with no cron slot left.
 */
describe('deploy repository', () => {
	let tmp: string;
	let out: string;
	const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string;

	beforeAll(() => {
		tmp = mkdtempSync(join(tmpdir(), 'cogsend-deploy-repo-'));
		const worker = join(tmp, 'worker');
		const assets = join(tmp, 'assets');
		mkdirSync(worker);
		mkdirSync(join(assets, '_app'), { recursive: true });
		writeFileSync(join(worker, '_worker.js'), 'export default {};\n');
		writeFileSync(join(worker, '_worker.js.map'), '{}');
		writeFileSync(join(assets, '_app/version.json'), '{}');
		writeFileSync(join(assets, '_headers'), '/_app/*\n  X: 1\n');
		writeFileSync(join(assets, '_worker.js'), 'not an asset');
		writeFileSync(join(assets, '.assetsignore'), '_worker.js\n');
		out = join(tmp, 'repo');
		const run = spawnSync(
			'node',
			[
				'scripts/deploy-repo.mjs',
				'--worker',
				worker,
				'--assets',
				assets,
				'--out',
				out,
				'--no-lock'
			],
			{ encoding: 'utf8' }
		);
		expect(run.status, run.stderr).toBe(0);
	});

	afterAll(() => rmSync(tmp, { recursive: true, force: true }));

	it('asks the button for the encryption key and nothing else', () => {
		const lines = readFileSync(join(out, '.dev.vars.example'), 'utf8')
			.split('\n')
			.filter((line) => line.trim() && !line.trim().startsWith('#'));
		expect(lines).toEqual(['APP_ENCRYPTION_KEY=']);
		const pkg = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'));
		expect(pkg.cloudflare.bindings.APP_ENCRYPTION_KEY.description).toContain('cogsend.com/key');
		expect(pkg.scripts.deploy).toBe('node deploy.mjs');
		expect(pkg.devDependencies.wrangler).toMatch(/^\d+\.\d+\.\d+$/);
		expect(pkg.allowScripts).toEqual(JSON.parse(readFileSync('package.json', 'utf8')).allowScripts);
		expect(pkg.version).toBe(version);
	});

	it('keeps every binding, provisions its own database, and marks the install', () => {
		const source = parseJsonc(readFileSync('wrangler.jsonc', 'utf8'));
		const config = parseJsonc(readFileSync(join(out, 'wrangler.jsonc'), 'utf8'));
		expect(config.main).toBe('worker/_worker.js');
		expect(config.no_bundle).toBe(true);
		expect(config.assets).toEqual({ ...source.assets, directory: 'assets' });
		expect(config.d1_databases.map((d: { database_id: string }) => d.database_id)).toEqual(['']);
		expect(config.r2_buckets).toEqual(source.r2_buckets);
		expect(config.ratelimits).toEqual(source.ratelimits);
		expect(config.triggers).toEqual(source.triggers);
		expect(config.version_metadata).toEqual(source.version_metadata);
		expect(config.compatibility_date).toBe(source.compatibility_date);
		expect(config.vars).toEqual({ COGSEND_INSTALL: 'button' });
		// The prebuilt files, and only what wrangler uploads (plus _headers, which it reads).
		expect(existsSync(join(out, 'worker/_worker.js'))).toBe(true);
		expect(existsSync(join(out, 'worker/_worker.js.map'))).toBe(false);
		expect(existsSync(join(out, 'assets/_app/version.json'))).toBe(true);
		expect(existsSync(join(out, 'assets/_headers'))).toBe(true);
		expect(existsSync(join(out, 'assets/_worker.js'))).toBe(false);
		expect(existsSync(join(out, 'drizzle/0001_init.sql'))).toBe(true);
	});

	/** Run the copy's deploy.mjs with a fake npx serving `serving` and failing
	 *  the first deploy with `deployError` when given. */
	function deployWith(
		serving: string | null,
		deployError?: string,
		env: Record<string, string> = {}
	) {
		const bin = join(tmp, `bin-${Math.random().toString(36).slice(2)}`);
		mkdirSync(bin);
		const log = join(bin, 'calls.log');
		writeFileSync(
			join(bin, 'npx'),
			`#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const serving = ${JSON.stringify(serving)};
const deployError = ${JSON.stringify(deployError ?? null)};
if (args[1] === 'deployments') {
	if (!serving) process.exit(1);
	console.log(JSON.stringify({ versions: [{ version_id: 'v', percentage: 100 }] }));
	process.exit(0);
}
if (args[1] === 'versions') { console.log(JSON.stringify({ annotations: { 'workers/tag': serving } })); process.exit(0); }
if (args[1] === 'deploy' && deployError && !args.includes('--config')) { console.error(deployError); process.exit(1); }
process.exit(0);
`
		);
		chmodSync(join(bin, 'npx'), 0o755);
		const run = spawnSync('node', ['deploy.mjs'], {
			cwd: out,
			encoding: 'utf8',
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env }
		});
		const calls = existsSync(log)
			? readFileSync(log, 'utf8')
					.trim()
					.split('\n')
					.map((line) => JSON.parse(line) as string[])
			: [];
		return { run, deploys: calls.filter((c) => c[1] === 'deploy') };
	}

	it('tags the deploy with the release it holds', () => {
		const { run, deploys } = deployWith(null);
		expect(run.status).toBe(0);
		expect(deploys[0]).toEqual([
			'wrangler',
			'deploy',
			'--tag',
			`v${version}`,
			'--message',
			`CogSend ${version}`
		]);
	});

	it('refuses to roll back an instance updated from Settings', () => {
		const { run, deploys } = deployWith('v999.0.0');
		expect(run.status).toBe(1);
		expect(run.stderr).toContain('v999.0.0');
		expect(deploys).toEqual([]);
		expect(deployWith('v999.0.0', undefined, { COGSEND_ALLOW_DOWNGRADE: '1' }).run.status).toBe(0);
	});

	it('lets exactly the release an update rolled back to past the downgrade check', () => {
		const marker = join(out, '.cogsend-rollback');
		try {
			writeFileSync(marker, `${version}\n`);
			expect(deployWith('v999.0.0').run.status).toBe(0);
			writeFileSync(marker, '0.0.1\n');
			expect(deployWith('v999.0.0').run.status).toBe(1);
		} finally {
			rmSync(marker, { force: true });
		}
	});

	it('tells the Worker which GitHub repository it was deployed from, without credentials', () => {
		const git = (...args: string[]) => spawnSync('git', args, { cwd: out, encoding: 'utf8' });
		try {
			git('init', '--quiet');
			git('remote', 'add', 'origin', 'https://x-access-token:s3cret@github.com/me/my-cogsend.git');
			const { run, deploys } = deployWith(null, undefined, { WORKERS_CI_BRANCH: 'main' });
			expect(run.status).toBe(0);
			expect(deploys[0].slice(-4)).toEqual([
				'--var',
				'COGSEND_REPO:me/my-cogsend',
				'--var',
				'COGSEND_BRANCH:main'
			]);
			expect(JSON.stringify(deploys)).not.toContain('s3cret');
		} finally {
			rmSync(join(out, '.git'), { recursive: true, force: true });
		}
	});

	it('ships the update script, its helpers and the release keys it trusts', () => {
		for (const helper of ['github-update.mjs', 'update-from-release.mjs', 'deployed-version.mjs']) {
			expect(readFileSync(join(out, 'lib', helper), 'utf8')).toBe(
				readFileSync(join('scripts/lib', helper), 'utf8')
			);
		}
		expect(JSON.parse(readFileSync(join(out, 'lib/release-keys.json'), 'utf8'))).toEqual(
			JSON.parse(readFileSync('src/lib/domain/release-keys.json', 'utf8'))
		);
		// The button cannot copy workflow files, so the repository carries none.
		expect(existsSync(join(out, '.github'))).toBe(false);
	});

	it('deploys without the cron trigger when the account has no slot left', () => {
		const { run, deploys } = deployWith(
			null,
			'✘ [ERROR] A request to the Cloudflare API failed. You have exceeded the limit of 5 cron triggers. [code: 10072]'
		);
		expect(run.status).toBe(0);
		expect(deploys).toHaveLength(2);
		expect(deploys[1]).toContain('--config');
		expect(existsSync(join(out, 'wrangler.no-cron.jsonc'))).toBe(false);
	});
});

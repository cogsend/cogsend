import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	githubRepoOf,
	replaceTree,
	rollbackAllowed,
	verifyRelease
} from '../scripts/lib/github-update.mjs';
import {
	buildBundle,
	manifestBytes,
	publicKeyOf,
	signManifest
} from '../scripts/lib/release-bundle.mjs';
import {
	GITHUB_UPDATE_WORKFLOW,
	githubUpdateLinks,
	githubUpdateTarget
} from '$lib/domain/github-update';

/**
 * Updating a Deploy-button install through its GitHub repository. The Action
 * replaces the repository with another release only when the release's
 * signature covers every file it would commit, deploy script included, since
 * Workers Builds runs that script with a token for the account.
 */
describe('GitHub update helpers', () => {
	it('reads owner/repo from any form of GitHub remote, and never its credentials', () => {
		expect(githubRepoOf('https://github.com/me/cogsend.git')).toBe('me/cogsend');
		expect(githubRepoOf('https://x-access-token:abc@github.com/me/cogsend\n')).toBe('me/cogsend');
		expect(githubRepoOf('git@github.com:me/my.cogsend.git')).toBe('me/my.cogsend');
		expect(githubRepoOf('https://gitlab.com/me/cogsend.git')).toBeNull();
		expect(githubRepoOf('https://github.com/me')).toBeNull();
		expect(githubRepoOf('')).toBeNull();
	});

	it('lets a rollback marker through for the release it names only', () => {
		expect(rollbackAllowed('1.13.0\n', '1.13.0')).toBe(true);
		expect(rollbackAllowed('1.13.0', '1.13.1')).toBe(false);
		expect(rollbackAllowed(null, '1.13.0')).toBe(false);
	});
});

describe('verifying a release before an update through GitHub', () => {
	let tmp: string;
	let repo: string;
	let keys: Array<{ id: string; publicKey: string }>;
	let release: { manifestBytes: Buffer; sigText: string; pack: Buffer };
	let unsignedRepo: { manifestBytes: Buffer; sigText: string; pack: Buffer };

	beforeAll(() => {
		tmp = mkdtempSync(join(tmpdir(), 'cogsend-github-update-'));
		repo = join(tmp, 'repo');
		mkdirSync(join(repo, 'worker'), { recursive: true });
		mkdirSync(join(repo, 'assets/_app'), { recursive: true });
		mkdirSync(join(repo, 'lib'), { recursive: true });
		writeFileSync(join(repo, 'worker/_worker.js'), 'export default { fetch() {} };\n');
		writeFileSync(join(repo, 'assets/_app/app.js'), 'console.log(1);\n');
		writeFileSync(join(repo, 'assets/robots.txt'), 'User-agent: *\n');
		writeFileSync(join(repo, 'assets/_headers'), '/_app/*\n  X: 1\n');
		writeFileSync(join(repo, 'deploy.mjs'), 'process.exit(0);\n');
		writeFileSync(join(repo, 'lib/helper.mjs'), 'export {};\n');
		writeFileSync(join(repo, 'package.json'), '{ "version": "1.14.0" }\n');

		const { privateKey } = generateKeyPairSync('ed25519');
		const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
		keys = [{ id: 'test', publicKey: publicKeyOf(pem) }];
		const sign = (deployRepoDir?: string) => {
			const { manifest, pack } = buildBundle({
				version: '1.14.0',
				createdAt: '2026-10-09T00:00:00.000Z',
				mainModule: '_worker.js',
				modules: [
					{ name: '_worker.js', type: 'esm', bytes: readFileSync(join(repo, 'worker/_worker.js')) }
				],
				assetsDir: join(repo, 'assets'),
				config: {},
				release: {},
				deployRepoDir
			});
			const bytes = manifestBytes(manifest);
			return {
				manifestBytes: bytes,
				sigText: JSON.stringify(signManifest(bytes, pem, 'test')),
				pack
			};
		};
		release = sign(repo);
		unsignedRepo = sign();
	});

	afterAll(() => rmSync(tmp, { recursive: true, force: true }));

	function variant(change: (dir: string) => void) {
		const dir = join(tmp, `v-${Math.random().toString(36).slice(2)}`);
		cpSync(repo, dir, { recursive: true });
		change(dir);
		return dir;
	}

	const check = (dir: string, over: Partial<typeof release & { tag: string }> = {}) =>
		verifyRelease({ tag: 'v1.14.0', ...release, keys, dir, ...over });

	it('accepts the release as signed, and ignores the repository workflows', () => {
		expect(check(repo).version).toBe('1.14.0');
		const withWorkflow = variant((d) => {
			mkdirSync(join(d, '.github/workflows'), { recursive: true });
			writeFileSync(join(d, '.github/workflows/update.yml'), 'name: x\n');
		});
		expect(check(withWorkflow).version).toBe('1.14.0');
	});

	it('refuses a changed deploy script, worker or static file', () => {
		expect(() => check(variant((d) => writeFileSync(join(d, 'deploy.mjs'), 'evil();\n')))).toThrow(
			'deploy.mjs does not match'
		);
		expect(() =>
			check(variant((d) => writeFileSync(join(d, 'worker/_worker.js'), 'evil();\n')))
		).toThrow('worker/_worker.js does not match');
		expect(() =>
			check(variant((d) => writeFileSync(join(d, 'assets/robots.txt'), 'Disallow: /\n')))
		).toThrow('assets/robots.txt does not match');
		expect(() =>
			check(variant((d) => writeFileSync(join(d, 'assets/_headers'), '/*\n  X: 2\n')))
		).toThrow('assets/_headers does not match');
	});

	it('refuses a file the release does not have, and one it is missing', () => {
		expect(() => check(variant((d) => writeFileSync(join(d, 'lib/extra.mjs'), '')))).toThrow(
			'lib/extra.mjs is not part of v1.14.0'
		);
		expect(() => check(variant((d) => writeFileSync(join(d, 'assets/extra.js'), '')))).toThrow(
			'assets/extra.js is not part of v1.14.0'
		);
		expect(() => check(variant((d) => rmSync(join(d, 'lib/helper.mjs'))))).toThrow(
			'lib/helper.mjs is missing'
		);
		expect(() => check(variant((d) => rmSync(join(d, 'assets/robots.txt'))))).toThrow(
			'assets/robots.txt is missing'
		);
	});

	it('refuses a symlink anywhere, which the checks would skip and wrangler would follow', () => {
		expect(() =>
			check(variant((d) => symlinkSync('/proc/self/environ', join(d, 'assets/env.txt'))))
		).toThrow('assets/env.txt is not a plain file');
		expect(() =>
			check(variant((d) => symlinkSync('../deploy.mjs', join(d, 'lib/again.mjs'))))
		).toThrow('lib/again.mjs is not a plain file');
		expect(() => check(variant((d) => symlinkSync('/etc', join(d, 'assets/etc'))))).toThrow(
			'assets/etc is not a plain file'
		);
		// The repository's own .git is not part of the release, links and all.
		const withGitLink = variant((d) => {
			mkdirSync(join(d, '.git'));
			symlinkSync('/etc', join(d, '.git/link'));
		});
		expect(check(withGitLink).version).toBe('1.14.0');
	});

	it('takes only the worker modules the release names', () => {
		expect(() =>
			check(variant((d) => writeFileSync(join(d, 'worker/extra.js'), 'evil();\n')))
		).toThrow('worker/extra.js is not part of v1.14.0');
		expect(() => check(variant((d) => rmSync(join(d, 'worker/_worker.js'))))).toThrow(
			'worker/_worker.js is missing'
		);
	});

	it('refuses an untrusted key, an altered manifest, another tag and an older release format', () => {
		expect(() => verifyRelease({ tag: 'v1.14.0', ...release, keys: [], dir: repo })).toThrow(
			'does not trust'
		);
		const altered = Buffer.from(release.manifestBytes.toString().replace('1.14.0', '1.14.1'));
		expect(() => check(repo, { manifestBytes: altered })).toThrow('does not match its signature');
		expect(() => check(repo, { tag: 'v1.15.0' })).toThrow('the manifest is for v1.14.0');
		expect(() => check(repo, { pack: Buffer.concat([release.pack, Buffer.from('x')]) })).toThrow(
			'pack does not match'
		);
		expect(() => check(repo, unsignedRepo)).toThrow('releases before 1.14.0');
	});

	it('replaces everything but the repository itself and its workflows', () => {
		const target = variant((d) => {
			mkdirSync(join(d, '.git'));
			writeFileSync(join(d, '.git/HEAD'), 'ref\n');
			mkdirSync(join(d, '.github'));
			writeFileSync(join(d, '.github/keep'), '1');
			writeFileSync(join(d, 'old-only.txt'), 'gone after the update');
		});
		replaceTree(repo, target);
		expect(existsSync(join(target, '.git/HEAD'))).toBe(true);
		expect(existsSync(join(target, '.github/keep'))).toBe(true);
		expect(existsSync(join(target, 'old-only.txt'))).toBe(false);
		expect(readFileSync(join(target, 'deploy.mjs'), 'utf8')).toBe('process.exit(0);\n');
	});
});

describe('the update script, before it reaches the network', () => {
	function run(holds: string, env: Record<string, string>) {
		const dir = mkdtempSync(join(tmpdir(), 'cogsend-update-run-'));
		cpSync('scripts/lib', join(dir, 'lib'), { recursive: true });
		cpSync('src/lib/domain/release-keys.json', join(dir, 'lib/release-keys.json'));
		writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: holds }));
		const out = join(dir, 'out.txt');
		const result = spawnSync('node', ['lib/update-from-release.mjs'], {
			cwd: dir,
			encoding: 'utf8',
			env: { ...process.env, GITHUB_OUTPUT: out, ...env }
		});
		const outputs = existsSync(out) ? readFileSync(out, 'utf8') : '';
		rmSync(dir, { recursive: true, force: true });
		return { result, outputs };
	}

	it('does nothing when the repository already holds the release', () => {
		const { result, outputs } = run('1.14.0', { TAG: 'v1.14.0' });
		expect(result.status).toBe(0);
		expect(outputs).toContain('changed=false');
	});

	it('will not go back to an older release unless asked to roll back', () => {
		const { result } = run('1.14.0', { TAG: 'v1.13.1' });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('older than 1.14.0');
	});

	it('refuses something that is not a release tag', () => {
		const { result } = run('1.14.0', { TAG: 'main; rm -rf /' });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('is not a release tag');
	});
});

describe('the Update CogSend action, as Settings offers it', () => {
	it('knows a button install’s repository only when it reads as one', () => {
		expect(githubUpdateTarget('me/my-cogsend', 'main')).toEqual({
			repo: 'me/my-cogsend',
			branch: 'main'
		});
		expect(githubUpdateTarget('me/my-cogsend', undefined)).toEqual({
			repo: 'me/my-cogsend',
			branch: 'main'
		});
		expect(githubUpdateTarget('me/x', 'feat/a b')?.branch).toBe('main');
		expect(githubUpdateTarget('not a repo', 'main')).toBeNull();
		expect(githubUpdateTarget('evil.com/x?y=1', 'main')).toBeNull();
		expect(githubUpdateTarget(undefined, 'main')).toBeNull();
	});

	it('links to the action, and to GitHub’s new-file page with the workflow filled in', () => {
		const links = githubUpdateLinks({ repo: 'me/my-cogsend', branch: 'main' });
		expect(links.run).toBe('https://github.com/me/my-cogsend/actions/workflows/update.yml');
		const enable = new URL(links.enable);
		expect(enable.origin + enable.pathname).toBe('https://github.com/me/my-cogsend/new/main');
		expect(enable.searchParams.get('filename')).toBe('.github/workflows/update.yml');
		expect(enable.searchParams.get('value')).toBe(GITHUB_UPDATE_WORKFLOW);
	});

	it('runs the signed update script, may push and nothing else, and passes inputs safely', () => {
		expect(GITHUB_UPDATE_WORKFLOW).toContain('run: node lib/update-from-release.mjs');
		expect(GITHUB_UPDATE_WORKFLOW).toMatch(/permissions:\n {2}contents: write\n\n/);
		// Inputs reach the script through the environment, never interpolated into a shell line.
		const runLines = GITHUB_UPDATE_WORKFLOW.split('\n').filter((l) =>
			/^\s+(run:|git |if \[)/.test(l)
		);
		expect(runLines.join('\n')).not.toContain('${{');
	});
});

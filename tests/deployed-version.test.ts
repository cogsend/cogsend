import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { downgradeProblem, isLaterVersion, servingTag } from '../scripts/lib/deployed-version.mjs';

/**
 * An instance updated from Settings runs a newer release than the checkout it
 * was first deployed from. Deploying that checkout again must not quietly roll
 * the instance back.
 */
describe('serving tag and downgrade check', () => {
	const fake =
		(deployment: unknown, version: unknown, status = 0) =>
		(args: string[]) => {
			if (args[0] === 'deployments') return { status, stdout: JSON.stringify(deployment) };
			return { status: 0, stdout: JSON.stringify(version) };
		};

	it('reads the tag of the version serving most traffic', () => {
		const seen: string[][] = [];
		const result = servingTag((args) => {
			seen.push(args);
			return fake(
				{
					versions: [
						{ version_id: 'small', percentage: 10 },
						{ version_id: 'big', percentage: 90 }
					]
				},
				{ annotations: { 'workers/tag': 'v1.13.0' } }
			)(args);
		});
		expect(result).toEqual({ tag: 'v1.13.0' });
		expect(seen[1]).toEqual(['versions', 'view', 'big', '--json']);
	});

	it('knows nothing when there is no deployment or no tag', () => {
		expect(servingTag(fake({}, {}, 1)).tag).toBeNull();
		expect(
			servingTag(fake({ versions: [{ version_id: 'a', percentage: 100 }] }, {})).tag
		).toBeNull();
		expect(servingTag(() => ({ status: 0, stdout: 'not json' })).tag).toBeNull();
	});

	it('refuses only a real downgrade', () => {
		expect(downgradeProblem('v1.13.0', '1.12.3')).toMatch(
			/runs v1\.13\.0, newer than the 1\.12\.3/
		);
		expect(downgradeProblem('v1.12.3', '1.12.3')).toBeNull();
		expect(downgradeProblem('v1.12.0', '1.12.3')).toBeNull();
		expect(downgradeProblem(null, '1.12.3')).toBeNull();
		expect(downgradeProblem('nightly', '1.12.3')).toBeNull();
		expect(isLaterVersion('1.10.0', '1.9.9')).toBe(true);
		// Pre-releases in semver order, as the in-app updater orders them.
		expect(isLaterVersion('v1.13.0-rc.2', '1.13.0-rc.1')).toBe(true);
		expect(isLaterVersion('v1.13.0', '1.13.0-rc.2')).toBe(true);
		expect(isLaterVersion('v1.13.0-rc.2', '1.13.0')).toBe(false);
		expect(isLaterVersion('v1.13.0-rc.10', '1.13.0-rc.9')).toBe(true);
		expect(downgradeProblem('v1.13.0', '1.13.0-rc.1')).toMatch(/newer than/);
	});
});

describe('the wrapper tags deploys and guards against downgrades', () => {
	let dir: string | null = null;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = null;
	});

	/** A checkout at `version`, and a fake npx whose Worker serves `servingTag`. */
	function checkout(version: string, serving: string | null) {
		const root = mkdtempSync(join(tmpdir(), 'cogsend-guard-'));
		dir = root;
		writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'cogsend', version }));
		writeFileSync(join(root, 'wrangler.jsonc'), '{\n\t"name": "cogsend"\n}\n');
		const bin = join(root, 'bin');
		mkdirSync(bin);
		writeFileSync(
			join(bin, 'npx'),
			`#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(root, 'calls.log'))}, JSON.stringify(args) + '\\n');
const serving = ${JSON.stringify(serving)};
if (args[1] === 'deployments') {
	if (!serving) process.exit(1);
	console.log(JSON.stringify({ versions: [{ version_id: 'v-id', percentage: 100 }] }));
	process.exit(0);
}
if (args[1] === 'versions') {
	console.log(JSON.stringify({ annotations: { 'workers/tag': serving } }));
	process.exit(0);
}
process.exit(0);
`
		);
		chmodSync(join(bin, 'npx'), 0o755);
		return { root, bin };
	}

	function deploy(
		root: string,
		bin: string,
		extra: string[] = [],
		env: Record<string, string> = {}
	) {
		return spawnSync('node', [join(process.cwd(), 'scripts/wrangler.mjs'), 'deploy', ...extra], {
			cwd: root,
			encoding: 'utf8',
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env }
		});
	}

	const deployCalls = (root: string) =>
		readFileSync(join(root, 'calls.log'), 'utf8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as string[])
			.filter((args) => args[1] === 'deploy');

	it('tags the deploy with the checkout version', () => {
		const { root, bin } = checkout('1.13.0', 'v1.12.3');
		const result = deploy(root, bin);
		expect(result.status).toBe(0);
		expect(deployCalls(root)[0]).toEqual(['wrangler', 'deploy', '--tag', 'v1.13.0']);
	});

	it('refuses to replace a newer release, and deploys nothing', () => {
		const { root, bin } = checkout('1.12.3', 'v1.13.0');
		const result = deploy(root, bin);
		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/runs v1\.13\.0, newer than the 1\.12\.3/);
		expect(deployCalls(root)).toEqual([]);
	});

	it('deploys the older release when told to, either way', () => {
		const flagged = checkout('1.12.3', 'v1.13.0');
		expect(deploy(flagged.root, flagged.bin, ['--allow-downgrade']).status).toBe(0);
		expect(deployCalls(flagged.root)[0]).toEqual(['wrangler', 'deploy', '--tag', 'v1.12.3']);
		rmSync(flagged.root, { recursive: true, force: true });

		const env = checkout('1.12.3', 'v1.13.0');
		expect(deploy(env.root, env.bin, [], { COGSEND_ALLOW_DOWNGRADE: '1' }).status).toBe(0);
	});

	it('reads the serving tag from the config the deploy was given', () => {
		const { root, bin } = checkout('1.13.0', 'v1.12.3');
		writeFileSync(join(root, 'other.jsonc'), '{\n\t"name": "other"\n}\n');
		expect(deploy(root, bin, ['--config', 'other.jsonc']).status).toBe(0);
		const status = readFileSync(join(root, 'calls.log'), 'utf8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as string[])
			.find((args) => args[1] === 'deployments')!;
		expect(status.slice(-2)).toEqual(['--config', 'other.jsonc']);
	});

	it('goes ahead when nothing is deployed yet', () => {
		const { root, bin } = checkout('1.13.0', null);
		expect(deploy(root, bin).status).toBe(0);
		expect(deployCalls(root)).toHaveLength(1);
	});
});

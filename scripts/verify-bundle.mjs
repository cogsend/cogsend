#!/usr/bin/env node
/**
 * Check a release bundle the way an instance will before installing it: the
 * signature against the committed keys, then every hash in the pack.
 *
 * Usage:
 *   node scripts/verify-bundle.mjs [--dir .release/dist] [--keys src/lib/domain/release-keys.json]
 *     [--deploy-repo .release/deploy-repo]
 *
 * --deploy-repo also runs the check an update through GitHub makes, against
 * the generated deploy repository, so a release that Action would refuse
 * never gets published.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as ui from './lib/cli.mjs';
import { verifyRelease } from './lib/github-update.mjs';
import { checkPack, verifyManifest } from './lib/release-bundle.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const at = argv.indexOf(name);
	return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};
const dir = flag('--dir', '.release/dist');
const keys = JSON.parse(
	readFileSync(flag('--keys', 'src/lib/domain/release-keys.json'), 'utf8')
).keys;

const manifestFiles = readdirSync(dir).filter((f) => f.endsWith('.manifest.json'));
if (manifestFiles.length !== 1) {
	ui.error(`Expected one manifest in ${dir}, found ${manifestFiles.length}`);
	process.exit(1);
}
const base = join(dir, manifestFiles[0].replace(/\.manifest\.json$/, ''));
const bytes = readFileSync(`${base}.manifest.json`);
const sig = JSON.parse(readFileSync(`${base}.manifest.sig`, 'utf8'));
const manifest = JSON.parse(bytes.toString('utf8'));
const pack = readFileSync(join(dir, manifest.pack.file));

const problems = checkPack(manifest, pack);
if (!verifyManifest(bytes, sig, keys))
	problems.unshift(`the signature does not verify (key ${sig.keyId})`);
const deployRepo = flag('--deploy-repo', '');
if (deployRepo && !problems.length) {
	try {
		verifyRelease({
			tag: manifest.tag,
			manifestBytes: bytes,
			sigText: readFileSync(`${base}.manifest.sig`, 'utf8'),
			pack,
			keys,
			dir: deployRepo
		});
	} catch (err) {
		problems.push(
			`an update through GitHub would refuse it: ${err instanceof Error ? err.message : err}`
		);
	}
}
if (problems.length) {
	ui.error(`${manifestFiles[0]} is not installable: ${problems.join('; ')}`);
	process.exit(1);
}
ui.ok(`${manifest.tag}: signature and every hash check out (key ${sig.keyId})`);

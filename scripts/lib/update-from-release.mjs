#!/usr/bin/env node
/**
 * What the "Update CogSend" Action runs in a Deploy-button repository: replace
 * the repository's files with another release, after checking every one of
 * them against that release's signature (see ./github-update.mjs). The Action
 * then commits, and Workers Builds deploys the commit.
 *
 * Run from the repository root. TAG names the release (empty: the latest);
 * ROLLBACK=true allows one older than the repository holds; PATCH_ONLY=true,
 * set by the daily schedule, installs only a newer patch of the same
 * major.minor, and none the release marks for installing by hand or as a
 * schema change. Writes `changed`, `tag` and `from` to GITHUB_OUTPUT.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLaterVersion } from './deployed-version.mjs';
import {
	ROLLBACK_MARKER,
	isPatchUpdate,
	releaseGate,
	replaceTree,
	verifyRelease
} from './github-update.mjs';

const APP_REPO = 'cogsend/cogsend';
const DEPLOY_REPO = 'cogsend/deploy';
const TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const here = dirname(fileURLToPath(import.meta.url));
const keys = JSON.parse(readFileSync(join(here, 'release-keys.json'), 'utf8')).keys;

function fail(message) {
	console.error(`✘ ${message}`);
	process.exit(1);
}

function output(name, value) {
	if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function download(url, accept) {
	const res = await fetch(url, {
		headers: { 'user-agent': 'cogsend-update', ...(accept && { accept }) }
	});
	if (!res.ok) fail(`${url} answered HTTP ${res.status}`);
	return res;
}

const rollback = (process.env.ROLLBACK ?? '').toLowerCase() === 'true';
const patchOnly = (process.env.PATCH_ONLY ?? '').toLowerCase() === 'true';
const tag =
	(process.env.TAG ?? '').trim() ||
	(
		await (
			await download(
				`https://api.github.com/repos/${APP_REPO}/releases/latest`,
				'application/vnd.github+json'
			)
		).json()
	).tag_name;
if (!TAG.test(String(tag))) fail(`${tag} is not a release tag`);
const version = tag.slice(1);
const current = JSON.parse(readFileSync('package.json', 'utf8')).version;
output('tag', tag);
output('from', current);

if (version === current) {
	console.log(`This repository already holds ${tag}: nothing to do.`);
	output('changed', 'false');
	process.exit(0);
}
if (patchOnly && !isPatchUpdate(current, version)) {
	console.log(
		`${tag} is not a patch release of ${current}, so the daily run leaves it: run the action by hand to install it.`
	);
	output('changed', 'false');
	process.exit(0);
}
const older = !isLaterVersion(version, current);
if (older && !rollback) {
	fail(
		`${tag} is older than ${current}, which this repository holds. Run again with "Roll back" ticked if going back is what you want.`
	);
}

const base = `https://github.com/${APP_REPO}/releases/download/${tag}/cogsend-${version}`;
const [manifestBytes, sigText, pack] = await Promise.all([
	download(`${base}.manifest.json`).then(async (r) => Buffer.from(await r.arrayBuffer())),
	download(`${base}.manifest.sig`).then((r) => r.text()),
	download(`${base}.pack`).then(async (r) => Buffer.from(await r.arrayBuffer()))
]);

// The deploy repository keeps one commit per release, titled "CogSend vX":
// stable releases on main, pre-releases on next.
const source = mkdtempSync(join(tmpdir(), 'cogsend-release-'));
/** @type {string | null} */
let leftForAPerson = null;
try {
	execFileSync('git', ['clone', '--quiet', `https://github.com/${DEPLOY_REPO}.git`, source]);
	const commit = execFileSync('git', ['-C', source, 'log', '--all', '--format=%H %s'], {
		encoding: 'utf8'
	})
		.split('\n')
		.find((line) => line.slice(41) === `CogSend ${tag}`)
		?.slice(0, 40);
	if (!commit) fail(`${DEPLOY_REPO} has no commit for ${tag}`);
	execFileSync('git', ['-C', source, 'checkout', '--quiet', commit]);

	let manifest;
	try {
		manifest = verifyRelease({ tag, manifestBytes, sigText, pack, keys, dir: source });
	} catch (err) {
		fail(err instanceof Error ? err.message : String(err));
	}
	console.log(`✔ ${tag}: signed, and every file matches`);

	const gate = releaseGate(manifest, current, { automatic: patchOnly });
	if (gate?.stop) fail(gate.reason);
	if (gate) leftForAPerson = gate.reason;
	else {
		if (manifest.notes) console.log(`ℹ ${manifest.notes}`);
		replaceTree(source, '.');
	}
} finally {
	rmSync(source, { recursive: true, force: true });
}
if (leftForAPerson) {
	console.log(leftForAPerson);
	output('changed', 'false');
	process.exit(0);
}
if (older) writeFileSync(ROLLBACK_MARKER, `${version}\n`);
console.log(`✔ ${current} → ${version}${older ? ' (rollback)' : ''}`);
output('changed', 'true');

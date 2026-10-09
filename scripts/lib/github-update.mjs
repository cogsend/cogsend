/**
 * Updating a Deploy-button install through its own GitHub repository: the
 * repository's "Update CogSend" Action replaces its files with another
 * release, and Workers Builds deploys that commit.
 *
 * Trust comes from the release signature, never from where files are fetched:
 * the manifest must be signed by a trusted key, the pack must match the
 * manifest, and every file of the deploy repository must match the manifest or
 * the pack byte for byte, its deploy script and config included, because
 * Workers Builds runs them with a token for the account. Anything else stops
 * the update before a commit.
 *
 * Self-contained (node builtins only) because the Deploy-button repository
 * ships a copy of this file, used by its update script and its deploy script.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { cpSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Left by an update that installs an older release on purpose, naming that
 *  release; the deploy script lets exactly that version past its downgrade
 *  check. */
export const ROLLBACK_MARKER = '.cogsend-rollback';

/** What an update never replaces: the repository itself and its workflows. */
export const KEEP = new Set(['.git', '.github']);

const sha256 = (/** @type {Buffer} */ bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * `owner/repo` for a GitHub remote, in any form git prints it, or null.
 * Credentials Workers Builds puts in the URL are never part of the answer.
 *
 * @param {string} remote
 */
export function githubRepoOf(remote) {
	const match =
		/^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(
			String(remote ?? '').trim()
		);
	return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * True when `to` is a later patch of the same major.minor line as `from`, the
 * only kind of release a scheduled (automatic) update installs: a new feature
 * release still waits for someone to press Run. Pre-releases never qualify.
 *
 * @param {string} from @param {string} to
 */
export function isPatchUpdate(from, to) {
	const a = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(from ?? '').trim());
	const b = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(to ?? '').trim());
	if (!a || !b) return false;
	return a[1] === b[1] && a[2] === b[2] && Number(b[3]) > Number(a[3]);
}

/**
 * True when the marker names exactly this version: an older release installed
 * on purpose may deploy once, and no other.
 *
 * @param {string | null} marker @param {string} version
 */
export function rollbackAllowed(marker, version) {
	return typeof marker === 'string' && marker.trim() === version;
}

/**
 * Every file in `dir` but the repository's own `.git` and `.github`, as
 * forward-slash paths. Anything that is not a plain file or a directory stops
 * the update: a symlink would be skipped by the checks yet committed, and in
 * assets/ wrangler would follow it and publish whatever it points at.
 *
 * @param {string} dir
 */
function filesUnder(dir) {
	/** @type {string[]} */
	const files = [];
	// By hand rather than readdirSync's `recursive`, which follows a symlinked
	// directory instead of reporting it.
	/** @param {string} rel */
	const walk = (rel) => {
		for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
			const path = rel ? `${rel}/${entry.name}` : entry.name;
			if (!rel && (entry.name === '.git' || entry.name === '.github')) continue;
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile()) files.push(path);
			else throw new Error(`${path} is not a plain file, and no release has one`);
		}
	};
	walk('');
	return files;
}

/**
 * Checks a release against its signed manifest: the signature, the pack, and
 * every file in `dir`, a copy of the deploy repository at that release.
 * Returns the manifest; throws on any mismatch.
 *
 * @param {{
 *   tag: string,
 *   manifestBytes: Buffer,
 *   sigText: string,
 *   pack: Buffer,
 *   keys: Array<{ id: string, publicKey: string }>,
 *   dir: string
 * }} release
 */
export function verifyRelease({ tag, manifestBytes, sigText, pack, keys, dir }) {
	let sig;
	try {
		sig = JSON.parse(sigText);
	} catch {
		throw new Error(`${tag}'s signature file is unreadable`);
	}
	const key = keys.find((k) => k.id === sig?.keyId);
	if (!key) throw new Error(`${tag} is signed with a key this copy does not trust (${sig?.keyId})`);
	const publicKey = createPublicKey({
		key: {
			kty: 'OKP',
			crv: 'Ed25519',
			x: Buffer.from(key.publicKey, 'base64').toString('base64url')
		},
		format: 'jwk'
	});
	if (!verify(null, manifestBytes, publicKey, Buffer.from(String(sig.signature), 'base64'))) {
		throw new Error(`${tag}'s manifest does not match its signature`);
	}
	const manifest = JSON.parse(manifestBytes.toString('utf8'));
	if (manifest.tag !== tag) throw new Error(`the manifest is for ${manifest.tag}, not ${tag}`);
	if (pack.length !== manifest.pack.size || sha256(pack) !== manifest.pack.sha256) {
		throw new Error(`${tag}'s pack does not match its manifest`);
	}

	const signedFiles = manifest.deployRepo?.files;
	if (!signedFiles || typeof signedFiles !== 'object') {
		throw new Error(
			`${tag} does not sign its deploy repository, which releases before 1.14.0 do not: install it from Settings → Instance instead`
		);
	}
	const all = filesUnder(dir);
	const others = all.filter((rel) => !/^(assets|worker)\//.test(rel));
	for (const rel of others) {
		if (!(rel in signedFiles)) throw new Error(`${rel} is not part of ${tag}`);
		if (sha256(readFileSync(join(dir, rel))) !== signedFiles[rel]) {
			throw new Error(`${rel} does not match the signed release`);
		}
	}
	for (const rel of Object.keys(signedFiles)) {
		if (!others.includes(rel)) throw new Error(`${rel} is missing`);
	}
	const modules = new Map(
		manifest.worker.modules.map((/** @type {{ name: string, sha256: string }} */ m) => [
			`worker/${m.name}`,
			m.sha256
		])
	);
	const workerFiles = all.filter((rel) => rel.startsWith('worker/'));
	for (const rel of workerFiles) {
		if (!modules.has(rel)) throw new Error(`${rel} is not part of ${tag}`);
		if (sha256(readFileSync(join(dir, rel))) !== modules.get(rel)) {
			throw new Error(`${rel} does not match the signed release`);
		}
	}
	for (const rel of modules.keys()) {
		if (!workerFiles.includes(rel)) throw new Error(`${rel} is missing`);
	}

	/** @type {Map<string, Buffer>} */
	const expected = new Map();
	for (const a of manifest.assets) {
		expected.set(
			a.path.replace(/^\//, ''),
			Buffer.from(pack.subarray(a.offset, a.offset + a.length).toString('utf8'), 'base64')
		);
	}
	// wrangler reads these two from the assets directory and the manifest
	// carries them as text, so they are signed like everything else.
	for (const name of ['_headers', '_redirects']) {
		const text = manifest.worker.assetConfig?.[name];
		if (typeof text === 'string') expected.set(name, Buffer.from(text, 'utf8'));
	}
	const present = all
		.filter((rel) => rel.startsWith('assets/'))
		.map((rel) => rel.slice('assets/'.length));
	for (const rel of present) {
		const signed = expected.get(rel);
		if (!signed) throw new Error(`assets/${rel} is not part of ${tag}`);
		if (!readFileSync(join(dir, 'assets', rel)).equals(signed)) {
			throw new Error(`assets/${rel} does not match the signed release`);
		}
	}
	for (const rel of expected.keys()) {
		if (!present.includes(rel)) throw new Error(`assets/${rel} is missing`);
	}
	return manifest;
}

/**
 * Makes `target` hold what `source` holds, leaving `.git` and `.github` alone.
 *
 * @param {string} source @param {string} target
 */
export function replaceTree(source, target) {
	for (const entry of readdirSync(target)) {
		if (!KEEP.has(entry)) rmSync(join(target, entry), { recursive: true, force: true });
	}
	for (const entry of readdirSync(source)) {
		if (!KEEP.has(entry)) cpSync(join(source, entry), join(target, entry), { recursive: true });
	}
}

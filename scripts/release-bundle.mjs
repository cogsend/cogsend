#!/usr/bin/env node
/**
 * Build and sign the release bundle the in-app updater installs. Run by
 * .github/workflows/release.yml after `npm run build` and
 * `wrangler deploy --dry-run --outdir .release/worker`; see
 * scripts/lib/release-bundle.mjs for what goes in it.
 *
 * Usage:
 *   RELEASE_SIGNING_KEY="$(cat key.pem)" node scripts/release-bundle.mjs \
 *     [--worker .release/worker] [--assets .svelte-kit/cloudflare] [--out .release/dist]
 *     [--keys src/lib/domain/release-keys.json]
 *
 * The key id is the trusted key in src/lib/domain/release-keys.json whose
 * public half matches RELEASE_SIGNING_KEY; a key that matches none is refused,
 * because it would publish a bundle no instance accepts.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as ui from './lib/cli.mjs';
import {
	buildBundle,
	checkPack,
	manifestBytes,
	publicKeyOf,
	readWorkerModules,
	signManifest,
	verifyManifest
} from './lib/release-bundle.mjs';
import { parseJsonc } from './lib/wrangler-config.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const at = argv.indexOf(name);
	return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};

const workerDir = flag('--worker', '.release/worker');
const assetsDir = flag('--assets', '.svelte-kit/cloudflare');
const outDir = flag('--out', '.release/dist');
// Tests point this at a throwaway key list; a release never does.
const keysFile = flag('--keys', 'src/lib/domain/release-keys.json');

function fail(message) {
	ui.error(message);
	process.exit(1);
}

const privateKey = process.env.RELEASE_SIGNING_KEY;
if (!privateKey?.trim()) fail('RELEASE_SIGNING_KEY is not set');

const keys = JSON.parse(readFileSync(keysFile, 'utf8')).keys;
const ownPublic = publicKeyOf(privateKey);
const keyId = keys.find((k) => k.publicKey === ownPublic)?.id;
if (!keyId) fail('RELEASE_SIGNING_KEY does not match any key in src/lib/domain/release-keys.json');

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
// The generic config, never a personal override: a release is the same for everyone.
const config = parseJsonc(readFileSync('wrangler.jsonc', 'utf8'));
const release = JSON.parse(readFileSync('release.json', 'utf8'));

const { manifest, pack } = buildBundle({
	version,
	createdAt: new Date().toISOString(),
	mainModule: basename(config.main),
	modules: readWorkerModules(workerDir),
	assetsDir,
	config,
	release
});
const bytes = manifestBytes(manifest);
const sig = signManifest(bytes, privateKey, keyId);

// Read back what is about to be published, the way an instance will.
const problems = checkPack(manifest, pack);
if (!verifyManifest(bytes, sig, keys)) problems.push('the signature does not verify');
if (problems.length) fail(`The bundle is inconsistent: ${problems.join('; ')}`);

mkdirSync(outDir, { recursive: true });
const base = join(outDir, `cogsend-${version}`);
writeFileSync(`${base}.manifest.json`, bytes);
writeFileSync(`${base}.manifest.sig`, `${JSON.stringify(sig)}\n`);
writeFileSync(`${base}.pack`, pack);
ui.ok(
	`cogsend ${version}: ${manifest.worker.modules.length} module(s), ${manifest.assets.length} assets, ` +
		`${(pack.length / 1024).toFixed(0)} KiB pack, signed with ${keyId}`
);

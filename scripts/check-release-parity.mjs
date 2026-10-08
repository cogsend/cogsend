#!/usr/bin/env node
/**
 * Prove that a release bundle uploads exactly what `wrangler deploy` would.
 *
 * Runs the pinned wrangler against a local stand-in for the Cloudflare API,
 * records the asset manifest and the Worker upload it sends, and compares them
 * with the bundle: every asset path, hash and size, every module byte, and the
 * compatibility settings and asset config. Nothing leaves this machine; the
 * stand-in answers just enough for wrangler to reach the upload, then refuses
 * it.
 *
 * Usage (after the build and `node scripts/release-bundle.mjs`):
 *   node scripts/check-release-parity.mjs --bundle .release/dist [--repo .release/deploy-repo]
 *
 * With --repo it also deploys the generated Deploy-button repository the same
 * way, which proves the button installs byte for byte what the updater would.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as ui from './lib/cli.mjs';
import { parseJsonc } from './lib/wrangler-config.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const at = argv.indexOf(name);
	return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};
const bundleDir = flag('--bundle', '.release/dist');

function fail(message) {
	ui.error(message);
	process.exit(1);
}

const manifestFile = readdirSync(bundleDir).find((f) => f.endsWith('.manifest.json'));
if (!manifestFile) fail(`No manifest in ${bundleDir}`);
const manifest = JSON.parse(readFileSync(join(bundleDir, manifestFile), 'utf8'));
const pack = readFileSync(join(bundleDir, manifest.pack.file));

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const captured = { session: null, upload: null };

const json = (res, status, body) => {
	res.writeHead(status, { 'content-type': 'application/json' });
	res.end(JSON.stringify(body));
};
const ok = (res, result) => json(res, 200, { success: true, errors: [], messages: [], result });

const server = createServer((req, res) => {
	const chunks = [];
	req.on('data', (c) => chunks.push(c));
	req.on('end', () => {
		const body = Buffer.concat(chunks);
		const path = (req.url ?? '').split('?')[0];
		if (path.endsWith('/assets-upload-session')) {
			captured.session = JSON.parse(body.toString('utf8'));
			return ok(res, { jwt: 'parity-check', buckets: [] });
		}
		if (req.method === 'PUT' && /\/workers\/scripts\/[^/]+$/.test(path)) {
			captured.upload = { body, contentType: req.headers['content-type'] ?? '' };
			return json(res, 400, {
				success: false,
				errors: [{ code: 1, message: 'parity check stops here' }],
				messages: [],
				result: null
			});
		}
		if (/\/workers\/services\/[^/]+$/.test(path)) {
			return json(res, 404, {
				success: false,
				errors: [{ code: 10090, message: 'This Worker does not exist on your account.' }],
				messages: [],
				result: null
			});
		}
		if (path.endsWith('/secrets')) return ok(res, []);
		if (path.endsWith('/deployments')) return ok(res, { deployments: [] });
		if (path.endsWith('/subdomain')) return ok(res, { subdomain: 'parity' });
		if (path.endsWith('/settings')) return ok(res, { bindings: [] });
		return ok(res, {});
	});
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const WRANGLER_BIN = join(process.cwd(), 'node_modules/wrangler/bin/wrangler.js');
// Absolute, because wrangler runs inside it and resolves --config from there.
const repoArg = flag('--repo', null);
const repoDir = repoArg ? resolve(repoArg) : null;

/**
 * Run `wrangler deploy` in `cwd` against the stand-in API and return what it
 * sent: the asset manifest and the Worker upload. The config gets a stand-in
 * database id, so wrangler provisions nothing, and no trigger.
 */
async function captureDeploy(cwd) {
	captured.session = null;
	captured.upload = null;
	const config = parseJsonc(readFileSync(join(cwd, 'wrangler.jsonc'), 'utf8'));
	for (const db of config.d1_databases ?? [])
		db.database_id = '00000000-0000-0000-0000-000000000000';
	config.triggers = { crons: [] };
	const tempConfig = join(cwd, 'wrangler.parity-check.jsonc');
	writeFileSync(tempConfig, JSON.stringify(config, null, '\t'));
	ui.progress(`running wrangler deploy in ${cwd} against a local stand-in API`);
	// Asynchronous on purpose: the stand-in API lives in this process, so a
	// blocking spawn would leave wrangler waiting on a server that cannot answer.
	const run = await new Promise((resolve) => {
		const child = spawn('node', [WRANGLER_BIN, 'deploy', '--config', tempConfig], {
			cwd,
			env: {
				...process.env,
				CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${port}/client/v4`,
				CLOUDFLARE_API_TOKEN: 'parity-check',
				CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
				WRANGLER_SEND_METRICS: 'false'
			}
		});
		let output = '';
		child.stdout.on('data', (c) => (output += c));
		child.stderr.on('data', (c) => (output += c));
		child.on('close', (status) => resolve({ status, output }));
	});
	ui.clearProgress();
	rmSync(tempConfig, { force: true });
	if (!captured.session || !captured.upload) {
		process.stderr.write(`${run.output}\n`);
		fail(`wrangler never reached the upload in ${cwd}, so nothing could be compared`);
	}
	return { session: captured.session, upload: captured.upload };
}

/** The parts of wrangler's multipart body, by name. */
function multipartParts(body, contentType) {
	const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
	if (!boundary) return {};
	const parts = {};
	const marker = Buffer.from(`--${boundary}`);
	let at = body.indexOf(marker);
	while (at >= 0) {
		const next = body.indexOf(marker, at + marker.length);
		if (next < 0) break;
		const part = body.subarray(at + marker.length + 2, next - 2);
		const split = part.indexOf('\r\n\r\n');
		const head = part.subarray(0, split).toString('utf8');
		const name = /name="([^"]+)"/.exec(head)?.[1];
		if (name) parts[name] = part.subarray(split + 4);
		at = next;
	}
	return parts;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Every difference between what wrangler sent and what the bundle holds. */
function compare(capture) {
	const problems = [];

	const theirs = capture.session.manifest;
	const ours = Object.fromEntries(manifest.assets.map((a) => [a.path, a]));
	for (const path of new Set([...Object.keys(theirs), ...Object.keys(ours)])) {
		const t = theirs[path];
		const o = ours[path];
		if (!t) problems.push(`asset ${path} is in the bundle but wrangler would not upload it`);
		else if (!o) problems.push(`asset ${path} is missing from the bundle`);
		else if (t.hash !== o.hash || t.size !== o.size) problems.push(`asset ${path} differs`);
	}

	const parts = multipartParts(capture.upload.body, capture.upload.contentType);
	const metadata = JSON.parse(parts.metadata?.toString('utf8') ?? '{}');

	if (metadata.main_module !== manifest.worker.mainModule) problems.push('main module differs');
	if (metadata.compatibility_date !== manifest.worker.compatibilityDate) {
		problems.push('compatibility date differs');
	}
	if (
		JSON.stringify(metadata.compatibility_flags ?? []) !==
		JSON.stringify(manifest.worker.compatibilityFlags)
	) {
		problems.push('compatibility flags differ');
	}
	if (
		JSON.stringify(metadata.assets?.config ?? {}) !== JSON.stringify(manifest.worker.assetConfig)
	) {
		problems.push('asset config differs');
	}
	for (const m of manifest.worker.modules) {
		const uploaded = parts[m.name];
		if (!uploaded) problems.push(`module ${m.name} is not in wrangler's upload`);
		else if (sha256(uploaded) !== m.sha256)
			problems.push(`module ${m.name} differs from wrangler's`);
		else if (sha256(pack.subarray(m.offset, m.offset + m.size)) !== m.sha256) {
			problems.push(`module ${m.name} differs inside the pack`);
		}
	}
	const uploadedModules = Object.keys(parts).filter((name) => name !== 'metadata');
	for (const name of uploadedModules) {
		if (!manifest.worker.modules.some((m) => m.name === name)) {
			problems.push(`wrangler uploads ${name}, which the bundle lacks`);
		}
	}
	return problems;
}

const problems = compare(await captureDeploy(process.cwd()));
if (repoDir) {
	for (const p of compare(await captureDeploy(repoDir))) problems.push(`deploy repository: ${p}`);
}
server.close();
if (problems.length) fail(`The bundle does not match wrangler:\n  - ${problems.join('\n  - ')}`);
ui.ok(
	`bundle matches wrangler${repoDir ? ', from this checkout and the deploy repository' : ''}: ${manifest.assets.length} assets, ${manifest.worker.modules.length} module(s), same settings`
);

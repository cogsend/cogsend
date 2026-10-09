/**
 * The signed release bundle the in-app updater installs: everything
 * `wrangler deploy` would upload for this release, laid out so a Worker can
 * replay the upload through the Cloudflare API without building or encoding
 * anything itself.
 *
 * Three files per release:
 *   cogsend-<v>.manifest.json  what to upload, and where each piece sits in the pack
 *   cogsend-<v>.manifest.sig   Ed25519 over the manifest's exact bytes
 *   cogsend-<v>.pack           the worker modules, then every asset already base64'd
 *
 * The asset side mirrors wrangler (node_modules/wrangler/wrangler-dist/cli.js):
 * the same ignore defaults, the same 32-character hash (blake3 over the base64
 * body plus the extension), and the same content types, so Cloudflare sees
 * what a terminal deploy would send. A file type this module does not know
 * fails the release rather than being uploaded as something else.
 *
 * Mirrored in src/lib/domain/update-manifest.ts, which reads what this writes;
 * tests/release-bundle.test.ts builds a bundle here and checks it there.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { hash as blake3 } from 'blake3-wasm';

export const MANIFEST_FORMAT = 1;

/** Bindings every release reads. An instance missing one cannot take the
 *  update in place; it has to be deployed from a checkout once. */
export const REQUIRED_BINDINGS = [
	{ name: 'DB', type: 'd1' },
	{ name: 'MEDIA', type: 'r2_bucket' },
	{ name: 'ASSETS', type: 'assets' }
];

/** wrangler's table for the types a SvelteKit build and `static/` produce, with
 *  its rule of adding a utf-8 charset to text types. */
/** @type {Record<string, string>} */
const CONTENT_TYPES = {
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.txt': 'text/plain; charset=utf-8',
	'.json': 'application/json',
	'.map': 'application/json',
	'.webmanifest': 'application/manifest+json',
	'.xml': 'application/xml',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.avif': 'image/avif',
	'.ico': 'image/vnd.microsoft.icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.wasm': 'application/wasm'
};

/** @param {string} path @returns {string} */
export function contentTypeFor(path) {
	const type = CONTENT_TYPES[extname(path).toLowerCase()];
	if (!type) throw new Error(`No content type known for ${path}: add it to CONTENT_TYPES`);
	return type;
}

/**
 * wrangler's asset hash: blake3 of the base64 body followed by the extension
 * without its dot, as 32 hex characters.
 *
 * @param {Buffer} body @param {string} path @returns {string}
 */
export function assetHash(body, path) {
	const extension = extname(path).slice(1);
	return Buffer.from(blake3(body.toString('base64') + extension))
		.toString('hex')
		.slice(0, 32);
}

/**
 * The gitignore subset `.assetsignore` files use: names, `*` and `?`, a
 * leading `/` to anchor, a trailing `/` for directories, and `**`. Negation is
 * refused instead of half-supported.
 *
 * @param {string[]} patterns @returns {(path: string) => boolean} path is posix, no leading slash
 */
export function ignoreMatcher(patterns) {
	/** @type {RegExp[]} */
	const rules = [];
	for (const raw of patterns) {
		const pattern = raw.trim();
		if (!pattern || pattern.startsWith('#')) continue;
		if (pattern.startsWith('!')) throw new Error(`Unsupported .assetsignore pattern: ${pattern}`);
		const anchored = pattern.startsWith('/') || pattern.slice(0, -1).includes('/');
		const dirOnly = pattern.endsWith('/');
		const body = pattern.replace(/^\//, '').replace(/\/$/, '');
		const source = body
			.split('**')
			.map((part) =>
				part
					.replace(/[.+^${}()|[\]\\]/g, '\\$&')
					.replace(/\*/g, '[^/]*')
					.replace(/\?/g, '[^/]')
			)
			.join('.*');
		const prefix = anchored ? '^' : '^(?:.*/)?';
		// A directory pattern, or any match on a parent directory, covers what is inside it.
		rules.push(new RegExp(`${prefix}${source}${dirOnly ? '/' : '(?:/|$)'}`));
	}
	return (path) => rules.some((rule) => rule.test(path));
}

/**
 * The files wrangler would upload from an assets directory, sorted.
 *
 * @param {string} dir @returns {string[]} posix paths relative to `dir`
 */
export function listAssets(dir) {
	const defaults = ['/.assetsignore', '/_redirects', '/_headers'];
	const ignoreFile = join(dir, '.assetsignore');
	const extra = existsSync(ignoreFile) ? readFileSync(ignoreFile, 'utf8').split('\n') : [];
	const ignored = ignoreMatcher([...defaults, ...extra]);
	/** @type {string[]} */
	const out = [];
	/** @param {string} current */
	const walk = (current) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const full = join(current, entry.name);
			const rel = relative(dir, full).split(sep).join('/');
			if (entry.isDirectory()) {
				if (!ignored(`${rel}/`)) walk(full);
			} else if (entry.isFile() && !ignored(rel)) {
				out.push(rel);
			}
		}
	};
	walk(dir);
	return out.sort();
}

/** @param {string} path @returns {string | undefined} */
function readOptional(path) {
	return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

/** @param {Uint8Array} bytes */
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * The modules `wrangler deploy --dry-run --outdir` wrote. Only ESM and wasm are
 * expected from this build; anything else stops the release.
 *
 * @param {string} dir @returns {Array<{ name: string, type: 'esm' | 'compiled-wasm', bytes: Buffer }>}
 */
export function readWorkerModules(dir) {
	const modules = [];
	for (const name of readdirSync(dir).sort()) {
		if (name.endsWith('.map') || name === 'README.md') continue;
		const full = join(dir, name);
		if (!statSync(full).isFile())
			throw new Error(`Unexpected directory in the worker output: ${name}`);
		const ext = extname(name);
		/** @type {'esm' | 'compiled-wasm' | null} */
		const type = ext === '.js' || ext === '.mjs' ? 'esm' : ext === '.wasm' ? 'compiled-wasm' : null;
		if (!type) throw new Error(`Unexpected module type in the worker output: ${name}`);
		modules.push({ name, type, bytes: readFileSync(full) });
	}
	return modules;
}

/**
 * Build the manifest object and the pack.
 *
 * @param {{
 *   version: string,
 *   createdAt: string,
 *   mainModule: string,
 *   modules: Array<{ name: string, type: string, bytes: Buffer }>,
 *   assetsDir: string,
 *   config: Record<string, any>,
 *   release: { minFromVersion?: string, manualOnly?: boolean, schemaChange?: boolean, notes?: string | null }
 * }} input
 */
export function buildBundle({
	version,
	createdAt,
	mainModule,
	modules,
	assetsDir,
	config,
	release
}) {
	if (!modules.some((m) => m.name === mainModule)) {
		throw new Error(`The main module ${mainModule} is not in the worker output`);
	}
	/** @type {Buffer[]} */
	const chunks = [];
	let offset = 0;
	/** @param {Buffer} bytes */
	const append = (bytes) => {
		chunks.push(bytes);
		const at = offset;
		offset += bytes.length;
		return at;
	};

	const workerModules = modules.map((m) => ({
		name: m.name,
		type: m.type,
		offset: append(m.bytes),
		size: m.bytes.length,
		sha256: sha256(m.bytes)
	}));

	const assets = listAssets(assetsDir).map((rel) => {
		const body = readFileSync(join(assetsDir, rel));
		const encoded = Buffer.from(body.toString('base64'), 'utf8');
		return {
			path: `/${rel}`,
			hash: assetHash(body, rel),
			size: body.length,
			contentType: contentTypeFor(rel),
			offset: append(encoded),
			length: encoded.length
		};
	});

	const pack = Buffer.concat(chunks);
	const tag = `v${version}`;
	const assetConfig = {
		...(config.assets?.html_handling !== undefined && {
			html_handling: config.assets.html_handling
		}),
		...(config.assets?.not_found_handling !== undefined && {
			not_found_handling: config.assets.not_found_handling
		}),
		...(config.assets?.run_worker_first !== undefined && {
			run_worker_first: config.assets.run_worker_first
		}),
		...(readOptional(join(assetsDir, '_headers')) !== undefined && {
			_headers: readOptional(join(assetsDir, '_headers'))
		}),
		...(readOptional(join(assetsDir, '_redirects')) !== undefined && {
			_redirects: readOptional(join(assetsDir, '_redirects'))
		})
	};

	const manifest = {
		format: MANIFEST_FORMAT,
		name: 'cogsend',
		version,
		tag,
		createdAt,
		minFromVersion: release.minFromVersion ?? '0.0.0',
		manualOnly: Boolean(release.manualOnly),
		schemaChange: Boolean(release.schemaChange),
		notes: release.notes ?? null,
		pack: { file: `cogsend-${version}.pack`, size: pack.length, sha256: sha256(pack) },
		worker: {
			mainModule,
			modules: workerModules,
			compatibilityDate: config.compatibility_date,
			compatibilityFlags: config.compatibility_flags ?? [],
			...(config.observability && { observability: config.observability }),
			assetConfig
		},
		requiredBindings: REQUIRED_BINDINGS,
		assets
	};
	return { manifest, pack };
}

/** The manifest exactly as it is published and signed.
 *  @param {unknown} manifest */
export function manifestBytes(manifest) {
	return Buffer.from(`${JSON.stringify(manifest, null, '\t')}\n`, 'utf8');
}

/**
 * @param {Buffer} bytes the manifest file
 * @param {string} privateKeyPem PKCS#8
 * @param {string} keyId
 */
export function signManifest(bytes, privateKeyPem, keyId) {
	const key = createPrivateKey(privateKeyPem);
	if (key.asymmetricKeyType !== 'ed25519') throw new Error('The signing key must be Ed25519');
	return { keyId, signature: sign(null, bytes, key).toString('base64') };
}

/** The raw 32-byte public key of a PKCS#8 private key, base64.
 *  @param {string} privateKeyPem */
export function publicKeyOf(privateKeyPem) {
	const jwk = createPublicKey(createPrivateKey(privateKeyPem)).export({ format: 'jwk' });
	return Buffer.from(String(jwk.x), 'base64url').toString('base64');
}

/**
 * @param {Buffer} bytes @param {{ keyId: string, signature: string }} sig
 * @param {Array<{ id: string, publicKey: string }>} keys
 */
export function verifyManifest(bytes, sig, keys) {
	const trusted = keys.find((k) => k.id === sig.keyId);
	if (!trusted) return false;
	const key = createPublicKey({
		key: {
			kty: 'OKP',
			crv: 'Ed25519',
			x: Buffer.from(trusted.publicKey, 'base64').toString('base64url')
		},
		format: 'jwk'
	});
	return verify(null, bytes, key, Buffer.from(sig.signature, 'base64'));
}

/**
 * Every hash a bundle carries, checked against the pack.
 *
 * @param {Record<string, any>} manifest @param {Buffer} pack @returns {string[]} problems
 */
export function checkPack(manifest, pack) {
	const problems = [];
	if (pack.length !== manifest.pack.size) problems.push('pack size differs from the manifest');
	if (sha256(pack) !== manifest.pack.sha256) problems.push('pack sha256 differs from the manifest');
	for (const m of manifest.worker.modules) {
		if (sha256(pack.subarray(m.offset, m.offset + m.size)) !== m.sha256) {
			problems.push(`module ${m.name} differs from its sha256`);
		}
	}
	for (const a of manifest.assets) {
		const body = Buffer.from(
			pack.subarray(a.offset, a.offset + a.length).toString('utf8'),
			'base64'
		);
		if (body.length !== a.size || assetHash(body, a.path) !== a.hash) {
			problems.push(`asset ${a.path} differs from its hash`);
		}
	}
	return problems;
}

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { hash as blake3 } from 'blake3-wasm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	REQUIRED_BINDINGS,
	assetHash,
	buildBundle,
	checkPack,
	contentTypeFor,
	ignoreMatcher,
	listAssets,
	manifestBytes,
	publicKeyOf,
	signManifest,
	verifyManifest
} from '../scripts/lib/release-bundle.mjs';
import {
	CORE_BINDINGS,
	bindingSignature,
	bindingsToSend,
	compareVersions,
	singleAssetUploads,
	parseManifest,
	updateBlockers,
	verifyManifestSignature,
	type ApiBinding,
	type UpdateManifest
} from '$lib/domain/update-manifest';

/**
 * The release bundle is written by a Node script and read by the Worker. This
 * builds one with the script and reads it back the way an instance does: the
 * signature, the schema, every hash, and the rules for refusing an update.
 */
describe('release bundle', () => {
	let dir: string;
	let privateKey: string;
	let keys: Array<{ id: string; publicKey: string }>;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'cogsend-bundle-'));
		const assets = join(dir, 'assets');
		mkdirSync(join(assets, '_app/immutable'), { recursive: true });
		writeFileSync(join(assets, '_app/immutable/start.abc.js'), 'export const a = 1;\n');
		writeFileSync(join(assets, '_app/version.json'), '{"version":"1"}');
		writeFileSync(join(assets, 'robots.txt'), 'User-agent: *\n');
		writeFileSync(join(assets, 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]));
		writeFileSync(join(assets, '_worker.js'), 'ignored');
		writeFileSync(join(assets, '_headers'), '/_app/*\n  X-Test: 1\n');
		writeFileSync(
			join(assets, '.assetsignore'),
			'_worker.js\n_routes.json\n_headers\n_redirects\n'
		);
		const generated = generateKeyPairSync('ed25519');
		privateKey = generated.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
		keys = [{ id: 'test-key', publicKey: publicKeyOf(privateKey) }];
	});

	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	function build(release: Record<string, unknown> = {}) {
		return buildBundle({
			version: '1.13.0',
			createdAt: '2026-10-09T00:00:00.000Z',
			mainModule: '_worker.js',
			modules: [{ name: '_worker.js', type: 'esm', bytes: Buffer.from('export default {};\n') }],
			assetsDir: join(dir, 'assets'),
			config: {
				compatibility_date: '2026-08-17',
				compatibility_flags: ['nodejs_als'],
				observability: { enabled: true }
			},
			release
		});
	}

	it('lists the assets wrangler would upload, nothing it ignores', () => {
		expect(listAssets(join(dir, 'assets'))).toEqual([
			'_app/immutable/start.abc.js',
			'_app/version.json',
			'icon.png',
			'robots.txt'
		]);
	});

	it('hashes an asset the way wrangler does', () => {
		const body = Buffer.from('export const a = 1;\n');
		const expected = Buffer.from(blake3(`${body.toString('base64')}js`))
			.toString('hex')
			.slice(0, 32);
		expect(assetHash(body, '_app/immutable/start.abc.js')).toBe(expected);
	});

	it('round-trips: signed by the script, verified and parsed by the app', async () => {
		const { manifest, pack } = build();
		const bytes = manifestBytes(manifest);
		const sig = signManifest(bytes, privateKey, 'test-key');
		expect(verifyManifest(bytes, sig, keys)).toBe(true);
		expect(await verifyManifestSignature(new Uint8Array(bytes), JSON.stringify(sig), keys)).toBe(
			true
		);
		const parsed = parseManifest(new Uint8Array(bytes));
		expect(parsed?.version).toBe('1.13.0');
		expect(parsed?.assets).toHaveLength(4);
		expect(parsed?.worker.assetConfig).toEqual({ _headers: '/_app/*\n  X-Test: 1\n' });
		expect(checkPack(manifest, pack)).toEqual([]);
		// The bodies in the pack are base64 already, so the Worker never encodes.
		const robots = parsed!.assets.find((a) => a.path === '/robots.txt')!;
		expect(
			Buffer.from(
				pack.subarray(robots.offset, robots.offset + robots.length).toString(),
				'base64'
			).toString()
		).toBe('User-agent: *\n');
		expect(robots.contentType).toBe('text/plain; charset=utf-8');
	});

	it('refuses a tampered manifest, a foreign key and a damaged pack', async () => {
		const { manifest, pack } = build();
		const bytes = manifestBytes(manifest);
		const sig = JSON.stringify(signManifest(bytes, privateKey, 'test-key'));
		const tampered = new Uint8Array(Buffer.from(bytes.toString().replace('1.13.0', '1.13.1')));
		expect(await verifyManifestSignature(tampered, sig, keys)).toBe(false);
		const other = generateKeyPairSync('ed25519').privateKey.export({
			type: 'pkcs8',
			format: 'pem'
		});
		const foreign = JSON.stringify(signManifest(bytes, other.toString(), 'test-key'));
		expect(await verifyManifestSignature(new Uint8Array(bytes), foreign, keys)).toBe(false);
		const unknownId = JSON.stringify({ ...JSON.parse(sig), keyId: 'nobody' });
		expect(await verifyManifestSignature(new Uint8Array(bytes), unknownId, keys)).toBe(false);
		expect(await verifyManifestSignature(new Uint8Array(bytes), 'not json', keys)).toBe(false);
		// The committed production key does not vouch for a test bundle.
		expect(await verifyManifestSignature(new Uint8Array(bytes), sig)).toBe(false);

		const damaged = Buffer.from(pack);
		damaged[damaged.length - 1] ^= 1;
		expect(checkPack(manifest, damaged).length).toBeGreaterThan(0);
	});

	it('rejects a manifest whose spans fall outside the pack', () => {
		const { manifest } = build();
		const broken = { ...manifest, pack: { ...manifest.pack, size: 3 } };
		expect(parseManifest(new Uint8Array(manifestBytes(broken)))).toBeNull();
		const noMain = { ...manifest, worker: { ...manifest.worker, mainModule: 'missing.js' } };
		expect(parseManifest(new Uint8Array(manifestBytes(noMain)))).toBeNull();
	});

	it('hashes with the blake3 wrangler itself uses', () => {
		const ours = JSON.parse(readFileSync('package.json', 'utf8')).devDependencies['blake3-wasm'];
		const wranglers = JSON.parse(readFileSync('node_modules/wrangler/package.json', 'utf8'))
			.dependencies['blake3-wasm'];
		expect(ours).toBe(wranglers);
	});

	it("requires the same bindings the app treats as CogSend's own", () => {
		expect(REQUIRED_BINDINGS).toEqual(CORE_BINDINGS);
	});

	it('refuses file types it does not know, and .assetsignore negation', () => {
		expect(() => contentTypeFor('file.unknownext')).toThrow(/No content type/);
		expect(contentTypeFor('a/b.JS')).toBe('text/javascript; charset=utf-8');
		expect(() => ignoreMatcher(['!keep.js'])).toThrow(/Unsupported/);
	});

	it('matches .assetsignore patterns the gitignore way', () => {
		const ignored = ignoreMatcher(['_worker.js', '/top.txt', 'drafts/', '*.map', 'a/**/z.js']);
		expect(ignored('_worker.js')).toBe(true);
		expect(ignored('nested/_worker.js')).toBe(true);
		expect(ignored('top.txt')).toBe(true);
		expect(ignored('nested/top.txt')).toBe(false);
		expect(ignored('drafts/')).toBe(true);
		expect(ignored('drafts/x.js')).toBe(true);
		expect(ignored('app.js.map')).toBe(true);
		expect(ignored('a/b/c/z.js')).toBe(true);
		expect(ignored('app.js')).toBe(false);
	});
});

describe('update blockers', () => {
	const base = {
		version: '1.13.0',
		tag: 'v1.13.0',
		minFromVersion: '0.0.0',
		manualOnly: false,
		notes: null,
		requiredBindings: [
			{ name: 'DB', type: 'd1' },
			{ name: 'MEDIA', type: 'r2_bucket' },
			{ name: 'ASSETS', type: 'assets' }
		]
	} as unknown as UpdateManifest;
	const present: ApiBinding[] = [
		{ name: 'DB', type: 'd1', id: 'x' },
		{ name: 'MEDIA', type: 'r2_bucket', bucket_name: 'm' },
		{ name: 'ASSETS', type: 'assets' },
		{ name: 'APP_ENCRYPTION_KEY', type: 'secret_text' },
		{ name: 'COGSEND_INSTALL', type: 'plain_text', text: 'button' }
	];

	it('lets a newer release through', () => {
		expect(updateBlockers(base, '1.12.3', present)).toEqual([]);
	});

	it('refuses the same, an older, or an unversioned build', () => {
		expect(updateBlockers(base, '1.13.0', present)[0]).toMatch(/not newer/);
		expect(updateBlockers(base, '2.0.0', present)[0]).toMatch(/not newer/);
		expect(updateBlockers(base, 'dev', present)[0]).toMatch(/no release version/);
	});

	it('honours minFromVersion, manualOnly and missing bindings', () => {
		expect(updateBlockers({ ...base, minFromVersion: '1.12.5' }, '1.12.3', present)[0]).toMatch(
			/1\.12\.5 or later/
		);
		expect(
			updateBlockers({ ...base, manualOnly: true, notes: 'adds a queue' }, '1.12.3', present)[0]
		).toMatch(/checkout: adds a queue/);
		expect(
			updateBlockers(
				base,
				'1.12.3',
				present.filter((b) => b.name !== 'MEDIA')
			)[0]
		).toMatch(/r2_bucket binding named MEDIA/);
	});

	it('orders pre-releases, so testing rc after rc is an upgrade each time', () => {
		const order = [
			'1.12.3',
			'1.13.0-alpha',
			'1.13.0-rc.1',
			'1.13.0-rc.2',
			'1.13.0-rc.10',
			'1.13.0',
			'1.13.1'
		];
		for (let i = 1; i < order.length; i++) {
			expect(compareVersions(order[i], order[i - 1])).toBeGreaterThan(0);
			expect(compareVersions(order[i - 1], order[i])).toBeLessThan(0);
		}
		expect(compareVersions('v1.13.0', '1.13.0')).toBe(0);
		expect(compareVersions('1.13.0-rc.1', '1.13.0-rc')).toBeGreaterThan(0);
		expect(compareVersions('dev', '1.0.0')).toBeNull();
		const rc2 = { ...base, version: '1.13.0-rc.2', tag: 'v1.13.0-rc.2' } as UpdateManifest;
		expect(updateBlockers(rc2, '1.13.0-rc.1', present)).toEqual([]);
		expect(updateBlockers(base, '1.13.0-rc.2', present)).toEqual([]);
		expect(updateBlockers(rc2, '1.13.0', present)[0]).toMatch(/not newer/);
	});

	it('reads the upload mode Cloudflare asks for from the session JWT', () => {
		const jwt = (claims: object) =>
			`h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
		expect(singleAssetUploads(jwt({ wrangler_single_asset_uploads: true }))).toBe(true);
		expect(singleAssetUploads(jwt({ wrangler_single_asset_uploads: false }))).toBe(false);
		expect(singleAssetUploads(jwt({}))).toBe(false);
		expect(singleAssetUploads('not-a-jwt')).toBe(false);
		// base64url without padding, with characters that differ from base64
		expect(singleAssetUploads(jwt({ x: '???>>>', wrangler_single_asset_uploads: true }))).toBe(
			true
		);
	});

	it('sends every binding but the secrets, which the API keeps', () => {
		expect(bindingsToSend(present).map((b) => b.name)).toEqual([
			'DB',
			'MEDIA',
			'ASSETS',
			'COGSEND_INSTALL'
		]);
		expect(bindingSignature(present)).toEqual([
			'APP_ENCRYPTION_KEY:secret_text',
			'ASSETS:assets',
			'COGSEND_INSTALL:plain_text',
			'DB:d1',
			'MEDIA:r2_bucket'
		]);
	});
});

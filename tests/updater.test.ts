import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	buildBundle,
	manifestBytes,
	publicKeyOf,
	signManifest
} from '../scripts/lib/release-bundle.mjs';
import { SubrequestBudget } from '$lib/server/budget';
import { createTestDb, TEST_ENV, type TestDb } from '$lib/server/db/test';
import { cloudflareApi } from '$lib/server/updater/cloudflare-api';
import { updaterContext } from '$lib/server/updater/context';
import { readJob, readPrevious, readTarget, writePrevious } from '$lib/server/updater/state';
import {
	MAX_BUCKETS_PER_CALL,
	MAX_FILES_PER_CALL_SINGLE,
	UpdateError,
	stepAbort,
	stepAssets,
	stepPrepare,
	stepPromote,
	stepRollback,
	stepStage,
	stepTarget,
	stepVersion,
	type PackStore,
	type UpdaterContext
} from '$lib/server/updater/steps';
import { POST as stepPOST } from '../src/routes/api/update/[step]/+server';
import { GET as statusGET } from '../src/routes/api/update/+server';

/**
 * The in-app updater against a stand-in Cloudflare API and GitHub, with a real
 * bundle built and signed by the release script. The request shapes asserted
 * here are the ones wrangler 4.147 sends (captured by
 * scripts/check-release-parity.mjs's stand-in).
 */
const TOKEN = 'cf-token-that-must-never-leak-0123456789';
const ACCOUNT = 'acc0123456789abcdef0123456789abcd';
const SCRIPT = 'cogsend';
const OLD = '11111111-1111-4111-8111-111111111111';
const NEW = '22222222-2222-4222-8222-222222222222';
const TAG = 'v1.13.0';
const BASE = `https://github.com/cogsend/cogsend/releases/download/${TAG}`;

const OLD_BINDINGS = [
	{ name: 'DB', type: 'd1', id: 'db-id' },
	{ name: 'MEDIA', type: 'r2_bucket', bucket_name: 'cogsend-media' },
	{
		name: 'AUTH_RATE_LIMITER',
		type: 'ratelimit',
		namespace_id: '1001',
		simple: { limit: 20, period: 60 }
	},
	{ name: 'ASSETS', type: 'assets' },
	{ name: 'CF_VERSION_METADATA', type: 'version_metadata' },
	{ name: 'COGSEND_INSTALL', type: 'plain_text', text: 'button' },
	{ name: 'APP_ENCRYPTION_KEY', type: 'secret_text' }
];

type Binding = { name: string; type: string } & Record<string, unknown>;
type BundleAsset = {
	hash: string;
	size: number;
	contentType: string;
	offset: number;
	length: number;
};
type Bundle = {
	manifest: { assets: BundleAsset[] } & Record<string, unknown>;
	pack: Buffer;
	bytes: Buffer;
	sig: string;
};
type UploadMetadata = { bindings: Binding[]; keep_bindings: string[] } & Record<string, unknown>;
type DeployBody = { versions: Array<{ version_id: string; percentage: number }> };

function memoryStore(): PackStore & { keys: () => string[] } {
	const objects = new Map<string, Uint8Array>();
	return {
		keys: () => [...objects.keys()],
		async put(key, bytes) {
			objects.set(
				key,
				new Uint8Array(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).slice()
			);
		},
		async get(key) {
			const value = objects.get(key);
			return value ? value.slice().buffer : null;
		},
		async delete(keys) {
			for (const key of keys) objects.delete(key);
		}
	};
}

/** Cloudflare and GitHub, as far as the updater sees them. */
function world(bundle: Bundle) {
	const state = {
		deployments: [{ id: 'd-old', versions: [{ version_id: OLD, percentage: 100 }] }],
		versions: new Map<string, { id: string; resources: { bindings: Binding[] } }>([
			[OLD, { id: OLD, resources: { bindings: OLD_BINDINGS } }]
		]),
		deployCalls: [] as DeployBody[],
		versionUploads: [] as Array<{
			url: string;
			metadata: UploadMetadata;
			modules: Map<string, { type: string; text: string }>;
		}>,
		session: null as null | Record<string, { hash: string; size: number }>,
		received: new Set<string>(),
		buckets: [] as string[][],
		uploadAuth: [] as string[],
		requests: [] as string[],
		dropSecretsOnUpload: false,
		/** Cloudflare's per-file mode, signalled in the session JWT's claims. */
		singleMode: false,
		singleUploads: [] as Array<{ hash: string; contentType: string; auth: string }>
	};
	const respond = (result: unknown, status = 200) =>
		new Response(
			JSON.stringify({
				success: status < 400,
				errors: status < 400 ? [] : [{ code: 1, message: String(result) }],
				result
			}),
			{
				status,
				headers: { 'content-type': 'application/json' }
			}
		);

	const fetchImpl: typeof fetch = async (input, init) => {
		const url = typeof input === 'string' ? input : (input as Request).url;
		const method = init?.method ?? 'GET';
		state.requests.push(`${method} ${url}`);
		if (url.startsWith(BASE)) {
			if (url.endsWith('.manifest.json')) return new Response(new Uint8Array(bundle.bytes));
			if (url.endsWith('.manifest.sig')) return new Response(bundle.sig);
			if (url.endsWith('.pack')) return new Response(new Uint8Array(bundle.pack));
			return new Response('not found', { status: 404 });
		}
		const path = url.replace('https://api.cloudflare.com/client/v4', '');
		const auth = new Headers(init?.headers).get('authorization');
		if (path.startsWith('/accounts?')) return respond([{ id: ACCOUNT, name: 'Me' }]);
		if (path.endsWith('/workers/subdomain')) return respond({ subdomain: 'me' });
		if (path.endsWith('/workers/domains')) return respond([]);
		if (path.endsWith('/workers/scripts')) return respond([{ id: SCRIPT }, { id: 'other' }]);
		if (path.endsWith(`/scripts/${SCRIPT}/deployments`)) {
			if (method === 'GET') return respond({ deployments: state.deployments });
			const body = JSON.parse(String(init?.body));
			state.deployCalls.push(body);
			state.deployments = [{ id: `d-${state.deployCalls.length}`, versions: body.versions }];
			return respond({ id: 'd-new', versions: body.versions });
		}
		// Another Worker on the account, which is not CogSend.
		if (path.endsWith('/scripts/other/deployments')) {
			return respond({
				deployments: [{ id: 'd-x', versions: [{ version_id: 'other-v', percentage: 100 }] }]
			});
		}
		if (path.endsWith('/scripts/other/versions/other-v')) {
			return respond({
				id: 'other-v',
				resources: { bindings: [{ name: 'CACHE', type: 'kv_namespace' }] }
			});
		}
		const versionMatch = /\/scripts\/cogsend\/versions\/([0-9a-f-]+)$/.exec(path);
		if (versionMatch) {
			const v = state.versions.get(versionMatch[1]);
			return v ? respond(v) : respond('no such version', 404);
		}
		if (path.endsWith('/assets-upload-session')) {
			expect(auth).toBe(`Bearer ${TOKEN}`);
			state.session = JSON.parse(String(init?.body)).manifest;
			const hashes = Object.values(state.session!).map((e) => e.hash);
			state.buckets = [];
			for (let i = 0; i < hashes.length; i += 2) state.buckets.push(hashes.slice(i, i + 2));
			const jwt = state.singleMode
				? `h.${Buffer.from(JSON.stringify({ wrangler_single_asset_uploads: true })).toString('base64url')}.s`
				: 'upload-jwt';
			return respond({ jwt, buckets: state.buckets });
		}
		const single = new RegExp(`^/accounts/${ACCOUNT}/workers/assets/upload/([0-9a-f]{32})$`).exec(
			path
		);
		if (single) {
			const hash = single[1];
			const entry = bundle.manifest.assets.find((a) => a.hash === hash)!;
			const sent = Buffer.from(init?.body as Uint8Array);
			// Raw bytes, not base64: exactly the file wrangler would read from disk.
			const original = Buffer.from(
				bundle.pack.subarray(entry.offset, entry.offset + entry.length).toString(),
				'base64'
			);
			expect(sent.equals(original)).toBe(true);
			state.singleUploads.push({
				hash,
				contentType: new Headers(init?.headers).get('content-type') ?? '',
				auth: auth ?? ''
			});
			state.received.add(hash);
			const all = state.buckets.flat().every((h) => state.received.has(h));
			return respond(all ? { jwt: 'completion-jwt' } : {});
		}
		if (path.startsWith(`/accounts/${ACCOUNT}/workers/assets/upload?base64=true`)) {
			state.uploadAuth.push(auth ?? '');
			const form = init?.body as FormData;
			for (const [hash, file] of form.entries()) {
				const text = await (file as File).text();
				const entry = bundle.manifest.assets.find((a) => a.hash === hash)!;
				expect(Buffer.from(text, 'base64').length).toBe(entry.size);
				expect((file as File).type).toBe(entry.contentType);
				state.received.add(hash);
			}
			const all = state.buckets.flat().every((h) => state.received.has(h));
			return respond(all ? { jwt: 'completion-jwt' } : {});
		}
		if (
			path === `/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}/versions?bindings_inherit=strict`
		) {
			const form = init?.body as FormData;
			const metadata = JSON.parse(String(form.get('metadata')));
			const modules = new Map<string, { type: string; text: string }>();
			for (const [name, value] of form.entries()) {
				if (name === 'metadata') continue;
				modules.set(name, { type: (value as File).type, text: await (value as File).text() });
			}
			state.versionUploads.push({ url, metadata, modules });
			const kept = OLD_BINDINGS.filter((b) => metadata.keep_bindings.includes(b.type));
			const bindings = [...metadata.bindings, ...(state.dropSecretsOnUpload ? [] : kept)];
			state.versions.set(NEW, { id: NEW, resources: { bindings } });
			return respond({ id: NEW, resources: { bindings } });
		}
		return respond(`unexpected ${method} ${path}`, 404);
	};
	return { state, fetchImpl };
}

describe('in-app updater', () => {
	let dir: string;
	let bundle: Bundle;
	let keys: Array<{ id: string; publicKey: string }>;
	let test: TestDb;
	let store: ReturnType<typeof memoryStore>;
	let w: ReturnType<typeof world>;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'cogsend-updater-'));
		const assets = join(dir, 'assets');
		mkdirSync(join(assets, '_app/immutable'), { recursive: true });
		for (let i = 0; i < 5; i++)
			writeFileSync(join(assets, `_app/immutable/c${i}.js`), `export const n = ${i};\n`);
		writeFileSync(join(assets, 'robots.txt'), 'User-agent: *\n');
		const { privateKey } = generateKeyPairSync('ed25519');
		const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
		keys = [{ id: 'test', publicKey: publicKeyOf(pem) }];
		const built = buildBundle({
			version: '1.13.0',
			createdAt: '2026-10-09T00:00:00.000Z',
			mainModule: '_worker.js',
			modules: [
				{ name: '_worker.js', type: 'esm', bytes: Buffer.from('export default { fetch() {} };\n') }
			],
			assetsDir: assets,
			config: { compatibility_date: '2026-08-17', compatibility_flags: ['nodejs_als'] },
			release: { minFromVersion: '1.12.0' }
		});
		const bytes = manifestBytes(built.manifest);
		bundle = { ...built, bytes, sig: JSON.stringify(signManifest(bytes, pem, 'test')) };
	});

	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	beforeEach(async () => {
		test = await createTestDb();
		store = memoryStore();
		w = world(bundle);
	});

	function ctx(overrides: Partial<UpdaterContext> = {}): UpdaterContext {
		const budget = new SubrequestBudget();
		return {
			db: test.db,
			api: cloudflareApi(TOKEN, { fetchImpl: w.fetchImpl, budget }),
			store,
			fetchImpl: w.fetchImpl,
			budget,
			host: 'cogsend.me.workers.dev',
			runningVersionId: OLD,
			currentVersion: '1.12.3',
			trustedKeys: keys,
			...overrides
		};
	}

	/** Runs a step and checks it stayed inside a Workers Free request. */
	async function within<T>(run: (c: UpdaterContext) => Promise<T>, c = ctx()): Promise<T> {
		test.reset();
		const result = await run(c);
		expect(c.budget.used + test.count()).toBeLessThanOrEqual(50);
		return result;
	}

	async function updateToStaged() {
		await within((c) => stepTarget(c, {}));
		await within((c) => stepPrepare(c, { tag: TAG }));
		let assets = await within((c) => stepAssets(c));
		while (!assets.done) assets = await within((c) => stepAssets(c));
		await within((c) => stepVersion(c));
		return within((c) => stepStage(c));
	}

	it('finds this Worker from its workers.dev host and the serving version', async () => {
		const result = await stepTarget(ctx(), {});
		expect(result).toEqual({ target: { accountId: ACCOUNT, scriptName: SCRIPT } });
		expect(await readTarget(test.db)).toEqual({ accountId: ACCOUNT, scriptName: SCRIPT });
	});

	it("without version metadata, accepts only a Worker that has CogSend's bindings", async () => {
		const noMetadata = ctx({ runningVersionId: null, host: 'social.example.com' });
		await expect(stepTarget(noMetadata, { scriptName: 'other' })).rejects.toThrow(
			/not the Worker serving this page/
		);
		expect(await readTarget(test.db)).toBeNull();
		expect(await stepTarget(noMetadata, { scriptName: SCRIPT })).toEqual({
			target: { accountId: ACCOUNT, scriptName: SCRIPT }
		});
		// The host guess goes through the same check.
		expect(await stepTarget(ctx({ runningVersionId: null }), {})).toEqual({
			target: { accountId: ACCOUNT, scriptName: SCRIPT }
		});
	});

	it('asks which Worker when the host does not say, and checks the answer', async () => {
		const result = await stepTarget(ctx({ host: 'social.example.com' }), {});
		expect(result).toEqual({ choose: 'script', accountId: ACCOUNT, scripts: [SCRIPT, 'other'] });
		await expect(
			stepTarget(ctx({ runningVersionId: 'not-serving' }), { scriptName: SCRIPT })
		).rejects.toThrow(/not the Worker serving this page/);
		expect(await stepTarget(ctx({ host: 'social.example.com' }), { scriptName: SCRIPT })).toEqual({
			target: { accountId: ACCOUNT, scriptName: SCRIPT }
		});
	});

	it('installs a release end to end, and nothing serves it before promote', async () => {
		const staged = await updateToStaged();
		expect(staged).toEqual({ scriptName: SCRIPT, newVersionId: NEW, version: '1.13.0' });

		// Every file went up, in buckets, authorised by the session JWT, not the token.
		expect([...w.state.received].sort()).toEqual(bundle.manifest.assets.map((a) => a.hash).sort());
		expect(w.state.uploadAuth.every((a) => a === 'Bearer upload-jwt')).toBe(true);

		// The version upload mirrors wrangler's.
		const [upload] = w.state.versionUploads;
		expect(upload.metadata).toMatchObject({
			main_module: '_worker.js',
			compatibility_date: '2026-08-17',
			compatibility_flags: ['nodejs_als'],
			keep_bindings: ['secret_text', 'secret_key'],
			annotations: { 'workers/tag': TAG },
			assets: { jwt: 'completion-jwt', config: {} }
		});
		expect(upload.metadata.bindings.map((b) => b.name)).toEqual([
			'DB',
			'MEDIA',
			'AUTH_RATE_LIMITER',
			'ASSETS',
			'CF_VERSION_METADATA',
			'COGSEND_INSTALL'
		]);
		expect(upload.metadata.bindings.find((b) => b.name === 'DB')).toEqual(OLD_BINDINGS[0]);
		expect(upload.modules.get('_worker.js')).toEqual({
			type: 'application/javascript+module',
			text: 'export default { fetch() {} };\n'
		});

		// Staged at 0% beside the old version: the old one still serves everything.
		expect(w.state.deployCalls).toEqual([
			{
				strategy: 'percentage',
				versions: [
					{ version_id: OLD, percentage: 100 },
					{ version_id: NEW, percentage: 0 }
				],
				annotations: { 'workers/message': expect.any(String) }
			}
		]);

		await within((c) => stepPromote(c, {}));
		expect(w.state.deployments[0].versions).toEqual([{ version_id: NEW, percentage: 100 }]);
		expect(await readJob(test.db)).toBeNull();
		expect(store.keys()).toEqual([]);
		expect(await readPrevious(test.db)).toMatchObject({
			versionId: OLD,
			installedVersionId: NEW,
			version: '1.12.3',
			replacedBy: TAG
		});

		await within((c) => stepRollback(c));
		expect(w.state.deployments[0].versions).toEqual([{ version_id: OLD, percentage: 100 }]);
		expect(await readPrevious(test.db)).toBeNull();

		// The token never went anywhere but the Cloudflare API.
		expect(w.state.requests.filter((r) => r.includes(TOKEN))).toEqual([]);
	});

	it('will not roll back over a deploy made since the update', async () => {
		await updateToStaged();
		await within((c) => stepPromote(c, {}));
		// Deployed again from a checkout, Workers Builds or the dashboard.
		w.state.deployments = [
			{ id: 'd-later', versions: [{ version_id: 'later-v', percentage: 100 }] }
		];
		const calls = w.state.deployCalls.length;
		await expect(stepRollback(ctx())).rejects.toThrow(/Roll back no longer applies/);
		expect(w.state.deployCalls.length).toBe(calls);
		expect(await readPrevious(test.db)).toBeNull();
	});

	it('uploads one raw file per request when the session asks for it, as wrangler does', async () => {
		w.state.singleMode = true;
		await stepTarget(ctx(), {});
		await stepPrepare(ctx(), { tag: TAG });
		let calls = 0;
		let assets = await within((c) => stepAssets(c));
		calls += 1;
		while (!assets.done) {
			assets = await within((c) => stepAssets(c));
			calls += 1;
		}
		const total = bundle.manifest.assets.length;
		expect(w.state.singleUploads).toHaveLength(total);
		expect(calls).toBe(Math.ceil(total / MAX_FILES_PER_CALL_SINGLE));
		for (const upload of w.state.singleUploads) {
			const entry = bundle.manifest.assets.find((a) => a.hash === upload.hash)!;
			expect(upload.contentType).toBe(entry.contentType);
			expect(upload.auth).toMatch(/^Bearer h\./);
		}
		await within((c) => stepVersion(c));
		expect(w.state.versionUploads[0].metadata.assets).toMatchObject({ jwt: 'completion-jwt' });
	});

	it('uploads at most a bounded number of buckets per request and resumes', async () => {
		await stepTarget(ctx(), {});
		await stepPrepare(ctx(), { tag: TAG });
		const first = await stepAssets(ctx());
		const total = Math.ceil(bundle.manifest.assets.length / 2);
		expect(first.remainingBuckets).toBe(Math.max(0, total - MAX_BUCKETS_PER_CALL));
		expect((await readJob(test.db))?.phase).toBe('assets');
	});

	it('refuses a release that is not signed by a trusted key', async () => {
		await stepTarget(ctx(), {});
		const other = generateKeyPairSync('ed25519')
			.privateKey.export({ type: 'pkcs8', format: 'pem' })
			.toString();
		await expect(
			stepPrepare(ctx({ trustedKeys: [{ id: 'test', publicKey: publicKeyOf(other) }] }), {
				tag: TAG
			})
		).rejects.toThrow(/not signed by a CogSend release key/);
		expect(await readJob(test.db)).toBeNull();
		expect(store.keys()).toEqual([]);
	});

	it('refuses a pack that does not match the signed manifest', async () => {
		await stepTarget(ctx(), {});
		const damaged = Buffer.from(bundle.pack);
		damaged[0] ^= 1;
		w = world({ ...bundle, pack: damaged });
		await expect(stepPrepare(ctx(), { tag: TAG })).rejects.toThrow(/did not download intact/);
		expect(store.keys()).toEqual([]);
	});

	it('refuses an update that is not newer, or below its minimum', async () => {
		await stepTarget(ctx(), {});
		await expect(stepPrepare(ctx({ currentVersion: '1.13.0' }), { tag: TAG })).rejects.toThrow(
			/not newer/
		);
		await expect(stepPrepare(ctx({ currentVersion: '1.11.9' }), { tag: TAG })).rejects.toThrow(
			/1\.12\.0 or later/
		);
		await expect(stepPrepare(ctx(), { tag: 'main' })).rejects.toThrow(/not a release tag/);
	});

	it('refuses while Cloudflare is splitting traffic', async () => {
		await stepTarget(ctx(), {});
		w.state.deployments = [
			{
				id: 'd',
				versions: [
					{ version_id: OLD, percentage: 90 },
					{ version_id: 'x', percentage: 10 }
				]
			}
		];
		await expect(stepPrepare(ctx(), { tag: TAG })).rejects.toThrow(/splitting traffic/);
	});

	it('leaves the new version undeployed when its bindings come back different', async () => {
		await stepTarget(ctx(), {});
		await stepPrepare(ctx(), { tag: TAG });
		let assets = await stepAssets(ctx());
		while (!assets.done) assets = await stepAssets(ctx());
		w.state.dropSecretsOnUpload = true;
		await expect(stepVersion(ctx())).rejects.toThrow(/missing APP_ENCRYPTION_KEY:secret_text/);
		expect(w.state.deployCalls).toEqual([]);
	});

	it('will not promote an unchecked version unless told to', async () => {
		await stepTarget(ctx(), {});
		await stepPrepare(ctx(), { tag: TAG });
		let assets = await stepAssets(ctx());
		while (!assets.done) assets = await stepAssets(ctx());
		await stepVersion(ctx());
		await expect(stepPromote(ctx(), {})).rejects.toThrow(/Check the new version/);
		await stepPromote(ctx(), { skipStage: true });
		expect(w.state.deployments[0].versions).toEqual([{ version_id: NEW, percentage: 100 }]);
	});

	it('aborts a staged update back to the old version alone', async () => {
		await updateToStaged();
		await stepAbort(ctx());
		expect(w.state.deployments[0].versions).toEqual([{ version_id: OLD, percentage: 100 }]);
		expect(await readJob(test.db)).toBeNull();
		expect(store.keys()).toEqual([]);
	});

	it('resumes the same update and refuses to start another over it', async () => {
		await stepTarget(ctx(), {});
		await stepPrepare(ctx(), { tag: TAG });
		expect((await stepPrepare(ctx(), { tag: TAG })).tag).toBe(TAG);
		await expect(stepPrepare(ctx(), { tag: 'v1.14.0' })).rejects.toThrow(/in progress/);
	});

	it('treats an hour-old update as abandoned', async () => {
		await stepTarget(ctx(), {});
		await stepPrepare(ctx(), { tag: TAG });
		const later = () => Date.now() + 2 * 60 * 60_000;
		await expect(stepAssets(ctx({ now: later }))).rejects.toThrow(/ran out of time/);
		// Starting again clears the old one first.
		expect((await stepPrepare(ctx({ now: later }), { tag: TAG })).phase).toBe('prepared');
	});

	it('only answers a verified browser session, and never echoes the token', async () => {
		const call = (locals: Record<string, unknown>, body: unknown) =>
			stepPOST({
				params: { step: 'target' },
				request: new Request('http://localhost/api/update/target', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body)
				}),
				locals: { db: test.db, env: TEST_ENV, budget: new SubrequestBudget(), ...locals },
				platform: { env: {} },
				url: new URL('http://localhost/api/update/target')
			} as never) as Promise<Response>;
		const user = { id: 'u', email: 'a@b', timezone: 'UTC', totpEnabled: true, mfaVerified: true };
		expect((await call({ user, authMethod: 'bearer' }, { token: TOKEN })).status).toBe(401);
		expect(
			(
				await call(
					{ user: { ...user, mfaVerified: false }, authMethod: 'session' },
					{ token: TOKEN }
				)
			).status
		).toBe(401);
		const missing = await call({ user, authMethod: 'session' }, {});
		expect(missing.status).toBe(400);
		// A failing step (no R2 here) must not hand the token back.
		const failed = await call({ user, authMethod: 'session' }, { token: TOKEN });
		expect(await failed.text()).not.toContain(TOKEN);
		expect(UpdateError).toBeDefined();
	});
});

describe('update status', () => {
	it('offers Roll back only while the version the update installed still serves', async () => {
		const test = await createTestDb();
		const user = { id: 'u', email: 'a@b', timezone: 'UTC', totpEnabled: true, mfaVerified: true };
		const status = async (running: string | null) => {
			const res = (await statusGET({
				locals: { db: test.db, env: TEST_ENV, user, authMethod: 'session' },
				platform: { env: running ? { CF_VERSION_METADATA: { id: running } } : {} }
			} as never)) as Response;
			return (await res.json()).previous;
		};
		const previous = {
			versionId: OLD,
			version: '1.12.3',
			replacedBy: TAG,
			schemaChange: false,
			at: 1
		};

		await writePrevious(test.db, { ...previous, installedVersionId: NEW });
		expect(await status(NEW)).toMatchObject({ version: '1.12.3' });
		// Without version metadata the rollback step asks Cloudflare instead.
		expect(await status(null)).toMatchObject({ version: '1.12.3' });
		expect(await status('deployed-since')).toBeNull();

		// Written by a build that did not record what it installed.
		await writePrevious(test.db, previous);
		expect(await status(NEW)).toBeNull();
	});
});

describe('update status for a Deploy-button install', () => {
	it('names the GitHub repository to update through, for button installs only', async () => {
		const test = await createTestDb();
		const user = { id: 'u', email: 'a@b', timezone: 'UTC', totpEnabled: true, mfaVerified: true };
		const github = async (env: Record<string, string>) => {
			const res = (await statusGET({
				locals: { db: test.db, env: TEST_ENV, user, authMethod: 'session' },
				platform: { env }
			} as never)) as Response;
			return (await res.json()).github;
		};
		expect(
			await github({
				COGSEND_INSTALL: 'button',
				COGSEND_REPO: 'me/cogsend',
				COGSEND_BRANCH: 'main'
			})
		).toEqual({ repo: 'me/cogsend', branch: 'main' });
		expect(await github({ COGSEND_INSTALL: 'button' })).toBeNull();
		expect(await github({ COGSEND_REPO: 'me/cogsend' })).toBeNull();
		expect(await github({ COGSEND_INSTALL: 'button', COGSEND_REPO: '../../evil' })).toBeNull();
	});
});

describe('updater context', () => {
	it('calls the global fetch the way workerd requires, even as ctx.fetchImpl(…)', async () => {
		const original = globalThis.fetch;
		// workerd's fetch throws "Illegal invocation" for any other receiver.
		globalThis.fetch = function (this: unknown) {
			if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
			return Promise.resolve(new Response('ok'));
		} as typeof fetch;
		try {
			const ctx = updaterContext(
				{
					locals: { db: null, budget: new SubrequestBudget() } as never,
					platform: { env: { MEDIA: {} } } as never,
					url: new URL('https://cogsend.example')
				},
				TOKEN
			);
			expect(await (await ctx.fetchImpl('https://example.com/')).text()).toBe('ok');
		} finally {
			globalThis.fetch = original;
		}
	});
});

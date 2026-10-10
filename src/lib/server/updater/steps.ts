/**
 * The in-app updater, one short step per request.
 *
 * Each step stays far inside a Workers Free request (50 calls, 10 ms of CPU):
 * the browser drives them in order and repeats `assets` until every file is in.
 * The bundle is the signed one CI attached to the GitHub release
 * (scripts/release-bundle.mjs); its pack is staged in the instance's own R2
 * bucket so later steps never download it again.
 *
 *   target   find this Worker on the token's account
 *   prepare  fetch and verify the release, check it fits, stage the pack
 *   assets   upload the static files Cloudflare does not already have
 *   version  upload the Worker as a new version, not yet serving
 *   stage    deploy it at 0% beside the current version, for a health check
 *   promote  send all traffic to it, remember the old version for a rollback
 *   rollback send all traffic back to the version an update replaced
 *   abort    drop an unfinished update; the old version keeps serving
 *
 * Nothing is serving the new code until `promote`, and the browser only calls
 * that once `/api/health` answered from the new version through a
 * Cloudflare-Workers-Version-Overrides header.
 */
import {
	CORE_BINDINGS,
	KEPT_BINDING_TYPES,
	bindingSignature,
	bindingsToSend,
	parseManifest,
	singleAssetUploads,
	updateBlockers,
	verifyManifestSignature,
	type TrustedKey,
	type UpdateManifest
} from '$lib/domain/update-manifest';
import { RELEASE_DOWNLOAD_BASE } from '$lib/domain/release-check';
import { base64ToBytes, bytesToHex } from '$lib/domain/bytes';
import type { SubrequestBudget } from '../budget';
import type { AppDb } from '../db/client';
import type { CloudflareApi } from './cloudflare-api';
import {
	clearJob,
	clearPrevious,
	clearUnlockedToken,
	jobExpired,
	readJob,
	readPrevious,
	readTarget,
	writeJob,
	writePrevious,
	writeTarget,
	type UpdateJob,
	type UpdateTarget
} from './state';

/** A refusal the operator can act on; the route answers it as a 4xx. */
export class UpdateError extends Error {
	constructor(
		message: string,
		readonly status = 409
	) {
		super(message);
	}
}

/** Where the bundle is staged between steps. R2 in production. */
export interface PackStore {
	put(key: string, bytes: ArrayBuffer | Uint8Array): Promise<void>;
	get(key: string): Promise<ArrayBuffer | null>;
	delete(keys: string[]): Promise<void>;
}

export type UpdaterContext = {
	db: AppDb;
	api: CloudflareApi;
	store: PackStore;
	/** For the GitHub release downloads. */
	fetchImpl: typeof fetch;
	budget: SubrequestBudget;
	/** This request's host, to recognise the Worker serving it. */
	host: string;
	/** CF_VERSION_METADATA.id: the version answering this request, when bound. */
	runningVersionId: string | null;
	/** The release this build reports (__APP_VERSION__). */
	currentVersion: string;
	now?: () => number;
	/** Tests sign bundles with a throwaway key; production uses the committed ones. */
	trustedKeys?: readonly TrustedKey[];
};

const TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Buckets per `assets` call: each is one upload, and the step's own D1 and R2
 *  calls need room beside them inside the Free plan's 50. */
export const MAX_BUCKETS_PER_CALL = 20;
/** Single-upload mode decodes each file from base64 first, which is CPU the
 *  Free plan's 10 ms has to cover, so a request takes fewer of them. */
export const MAX_FILES_PER_CALL_SINGLE = 10;

type Base64Decoder = (text: string) => Uint8Array<ArrayBuffer>;
/** Native where the runtime has it (workerd does), the portable loop elsewhere. */
const decodeBase64: Base64Decoder =
	(Uint8Array as unknown as { fromBase64?: Base64Decoder }).fromBase64?.bind(Uint8Array) ??
	((text) => base64ToBytes(text) as Uint8Array<ArrayBuffer>);

const stagedKey = (version: string, file: 'manifest.json' | 'manifest.sig' | 'pack') =>
	`cogsend-updates/${version}/${file}`;

const stagedKeys = (version: string) =>
	(['manifest.json', 'manifest.sig', 'pack'] as const).map((f) => stagedKey(version, f));

async function download(ctx: UpdaterContext, url: string): Promise<ArrayBuffer> {
	// GitHub answers release downloads with a redirect to its file host, and a
	// followed redirect is a second subrequest.
	ctx.budget.count(2);
	let res: Response;
	try {
		res = await ctx.fetchImpl(url, {
			redirect: 'follow',
			headers: { 'User-Agent': 'cogsend-updater' }
		});
	} catch (err) {
		throw new UpdateError(
			`Could not download ${url}: ${err instanceof Error ? err.message : err}`,
			502
		);
	}
	if (res.status === 404) {
		throw new UpdateError(
			`${url} does not exist: the release has no update bundle (yet). Releases get one a few minutes after they are published.`,
			404
		);
	}
	if (!res.ok) throw new UpdateError(`Downloading ${url} failed with HTTP ${res.status}`, 502);
	return res.arrayBuffer();
}

async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
	return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)));
}

async function requireTarget(ctx: UpdaterContext): Promise<UpdateTarget> {
	const target = await readTarget(ctx.db);
	if (!target) throw new UpdateError('Find this Worker first (the target step)', 409);
	return target;
}

/** The job in progress, or a refusal that says how to start one. */
async function requireJob(ctx: UpdaterContext): Promise<UpdateJob> {
	const job = await readJob(ctx.db);
	if (!job) throw new UpdateError('No update in progress: start again', 409);
	if (jobExpired(job, ctx.now?.())) {
		throw new UpdateError('This update ran out of time: abort it and start again', 409);
	}
	return job;
}

/** The staged manifest, verified again: a step never trusts storage alone. */
async function stagedManifest(ctx: UpdaterContext, job: UpdateJob): Promise<UpdateManifest> {
	ctx.budget.count(2);
	const [bytes, sig] = await Promise.all([
		ctx.store.get(stagedKey(job.version, 'manifest.json')),
		ctx.store.get(stagedKey(job.version, 'manifest.sig'))
	]);
	if (!bytes || !sig) throw new UpdateError('The staged release is gone: abort and start again');
	const manifestBytes = new Uint8Array(bytes);
	const valid = await verifyManifestSignature(
		manifestBytes,
		new TextDecoder().decode(sig),
		ctx.trustedKeys
	);
	const manifest = valid ? parseManifest(manifestBytes) : null;
	if (!manifest || manifest.tag !== job.tag) {
		throw new UpdateError('The staged release no longer verifies: abort and start again');
	}
	return manifest;
}

async function stagedPack(ctx: UpdaterContext, job: UpdateJob): Promise<Uint8Array<ArrayBuffer>> {
	ctx.budget.count();
	const pack = await ctx.store.get(stagedKey(job.version, 'pack'));
	if (!pack) throw new UpdateError('The staged release is gone: abort and start again');
	return new Uint8Array(pack);
}

/** `<worker>.<subdomain>.workers.dev`, or a custom domain attached to a Worker. */
async function workerNameFromHost(ctx: UpdaterContext, accountId: string): Promise<string | null> {
	const host = ctx.host.toLowerCase().replace(/:\d+$/, '');
	const parts = host.split('.');
	if (parts.length === 4 && host.endsWith('.workers.dev')) {
		const subdomain = await ctx.api.subdomain(accountId).catch(() => null);
		return subdomain?.toLowerCase() === parts[1] ? parts[0] : null;
	}
	const domains = await ctx.api.customDomains(accountId).catch(() => []);
	return domains.find((d) => d.hostname.toLowerCase() === host)?.service ?? null;
}

/**
 * True when the Worker is this instance: its serving deployment includes the
 * version answering this request. A config without CF_VERSION_METADATA cannot
 * prove that, so the Worker must at least carry the bindings every CogSend
 * has; anything else on the account is refused rather than overwritten.
 */
async function servesThisRequest(
	ctx: UpdaterContext,
	accountId: string,
	name: string
): Promise<boolean> {
	const [current] = await ctx.api.deployments(accountId, name);
	if (!current?.versions.length) return false;
	if (ctx.runningVersionId) {
		return current.versions.some((v) => v.version_id === ctx.runningVersionId);
	}
	const serving = [...current.versions].sort((a, b) => b.percentage - a.percentage)[0];
	const bindings =
		(await ctx.api.version(accountId, name, serving.version_id)).resources?.bindings ?? [];
	return CORE_BINDINGS.every((core) =>
		bindings.some((b) => b.name === core.name && b.type === core.type)
	);
}

export type TargetResult =
	| { target: UpdateTarget }
	| { choose: 'account'; accounts: Array<{ id: string; name: string }> }
	| { choose: 'script'; accountId: string; scripts: string[] };

export async function stepTarget(
	ctx: UpdaterContext,
	input: { accountId?: string; scriptName?: string }
): Promise<TargetResult> {
	let accounts: Array<{ id: string; name: string }>;
	try {
		accounts = await ctx.api.accounts();
	} catch (err) {
		// An account-owned token may not be allowed to list accounts; the
		// operator can name the account instead (it is in the dashboard URL).
		if (!input.accountId) throw err;
		accounts = [{ id: input.accountId, name: '' }];
	}
	if (!accounts.length) {
		throw new UpdateError(
			'This token cannot see any Cloudflare account. Create it from the link, which fills in the permissions it needs.',
			403
		);
	}
	const account = input.accountId
		? accounts.find((a) => a.id === input.accountId)
		: accounts.length === 1
			? accounts[0]
			: undefined;
	if (!account) {
		if (input.accountId) throw new UpdateError('That account is not one this token can reach', 400);
		return { choose: 'account', accounts: accounts.map((a) => ({ id: a.id, name: a.name })) };
	}

	if (input.scriptName) {
		const name = input.scriptName;
		const serving = await servesThisRequest(ctx, account.id, name).catch(() => false);
		if (!serving) {
			throw new UpdateError(`${name} is not the Worker serving this page`, 400);
		}
		const target = { accountId: account.id, scriptName: name };
		await writeTarget(ctx.db, target);
		return { target };
	}

	const guess = await workerNameFromHost(ctx, account.id);
	if (guess && (await servesThisRequest(ctx, account.id, guess).catch(() => false))) {
		const target = { accountId: account.id, scriptName: guess };
		await writeTarget(ctx.db, target);
		return { target };
	}
	return { choose: 'script', accountId: account.id, scripts: await ctx.api.scripts(account.id) };
}

export type PrepareResult = {
	tag: string;
	version: string;
	assets: number;
	schemaChange: boolean;
	notes: string | null;
	phase: UpdateJob['phase'];
};

function prepared(job: UpdateJob, manifest: UpdateManifest): PrepareResult {
	return {
		tag: job.tag,
		version: job.version,
		assets: manifest.assets.length,
		schemaChange: manifest.schemaChange,
		notes: manifest.notes,
		phase: job.phase
	};
}

export async function stepPrepare(
	ctx: UpdaterContext,
	input: { tag?: string }
): Promise<PrepareResult> {
	const tag = String(input.tag ?? '').trim();
	if (!TAG.test(tag)) throw new UpdateError('That is not a release tag', 400);
	const target = await requireTarget(ctx);
	const now = ctx.now?.() ?? Date.now();

	const existing = await readJob(ctx.db);
	if (existing && !jobExpired(existing, now)) {
		if (existing.tag === tag) return prepared(existing, await stagedManifest(ctx, existing));
		throw new UpdateError(`An update to ${existing.tag} is in progress: finish or abort it first`);
	}
	if (existing) await dropJob(ctx, existing);

	const version = tag.slice(1);
	const base = `${RELEASE_DOWNLOAD_BASE}/${tag}/cogsend-${version}`;
	const [manifestBuffer, sigBuffer] = await Promise.all([
		download(ctx, `${base}.manifest.json`),
		download(ctx, `${base}.manifest.sig`)
	]);
	const manifestBytes = new Uint8Array(manifestBuffer);
	if (
		!(await verifyManifestSignature(
			manifestBytes,
			new TextDecoder().decode(sigBuffer),
			ctx.trustedKeys
		))
	) {
		throw new UpdateError(`${tag} is not signed by a CogSend release key: refusing it`, 400);
	}
	const manifest = parseManifest(manifestBytes);
	if (!manifest || manifest.tag !== tag) {
		throw new UpdateError(`${tag} has an update bundle this version cannot read`, 400);
	}

	const [current] = await ctx.api.deployments(target.accountId, target.scriptName);
	const serving = current?.versions ?? [];
	if (serving.length !== 1 || serving[0].percentage !== 100) {
		throw new UpdateError(
			'Cloudflare is splitting traffic between versions of this Worker. Finish or roll back that deployment in the dashboard first.'
		);
	}
	const previousVersionId = serving[0].version_id;
	if (ctx.runningVersionId && ctx.runningVersionId !== previousVersionId) {
		throw new UpdateError('This Worker was deployed again a moment ago: reload the page and retry');
	}
	const bindings =
		(await ctx.api.version(target.accountId, target.scriptName, previousVersionId)).resources
			?.bindings ?? [];
	const blockers = updateBlockers(manifest, ctx.currentVersion, bindings);
	if (blockers.length) throw new UpdateError(blockers.join('. '));

	const pack = await download(ctx, `${RELEASE_DOWNLOAD_BASE}/${tag}/${manifest.pack.file}`);
	if (pack.byteLength !== manifest.pack.size || (await sha256Hex(pack)) !== manifest.pack.sha256) {
		throw new UpdateError(`The ${tag} bundle did not download intact: try again`, 502);
	}
	ctx.budget.count(3);
	await Promise.all([
		ctx.store.put(stagedKey(version, 'manifest.json'), manifestBytes),
		ctx.store.put(stagedKey(version, 'manifest.sig'), new Uint8Array(sigBuffer)),
		ctx.store.put(stagedKey(version, 'pack'), pack)
	]);

	const job: UpdateJob = {
		tag,
		version,
		accountId: target.accountId,
		scriptName: target.scriptName,
		previousVersionId,
		bindings,
		startedAt: now,
		phase: 'prepared'
	};
	await writeJob(ctx.db, job);
	return prepared(job, manifest);
}

export type AssetsResult = { remainingBuckets: number; done: boolean };

export async function stepAssets(ctx: UpdaterContext): Promise<AssetsResult> {
	const job = await requireJob(ctx);
	if (job.completionJwt) return { remainingBuckets: 0, done: true };
	const manifest = await stagedManifest(ctx, job);

	if (!job.uploadJwt) {
		const listing = Object.fromEntries(
			manifest.assets.map((a) => [a.path, { hash: a.hash, size: a.size }])
		);
		const session = await ctx.api.assetUploadSession(job.accountId, job.scriptName, listing);
		job.phase = 'assets';
		if (!session.buckets?.length) {
			// Every file is already on Cloudflare: the session JWT completes the upload.
			job.completionJwt = session.jwt;
			await writeJob(ctx.db, job);
			return { remainingBuckets: 0, done: true };
		}
		job.uploadJwt = session.jwt;
		job.singleUploads = singleAssetUploads(session.jwt);
		// In single-upload mode every file is its own request, as wrangler does it.
		job.buckets = job.singleUploads
			? session.buckets.flat().map((hash) => [hash])
			: session.buckets;
		await writeJob(ctx.db, job);
	}

	const pack = await stagedPack(ctx, job);
	const byHash = new Map(manifest.assets.map((a) => [a.hash, a]));
	const assetFor = (hash: string) => {
		const asset = byHash.get(hash);
		if (!asset) throw new UpdateError(`Cloudflare asked for a file this release lacks (${hash})`);
		return asset;
	};
	const buckets = [...(job.buckets ?? [])];
	try {
		const perCall = job.singleUploads ? MAX_FILES_PER_CALL_SINGLE : MAX_BUCKETS_PER_CALL;
		for (let i = 0; i < perCall && buckets.length; i += 1) {
			let jwt: string | null;
			if (job.singleUploads) {
				const asset = assetFor(buckets[0][0]);
				// The pack holds base64; this mode takes the file's own bytes.
				const body = decodeBase64(
					new TextDecoder().decode(pack.subarray(asset.offset, asset.offset + asset.length))
				);
				jwt = await ctx.api.uploadAsset(
					job.accountId,
					job.uploadJwt!,
					asset.hash,
					asset.contentType,
					body
				);
			} else {
				const form = new FormData();
				for (const hash of buckets[0]) {
					const asset = assetFor(hash);
					form.append(
						hash,
						new File([pack.subarray(asset.offset, asset.offset + asset.length)], hash, {
							type: asset.contentType
						}),
						hash
					);
				}
				jwt = await ctx.api.uploadAssets(job.accountId, job.uploadJwt!, form);
			}
			buckets.shift();
			if (jwt) job.completionJwt = jwt;
		}
	} finally {
		// Keep what went in, so a retry resumes rather than starting over.
		job.buckets = buckets;
		await writeJob(ctx.db, job);
	}
	if (!buckets.length && !job.completionJwt) {
		throw new UpdateError(
			'Cloudflare took every file but did not confirm the upload: abort and retry',
			502
		);
	}
	return { remainingBuckets: buckets.length, done: !buckets.length };
}

export type VersionResult = { newVersionId: string };

export async function stepVersion(ctx: UpdaterContext): Promise<VersionResult> {
	const job = await requireJob(ctx);
	if (job.newVersionId) return { newVersionId: job.newVersionId };
	if (!job.completionJwt) throw new UpdateError('The static files are not uploaded yet');
	const manifest = await stagedManifest(ctx, job);
	const pack = await stagedPack(ctx, job);

	const metadata = {
		main_module: manifest.worker.mainModule,
		bindings: bindingsToSend(job.bindings),
		compatibility_date: manifest.worker.compatibilityDate,
		compatibility_flags: manifest.worker.compatibilityFlags,
		keep_bindings: [...KEPT_BINDING_TYPES],
		annotations: {
			'workers/tag': manifest.tag,
			'workers/message': `CogSend ${manifest.version}, installed from Settings`
		},
		assets: { jwt: job.completionJwt, config: manifest.worker.assetConfig }
	};
	const form = new FormData();
	form.set('metadata', JSON.stringify(metadata));
	for (const m of manifest.worker.modules) {
		form.set(
			m.name,
			new File([pack.subarray(m.offset, m.offset + m.size)], m.name, {
				type: m.type === 'esm' ? 'application/javascript+module' : 'application/wasm'
			}),
			m.name
		);
	}
	const created = await ctx.api.createVersion(job.accountId, job.scriptName, form);

	// The new version must carry exactly the bindings the old one had, secrets
	// included; anything else is left undeployed.
	const check = await ctx.api.version(job.accountId, job.scriptName, created.id);
	const before = bindingSignature(job.bindings);
	const after = bindingSignature(check.resources?.bindings ?? []);
	if (JSON.stringify(before) !== JSON.stringify(after)) {
		const missing = before.filter((b) => !after.includes(b));
		const extra = after.filter((b) => !before.includes(b));
		throw new UpdateError(
			`The uploaded version's bindings differ from the running one (${[
				...missing.map((b) => `missing ${b}`),
				...extra.map((b) => `added ${b}`)
			].join(', ')}). Nothing was deployed.`,
			502
		);
	}
	job.newVersionId = created.id;
	job.phase = 'uploaded';
	await writeJob(ctx.db, job);
	return { newVersionId: created.id };
}

export type StageResult = { scriptName: string; newVersionId: string; version: string };

export async function stepStage(ctx: UpdaterContext): Promise<StageResult> {
	const job = await requireJob(ctx);
	if (!job.newVersionId) throw new UpdateError('The new version is not uploaded yet');
	if (job.phase !== 'staged') {
		await ctx.api.deploy(
			job.accountId,
			job.scriptName,
			[
				{ version_id: job.previousVersionId, percentage: 100 },
				{ version_id: job.newVersionId, percentage: 0 }
			],
			`CogSend ${job.version}: staged at 0% for a health check`
		);
		job.phase = 'staged';
		await writeJob(ctx.db, job);
	}
	return { scriptName: job.scriptName, newVersionId: job.newVersionId, version: job.version };
}

export async function stepPromote(
	ctx: UpdaterContext,
	input: { skipStage?: boolean }
): Promise<{ version: string }> {
	const job = await requireJob(ctx);
	if (!job.newVersionId) throw new UpdateError('The new version is not uploaded yet');
	if (job.phase !== 'staged' && !input.skipStage) {
		throw new UpdateError('Check the new version before sending traffic to it');
	}
	const manifest = await stagedManifest(ctx, job);
	await ctx.api.deploy(
		job.accountId,
		job.scriptName,
		[{ version_id: job.newVersionId, percentage: 100 }],
		`CogSend ${job.version}, installed from Settings`
	);
	await writePrevious(ctx.db, {
		versionId: job.previousVersionId,
		installedVersionId: job.newVersionId,
		version: ctx.currentVersion,
		replacedBy: job.tag,
		schemaChange: manifest.schemaChange,
		at: ctx.now?.() ?? Date.now()
	});
	await dropJob(ctx, job);
	await clearUnlockedToken(ctx.db);
	return { version: job.version };
}

export async function stepRollback(ctx: UpdaterContext): Promise<{ version: string }> {
	const previous = await readPrevious(ctx.db);
	if (!previous) throw new UpdateError('There is no earlier version to return to');
	const target = await requireTarget(ctx);
	const [current] = await ctx.api.deployments(target.accountId, target.scriptName);
	const serving = current?.versions?.length === 1 ? current.versions[0].version_id : null;
	if (!previous.installedVersionId || serving !== previous.installedVersionId) {
		await clearPrevious(ctx.db);
		throw new UpdateError(
			`This Worker was deployed again after the update to ${previous.replacedBy}, so Roll back no longer applies. Pick a version under Workers & Pages → your Worker → Deployments instead.`,
			409
		);
	}
	await ctx.api.deploy(
		target.accountId,
		target.scriptName,
		[{ version_id: previous.versionId, percentage: 100 }],
		`CogSend: rolled back to ${previous.version} from Settings`
	);
	await clearPrevious(ctx.db);
	await clearUnlockedToken(ctx.db);
	return { version: previous.version };
}

export async function stepAbort(ctx: UpdaterContext): Promise<{ aborted: boolean }> {
	await clearUnlockedToken(ctx.db);
	const job = await readJob(ctx.db);
	if (!job) return { aborted: false };
	if (job.phase === 'staged') {
		// Take the 0% version back out, so the deployment is the old one alone.
		await ctx.api.deploy(
			job.accountId,
			job.scriptName,
			[{ version_id: job.previousVersionId, percentage: 100 }],
			`CogSend ${job.version}: update cancelled`
		);
	}
	await dropJob(ctx, job);
	return { aborted: true };
}

async function dropJob(ctx: UpdaterContext, job: UpdateJob): Promise<void> {
	ctx.budget.count();
	await ctx.store.delete(stagedKeys(job.version)).catch(() => undefined);
	await clearJob(ctx.db);
}

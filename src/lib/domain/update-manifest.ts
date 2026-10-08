/**
 * The release bundle as the in-app updater reads it: its schema, its
 * signature, and whether this instance may take it.
 *
 * scripts/lib/release-bundle.mjs writes the bundle (a .mjs script cannot import
 * from src, so the format is spelled out in both places), and
 * tests/release-bundle.test.ts builds one there and reads it here.
 */
import { z } from 'zod';
import { base64ToBytes } from './bytes';
import releaseKeys from './release-keys.json';

export const MANIFEST_FORMAT = 1;

const hex = (length: number) => z.string().regex(new RegExp(`^[0-9a-f]{${length}}$`));
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const span = { offset: z.number().int().nonnegative() };

const manifestSchema = z.object({
	format: z.literal(MANIFEST_FORMAT),
	name: z.literal('cogsend'),
	version,
	tag: z.string().regex(/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
	createdAt: z.string(),
	minFromVersion: version,
	manualOnly: z.boolean(),
	schemaChange: z.boolean(),
	notes: z.string().nullable(),
	pack: z.object({
		file: z.string().regex(/^cogsend-[0-9A-Za-z.-]+\.pack$/),
		size: z.number().int().positive(),
		sha256: hex(64)
	}),
	worker: z.object({
		mainModule: z.string().min(1),
		modules: z
			.array(
				z.object({
					name: z.string().min(1),
					type: z.enum(['esm', 'compiled-wasm']),
					...span,
					size: z.number().int().positive(),
					sha256: hex(64)
				})
			)
			.min(1),
		compatibilityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
		compatibilityFlags: z.array(z.string()),
		observability: z.record(z.string(), z.unknown()).optional(),
		assetConfig: z.record(z.string(), z.unknown())
	}),
	requiredBindings: z.array(z.object({ name: z.string(), type: z.string() })),
	assets: z.array(
		z.object({
			path: z.string().startsWith('/'),
			hash: hex(32),
			size: z.number().int().nonnegative(),
			contentType: z.string().min(1),
			...span,
			length: z.number().int().nonnegative()
		})
	)
});

export type UpdateManifest = z.infer<typeof manifestSchema>;

const signatureSchema = z.object({ keyId: z.string().min(1), signature: z.string().min(1) });

export type ManifestSignature = z.infer<typeof signatureSchema>;

export type TrustedKey = { id: string; publicKey: string };

/** The keys a release must be signed with, committed in release-keys.json. */
export const TRUSTED_RELEASE_KEYS: readonly TrustedKey[] = releaseKeys.keys;

/**
 * True when the manifest bytes carry a valid Ed25519 signature from a trusted
 * key. Checked over the exact bytes fetched, before anything is parsed.
 */
export async function verifyManifestSignature(
	manifestBytes: Uint8Array,
	signatureText: string,
	keys: readonly TrustedKey[] = TRUSTED_RELEASE_KEYS
): Promise<boolean> {
	let sig: ManifestSignature;
	try {
		sig = signatureSchema.parse(JSON.parse(signatureText));
	} catch {
		return false;
	}
	const trusted = keys.find((k) => k.id === sig.keyId);
	if (!trusted) return false;
	try {
		const key = await crypto.subtle.importKey(
			'raw',
			base64ToBytes(trusted.publicKey) as BufferSource,
			{ name: 'Ed25519' },
			false,
			['verify']
		);
		return await crypto.subtle.verify(
			{ name: 'Ed25519' },
			key,
			base64ToBytes(sig.signature) as BufferSource,
			manifestBytes as BufferSource
		);
	} catch {
		return false;
	}
}

/** The manifest, or null when it is not one this updater understands. */
export function parseManifest(manifestBytes: Uint8Array): UpdateManifest | null {
	try {
		const parsed = manifestSchema.safeParse(JSON.parse(new TextDecoder().decode(manifestBytes)));
		if (!parsed.success) return null;
		const m = parsed.data;
		// Every span must sit inside the pack, and the main module must exist.
		const inPack = (offset: number, length: number) => offset + length <= m.pack.size;
		if (!m.worker.modules.some((mod) => mod.name === m.worker.mainModule)) return null;
		if (!m.worker.modules.every((mod) => inPack(mod.offset, mod.size))) return null;
		if (!m.assets.every((a) => inPack(a.offset, a.length))) return null;
		return m;
	} catch {
		return null;
	}
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * Semver precedence: negative when `a` is older than `b`, positive when newer,
 * zero when equal, null when either is not a release version. Unlike the
 * update notice's comparison it orders pre-releases, so `1.13.0-rc.1` →
 * `1.13.0-rc.2` → `1.13.0` is an upgrade at every step.
 */
export function compareVersions(a: string, b: string): number | null {
	const x = SEMVER.exec(a.trim());
	const y = SEMVER.exec(b.trim());
	if (!x || !y) return null;
	for (let i = 1; i <= 3; i += 1) {
		const diff = Number(x[i]) - Number(y[i]);
		if (diff) return diff;
	}
	if (!x[4] || !y[4]) return x[4] ? -1 : y[4] ? 1 : 0;
	const left = x[4].split('.');
	const right = y[4].split('.');
	for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
		if (left[i] === undefined) return -1;
		if (right[i] === undefined) return 1;
		const ln = /^\d+$/.test(left[i]);
		const rn = /^\d+$/.test(right[i]);
		if (ln && rn) {
			const diff = Number(left[i]) - Number(right[i]);
			if (diff) return diff;
		} else if (ln !== rn) {
			return ln ? -1 : 1;
		} else if (left[i] !== right[i]) {
			return left[i] < right[i] ? -1 : 1;
		}
	}
	return 0;
}

/** A binding as the Cloudflare API lists it on a Worker version. */
export type ApiBinding = { name: string; type: string } & Record<string, unknown>;

/**
 * Why this instance cannot take the update in place, or an empty list.
 *
 * `current` is the running version (`__APP_VERSION__`); `present` the bindings
 * of the version Cloudflare is serving now.
 */
export function updateBlockers(
	manifest: UpdateManifest,
	current: string,
	present: readonly ApiBinding[]
): string[] {
	const blockers: string[] = [];
	const order = compareVersions(manifest.version, current);
	if (order === null) {
		blockers.push(`This build reports no release version (${current || 'none'})`);
	} else if (order <= 0) {
		blockers.push(`${manifest.tag} is not newer than the running ${current}`);
	} else if ((compareVersions(manifest.minFromVersion, current) ?? 0) > 0) {
		blockers.push(
			`${manifest.tag} has to be installed from ${manifest.minFromVersion} or later; this instance runs ${current}`
		);
	}
	if (manifest.manualOnly) {
		blockers.push(
			`${manifest.tag} needs a deploy from a checkout${manifest.notes ? `: ${manifest.notes}` : ''}`
		);
	}
	for (const required of manifest.requiredBindings) {
		if (!present.some((b) => b.name === required.name && b.type === required.type)) {
			blockers.push(`The Worker has no ${required.type} binding named ${required.name}`);
		}
	}
	return blockers;
}

/** Secrets ride along through `keep_bindings`; the API never returns their values. */
export const KEPT_BINDING_TYPES = ['secret_text', 'secret_key'] as const;

/**
 * The bindings to send with the new version: every one the serving version
 * has, except secrets, which the API carries over itself. Sending the rest
 * explicitly is what `wrangler versions upload` does too.
 */
export function bindingsToSend(present: readonly ApiBinding[]): ApiBinding[] {
	return present.filter((b) => !(KEPT_BINDING_TYPES as readonly string[]).includes(b.type));
}

/** `name:type` for every binding, sorted: what must not change across the update. */
export function bindingSignature(bindings: readonly { name: string; type: string }[]): string[] {
	return bindings.map((b) => `${b.name}:${b.type}`).sort();
}

/** The permissions the updater's token needs: upload and deploy versions of
 *  this Worker, and read which account it is on. */
export const UPDATE_TOKEN_PERMISSIONS = [
	{ key: 'workers_scripts', type: 'edit' },
	{ key: 'account_settings', type: 'read' }
] as const;

/** Cloudflare's token page with those permissions filled in, as an
 *  account-owned token so it outlives no person's membership. */
export const UPDATE_TOKEN_URL =
	'https://dash.cloudflare.com/?to=/:account/api-tokens' +
	`&permissionGroupKeys=${encodeURIComponent(JSON.stringify(UPDATE_TOKEN_PERMISSIONS))}` +
	`&name=${encodeURIComponent('CogSend updater')}`;

/**
 * The claims of an upload-session JWT. Cloudflare uses them to tell an
 * uploader how to send files; wrangler reads them the same way.
 */
export function jwtClaims(token: string): Record<string, unknown> {
	try {
		const part = token.split('.')[1] ?? '';
		const padded = part
			.replace(/-/g, '+')
			.replace(/_/g, '/')
			.padEnd(Math.ceil(part.length / 4) * 4, '=');
		const claims = JSON.parse(new TextDecoder().decode(base64ToBytes(padded)));
		return claims && typeof claims === 'object' ? claims : {};
	} catch {
		return {};
	}
}

/** True when the session wants one raw file per request instead of base64
 *  batches (wrangler's `isSingleAssetUploadMode`). */
export function singleAssetUploads(uploadJwt: string): boolean {
	return jwtClaims(uploadJwt).wrangler_single_asset_uploads === true;
}

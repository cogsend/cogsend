/**
 * The handful of Cloudflare API calls the in-app updater makes, with the
 * shapes wrangler itself sends (captured from wrangler 4.147 against a local
 * stand-in API; see scripts/check-release-parity.mjs).
 *
 * The API token is the operator's, pasted for this one update. It is passed in
 * per call, never stored, never logged, and scrubbed from any error text that
 * could echo it back.
 */
import type { SubrequestBudget } from '../budget';
import type { ApiBinding } from '$lib/domain/update-manifest';

const API_BASE = 'https://api.cloudflare.com/client/v4';

export class CloudflareApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code: number | null
	) {
		super(message);
	}
}

type Envelope<T> = {
	success?: boolean;
	errors?: Array<{ code?: number; message?: string }>;
	result?: T;
};

export type CloudflareAccount = { id: string; name: string };
export type DeploymentVersion = { version_id: string; percentage: number };
export type Deployment = { id: string; versions: DeploymentVersion[] };
export type WorkerVersion = {
	id: string;
	annotations?: Record<string, string>;
	resources?: { bindings?: ApiBinding[] };
};
export type AssetUploadSession = { jwt: string; buckets?: string[][] };

export type CloudflareApi = ReturnType<typeof cloudflareApi>;

export function cloudflareApi(
	token: string,
	{ fetchImpl = fetch, budget }: { fetchImpl?: typeof fetch; budget?: SubrequestBudget } = {}
) {
	const scrub = (text: string) => (token ? text.split(token).join('[token]') : text);

	async function call<T>(
		method: string,
		path: string,
		init: {
			json?: unknown;
			form?: FormData;
			raw?: { body: Uint8Array<ArrayBuffer>; contentType: string };
			bearer?: string;
		} = {}
	): Promise<T> {
		budget?.count();
		const headers: Record<string, string> = {
			Authorization: `Bearer ${init.bearer ?? token}`
		};
		let body: BodyInit | undefined;
		if (init.json !== undefined) {
			headers['Content-Type'] = 'application/json';
			body = JSON.stringify(init.json);
		} else if (init.form) {
			body = init.form;
		} else if (init.raw) {
			headers['Content-Type'] = init.raw.contentType;
			body = init.raw.body;
		}
		let res: Response;
		try {
			res = await fetchImpl(`${API_BASE}${path}`, { method, headers, body });
		} catch (err) {
			throw new CloudflareApiError(
				scrub(`Could not reach the Cloudflare API: ${err instanceof Error ? err.message : err}`),
				0,
				null
			);
		}
		const envelope = (await res.json().catch(() => null)) as Envelope<T> | null;
		if (!res.ok || !envelope?.success) {
			const first = envelope?.errors?.[0];
			const message = first?.message
				? `Cloudflare: ${first.message}`
				: `Cloudflare answered HTTP ${res.status}`;
			throw new CloudflareApiError(scrub(message), res.status, first?.code ?? null);
		}
		return envelope.result as T;
	}

	const script = (accountId: string, name: string) =>
		`/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(name)}`;

	return {
		/** Every account the token can act on. Doubles as the token check. */
		accounts: () => call<CloudflareAccount[]>('GET', '/accounts?per_page=50'),

		/** The account's workers.dev subdomain, to read a Worker name from a host. */
		subdomain: async (accountId: string) =>
			(
				await call<{ subdomain: string }>(
					'GET',
					`/accounts/${encodeURIComponent(accountId)}/workers/subdomain`
				)
			).subdomain,

		/** Custom domains attached to Workers, to read a Worker name from a host. */
		customDomains: (accountId: string) =>
			call<Array<{ hostname: string; service: string }>>(
				'GET',
				`/accounts/${encodeURIComponent(accountId)}/workers/domains`
			),

		/** Worker names on the account, for the picker. */
		scripts: async (accountId: string) =>
			(
				await call<Array<{ id: string }>>(
					'GET',
					`/accounts/${encodeURIComponent(accountId)}/workers/scripts`
				)
			).map((s) => s.id),

		/** Newest first; the first one is what is serving now. */
		deployments: async (accountId: string, name: string) =>
			(await call<{ deployments: Deployment[] }>('GET', `${script(accountId, name)}/deployments`))
				.deployments ?? [],

		version: (accountId: string, name: string, versionId: string) =>
			call<WorkerVersion>(
				'GET',
				`${script(accountId, name)}/versions/${encodeURIComponent(versionId)}`
			),

		assetUploadSession: (
			accountId: string,
			name: string,
			manifest: Record<string, { hash: string; size: number }>
		) =>
			call<AssetUploadSession>('POST', `${script(accountId, name)}/assets-upload-session`, {
				json: { manifest }
			}),

		/** One bucket of files, authorised by the upload session's JWT rather than
		 *  the API token. Answers with the completion JWT once every bucket is in. */
		uploadAssets: async (accountId: string, uploadJwt: string, form: FormData) =>
			(
				await call<{ jwt?: string } | null>(
					'POST',
					`/accounts/${encodeURIComponent(accountId)}/workers/assets/upload?base64=true`,
					{ form, bearer: uploadJwt }
				)
			)?.jwt ?? null,

		/** One file as raw bytes, for a session in single-upload mode (see
		 *  singleAssetUploads). Same completion rule as the batches. */
		uploadAsset: async (
			accountId: string,
			uploadJwt: string,
			hash: string,
			contentType: string,
			body: Uint8Array<ArrayBuffer>
		) =>
			(
				await call<{ jwt?: string } | null>(
					'POST',
					`/accounts/${encodeURIComponent(accountId)}/workers/assets/upload/${encodeURIComponent(hash)}`,
					{ raw: { body, contentType }, bearer: uploadJwt }
				)
			)?.jwt ?? null,

		/** Upload a version without deploying it. */
		createVersion: (accountId: string, name: string, form: FormData) =>
			call<WorkerVersion>('POST', `${script(accountId, name)}/versions?bindings_inherit=strict`, {
				form
			}),

		deploy: (accountId: string, name: string, versions: DeploymentVersion[], message: string) =>
			call<Deployment>('POST', `${script(accountId, name)}/deployments`, {
				json: { strategy: 'percentage', versions, annotations: { 'workers/message': message } }
			})
	};
}

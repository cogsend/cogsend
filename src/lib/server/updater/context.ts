import type { RequestEvent } from '@sveltejs/kit';
import { cloudflareApi } from './cloudflare-api';
import type { PackStore, UpdaterContext } from './steps';

/** The staged bundle lives in the instance's own media bucket, under a prefix
 *  nothing else reads, and is deleted when the update finishes. */
export function r2PackStore(bucket: R2Bucket): PackStore {
	return {
		async put(key, bytes) {
			await bucket.put(key, bytes, {
				httpMetadata: { contentType: 'application/octet-stream' }
			});
		},
		async get(key) {
			const object = await bucket.get(key);
			return object ? object.arrayBuffer() : null;
		},
		async delete(keys) {
			if (keys.length) await bucket.delete(keys);
		}
	};
}

/** Everything a step needs, from the request. The token comes from the body. */
export function updaterContext(
	event: Pick<RequestEvent, 'locals' | 'platform' | 'url'>,
	token: string,
	overrides: Partial<Pick<UpdaterContext, 'fetchImpl' | 'store'>> = {}
): UpdaterContext {
	const env = event.platform?.env;
	const store = overrides.store ?? (env?.MEDIA ? r2PackStore(env.MEDIA) : null);
	if (!store) throw new Error('The R2 MEDIA binding is missing');
	// Wrapped because steps call it as `ctx.fetchImpl(…)`, and workerd's fetch
	// throws "Illegal invocation" when `this` is anything but the global scope.
	const fetchImpl: typeof fetch = overrides.fetchImpl ?? ((input, init) => fetch(input, init));
	return {
		db: event.locals.db,
		api: cloudflareApi(token, { fetchImpl, budget: event.locals.budget }),
		store,
		fetchImpl,
		budget: event.locals.budget,
		host: event.url.host,
		runningVersionId: env?.CF_VERSION_METADATA?.id ?? null,
		currentVersion: __APP_VERSION__
	};
}

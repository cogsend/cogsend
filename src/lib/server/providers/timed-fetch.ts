import type { FetchLike } from './types';

/** JSON/API calls. Hung providers must fail well before STALE_CLAIM_MS reclaims the run. */
export const PROVIDER_FETCH_TIMEOUT_MS = 15_000;
/** Media byte uploads (Mastodon 16MB, LinkedIn 8MB video) need a longer budget. */
export const PROVIDER_UPLOAD_TIMEOUT_MS = 60_000;

function isUploadRequest(init?: RequestInit): boolean {
	const method = (init?.method || 'GET').toUpperCase();
	if (method === 'PUT') return true;
	const body = init?.body;
	if (body == null) return false;
	if (typeof FormData !== 'undefined' && body instanceof FormData) return true;
	if (typeof Blob !== 'undefined' && body instanceof Blob) return true;
	if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return true;
	// Bluesky and Mastodon stream a stored video straight from R2.
	if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return true;
	return false;
}

export function providerTimeoutMs(init?: RequestInit): number {
	return isUploadRequest(init) ? PROVIDER_UPLOAD_TIMEOUT_MS : PROVIDER_FETCH_TIMEOUT_MS;
}

function mergeSignals(timeoutMs: number, existing?: AbortSignal | null): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	if (!existing) return timeout;
	if (typeof AbortSignal.any === 'function') return AbortSignal.any([timeout, existing]);
	return timeout;
}

function isTimeoutError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	return err.name === 'TimeoutError' || err.name === 'AbortError';
}

export function timedFetch(timeoutMs: number): FetchLike {
	return async (input, init) => {
		const signal = mergeSignals(timeoutMs, init?.signal);
		try {
			return await fetch(input, { ...init, signal });
		} catch (err) {
			if (isTimeoutError(err)) {
				throw Object.assign(new Error('Provider request timed out'), { status: 504 });
			}
			throw err;
		}
	};
}

/** Default outbound fetch: 15s for JSON, 60s for binary, streamed, FormData and PUT uploads. */
export const providerFetch: FetchLike = (input, init) =>
	timedFetch(providerTimeoutMs(init))(input, init);

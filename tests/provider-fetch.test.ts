import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_USER_AGENT,
	PROVIDER_FETCH_TIMEOUT_MS,
	PROVIDER_UPLOAD_TIMEOUT_MS,
	providerTimeoutMs,
	timedFetch
} from '#lib/server/providers/timed-fetch.js';

describe('timedFetch', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('fails a hung request with a retryable timeout', async () => {
		vi.stubGlobal('fetch', (_input: unknown, init?: RequestInit) => {
			return new Promise((_resolve, reject) => {
				const abort = () => {
					const err = new Error('The operation was aborted');
					err.name = 'TimeoutError';
					reject(err);
				};
				if (init?.signal?.aborted) abort();
				else init?.signal?.addEventListener('abort', abort, { once: true });
			});
		});
		const run = timedFetch(20);
		await expect(run('https://example.com/api')).rejects.toMatchObject({
			message: 'Provider request timed out',
			status: 504
		});
	});

	it('returns a fast response and adds a default User-Agent without overriding an explicit one', async () => {
		const seen: Array<string | null> = [];
		vi.stubGlobal('fetch', (_input: unknown, init?: RequestInit) => {
			seen.push(new Headers(init?.headers).get('user-agent'));
			return Promise.resolve(new Response('ok'));
		});
		const run = timedFetch(200);
		const res = await run('https://example.com/api');
		expect(res.ok).toBe(true);
		expect(await res.text()).toBe('ok');
		await run('https://example.com/api', { headers: { 'User-Agent': 'Custom/1.0' } });
		expect(seen).toEqual([DEFAULT_USER_AGENT, 'Custom/1.0']);
	});

	it('gives uploads the longer limit, a streamed video included', () => {
		const stream = new ReadableStream({ start: (c) => c.close() });
		expect(providerTimeoutMs({ method: 'POST', body: stream })).toBe(PROVIDER_UPLOAD_TIMEOUT_MS);
		expect(providerTimeoutMs({ method: 'POST', body: new Uint8Array(4) })).toBe(
			PROVIDER_UPLOAD_TIMEOUT_MS
		);
		expect(providerTimeoutMs({ method: 'POST', body: new FormData() })).toBe(
			PROVIDER_UPLOAD_TIMEOUT_MS
		);
		expect(providerTimeoutMs({ method: 'PUT' })).toBe(PROVIDER_UPLOAD_TIMEOUT_MS);
		expect(providerTimeoutMs({ method: 'POST', body: '{"text":"hi"}' })).toBe(
			PROVIDER_FETCH_TIMEOUT_MS
		);
		expect(providerTimeoutMs()).toBe(PROVIDER_FETCH_TIMEOUT_MS);
	});
});

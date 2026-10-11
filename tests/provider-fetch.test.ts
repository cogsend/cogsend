import { afterEach, describe, expect, it, vi } from 'vitest';
import { timedFetch } from '#lib/server/providers/timed-fetch.js';

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

	it('returns a fast response', async () => {
		vi.stubGlobal('fetch', () => Promise.resolve(new Response('ok')));
		const run = timedFetch(200);
		const res = await run('https://example.com/api');
		expect(res.ok).toBe(true);
		expect(await res.text()).toBe('ok');
	});
});

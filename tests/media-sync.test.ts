import { describe, expect, it } from 'vitest';
import { persistMediaLayout } from '#lib/domain/media-sync.js';

type Call = { method: string; url: string; body: unknown };

function recorder(statuses: number[] = []) {
	const calls: Call[] = [];
	let i = 0;
	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url =
			typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		calls.push({
			method: init?.method ?? 'GET',
			url,
			body: init?.body ? JSON.parse(String(init.body)) : null
		});
		const status = statuses[i] ?? 200;
		i += 1;
		return new Response('{}', { status });
	}) as typeof fetch;
	return { calls, fetchImpl };
}

describe('persistMediaLayout', () => {
	it('patches segment moves and deletes removals', async () => {
		const { calls, fetchImpl } = recorder();
		const result = await persistMediaLayout({
			draftId: 'd1',
			moves: [{ id: 'm2', segmentIndex: 3 }],
			removals: ['m1'],
			fetchImpl
		});

		expect(result).toEqual({ ok: true, failed: 0 });
		expect(calls).toHaveLength(2);
		const patch = calls.find((c) => c.method === 'PATCH');
		expect(patch?.url).toBe('/api/drafts/d1/media');
		expect(patch?.body).toEqual({ mediaId: 'm2', segmentIndex: 3 });
		const del = calls.find((c) => c.method === 'DELETE');
		expect(del?.url).toBe('/api/drafts/d1/media?mediaId=m1');
	});

	it('retries a failed request once and reports success when it lands', async () => {
		// First attempt: the PATCH fails (500) while the DELETE succeeds; the
		// retry repeats the whole batch, which is safe for both verbs.
		const { calls, fetchImpl } = recorder([500, 200, 200]);
		const result = await persistMediaLayout({
			draftId: 'd1',
			moves: [{ id: 'm2', segmentIndex: 1 }],
			removals: ['m1'],
			fetchImpl,
			retryDelayMs: 0
		});

		expect(result.ok).toBe(true);
		expect(calls).toHaveLength(3);
		expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(2);
		expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
	});

	it('reports failure after the retry', async () => {
		const { calls, fetchImpl } = recorder([500, 500]);
		const result = await persistMediaLayout({
			draftId: 'd1',
			moves: [{ id: 'm2', segmentIndex: 1 }],
			fetchImpl,
			retryDelayMs: 0
		});

		expect(result).toEqual({ ok: false, failed: 1 });
		expect(calls).toHaveLength(2);
	});

	it('treats a rejected fetch as failure and retries it', async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			if (calls === 1) throw new TypeError('Failed to fetch');
			return new Response('{}', { status: 200 });
		}) as typeof fetch;

		const result = await persistMediaLayout({
			draftId: 'd1',
			moves: [{ id: 'm2', segmentIndex: 1 }],
			fetchImpl,
			retryDelayMs: 0
		});
		expect(result.ok).toBe(true);
		expect(calls).toBe(2);
	});

	it('does nothing without a draft or without changes', async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			return new Response('{}', { status: 200 });
		}) as typeof fetch;

		expect(
			await persistMediaLayout({ draftId: '', moves: [{ id: 'm', segmentIndex: 1 }], fetchImpl })
		).toEqual({ ok: true, failed: 0 });
		expect(await persistMediaLayout({ draftId: 'd1', fetchImpl })).toEqual({ ok: true, failed: 0 });
		expect(calls).toBe(0);
	});
});

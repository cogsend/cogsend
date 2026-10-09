import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CRON_STATE_SETTING, readAppSetting } from '$lib/server/app-settings';
import { checkForRelease } from '$lib/server/release';
import type { AppDb } from '$lib/server/db/client';
import { createTestDb, TEST_ENV } from '$lib/server/db/test';
import { GET as releaseGET } from '../src/routes/api/release/+server';

/**
 * The update check is a courtesy, so it must never be the reason a page or a
 * deploy breaks: every failure path stays quiet, and the answer is cached
 * because Workers share GitHub's per-address rate limit.
 */
describe('release check', () => {
	let db: AppDb;
	let close: () => void;
	const session = () => ({
		db,
		env: TEST_ENV,
		user: { id: 'u1', email: 'a@localhost', timezone: 'UTC', totpEnabled: true, mfaVerified: true }
	});

	const releaseBody = (tag: string) =>
		new Response(
			JSON.stringify({
				tag_name: tag,
				html_url: `https://github.com/cogsend/cogsend/releases/tag/${tag}`,
				published_at: '2026-09-17T06:00:00Z'
			}),
			{ status: 200, headers: { 'content-type': 'application/json' } }
		);

	beforeAll(async () => {
		({ db, close } = await createTestDb());
	});
	afterAll(() => close());

	it('reports an available update', async () => {
		const fetchImpl = vi.fn(async () => releaseBody('v9.9.9')) as unknown as typeof fetch;
		const result = await checkForRelease(db, { fetchImpl, current: '1.0.0' });
		expect(result.updateAvailable).toBe(true);
		expect(result.latest?.version).toBe('9.9.9');
		expect(result.current).toBe('1.0.0');
	});

	it('caches the answer, and refresh bypasses the cache', async () => {
		const first = vi.fn(async () => releaseBody('v9.9.9')) as unknown as typeof fetch;
		await checkForRelease(db, { fetchImpl: first, current: '1.0.0', refresh: true });
		expect(first).toHaveBeenCalledTimes(1);

		const second = vi.fn(async () => releaseBody('v9.9.9')) as unknown as typeof fetch;
		const cached = await checkForRelease(db, { fetchImpl: second, current: '1.0.0' });
		expect(second).not.toHaveBeenCalled();
		expect(cached.updateAvailable).toBe(true);

		const forced = vi.fn(async () => releaseBody('v9.9.9')) as unknown as typeof fetch;
		await checkForRelease(db, { fetchImpl: forced, current: '1.0.0', refresh: true });
		expect(forced).toHaveBeenCalledTimes(1);
	});

	it('stays quiet when GitHub fails, and does not cache it for long', async () => {
		const failing = vi.fn(
			async () => new Response('nope', { status: 500 })
		) as unknown as typeof fetch;
		const failed = await checkForRelease(db, {
			fetchImpl: failing,
			current: '1.0.0',
			refresh: true
		});
		expect(failed.latest).toBe(null);
		expect(failed.updateAvailable).toBe(false);
		expect(failed.error).toContain('500');

		// A failure is remembered briefly, so a page reload does not re-ask.
		const retry = vi.fn(async () => releaseBody('v9.9.9')) as unknown as typeof fetch;
		await checkForRelease(db, { fetchImpl: retry, current: '1.0.0' });
		expect(retry).not.toHaveBeenCalled();

		// ...but not for six hours like a real answer.
		const later = new Date(Date.now() + 60 * 60_000);
		const afterTtl = vi.fn(async () => releaseBody('v9.9.9')) as unknown as typeof fetch;
		const refreshed = await checkForRelease(db, {
			fetchImpl: afterTtl,
			current: '1.0.0',
			now: later
		});
		expect(afterTtl).toHaveBeenCalledTimes(1);
		expect(refreshed.updateAvailable).toBe(true);
	});

	it('survives a thrown fetch and a 404', async () => {
		const throwing = vi.fn(async () => {
			throw new Error('network down');
		}) as unknown as typeof fetch;
		const thrown = await checkForRelease(db, {
			fetchImpl: throwing,
			current: '1.0.0',
			refresh: true
		});
		expect(thrown.error).toContain('network down');

		const notFound = vi.fn(
			async () => new Response('', { status: 404 })
		) as unknown as typeof fetch;
		const missing = await checkForRelease(db, {
			fetchImpl: notFound,
			current: '1.0.0',
			refresh: true
		});
		expect(missing.latest).toBe(null);
		expect(missing.error).toContain('no releases');
	});

	it('serves the result to a session, and refuses an anonymous caller', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => releaseBody('v9.9.9'))
		);
		try {
			const res = (await releaseGET({
				locals: session(),
				url: new URL('https://x/api/release?refresh=1')
			} as never)) as Response;
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				current: string;
				updateAvailable: boolean;
				latest: { tag: string };
			};
			expect(body.updateAvailable).toBe(true);
			expect(body.latest.tag).toBe('v9.9.9');
			// The version this build reports comes from the vite define; a
			// pre-release build (1.13.0-rc.1) carries its suffix.
			expect(body.current).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
		} finally {
			vi.unstubAllGlobals();
		}

		const anon = (await releaseGET({
			locals: { db, user: null },
			url: new URL('https://x/api/release')
		} as never)) as Response;
		expect(anon.status).toBe(401);
	});

	it('keeps its cache key out of the other instance settings', async () => {
		expect(await readAppSetting(db, CRON_STATE_SETTING)).toBe(null);
	});
});

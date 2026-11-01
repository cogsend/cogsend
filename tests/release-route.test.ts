import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CRON_STATE_SETTING, readAppSetting } from '#lib/server/app-settings.js';
import { checkForRelease, setOfferPrereleases } from '#lib/server/release.js';
import type { AppDb } from '#lib/server/db/client.js';
import { createTestDb, TEST_ENV } from '#lib/server/db/test.js';
import { GET as releaseGET } from '../src/routes/api/release/+server';

/**
 * The update check is a courtesy, so it must never be the reason a page or a
 * deploy breaks: every failure path returns an answer with its reason, and
 * the answer is cached because Workers share GitHub's per-address rate limit.
 */
describe('release check', () => {
	let db: AppDb;
	let close: () => void;
	const session = () => ({
		db,
		env: TEST_ENV,
		user: {
			id: 'u1',
			email: 'a@localhost',
			timezone: 'UTC',
			totpEnabled: true,
			mfaVerified: true,
			role: 'admin' as const
		}
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

	/** GitHub's releases.atom, newest first, as it lists these tags. */
	const feedOf = (...tags: string[]) =>
		new Response(
			`<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">${tags
				.map(
					(tag) =>
						`<entry><id>tag:github.com,2008:Repository/1/${tag}</id><updated>2026-10-11T07:47:55Z</updated><link rel="alternate" type="text/html" href="https://github.com/cogsend/cogsend/releases/tag/${tag}"/><title>${tag}</title><content type="html">&lt;p&gt;notes&lt;/p&gt;</content></entry>`
				)
				.join('')}</feed>`,
			{ status: 200, headers: { 'content-type': 'application/atom+xml' } }
		);

	/** A fake GitHub that answers the feed and the API separately, and records
	 *  every URL it was asked for. */
	function gitHub(answers: { feed?: () => Response; api?: (url: string) => Response }) {
		const urls: string[] = [];
		const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			urls.push(url);
			if (url.endsWith('/releases.atom')) {
				return answers.feed?.() ?? new Response('unavailable', { status: 503 });
			}
			return answers.api?.(url) ?? new Response('unavailable', { status: 503 });
		}) as unknown as typeof fetch;
		return { fetchImpl, urls };
	}

	beforeAll(async () => {
		({ db, close } = await createTestDb());
	});
	afterAll(() => close());

	it('reports an available update from the releases feed, without the API', async () => {
		const { fetchImpl, urls } = gitHub({ feed: () => feedOf('v9.9.9', 'v9.9.8') });
		const result = await checkForRelease(db, { fetchImpl, current: '1.0.0', refresh: true });
		expect(result.updateAvailable).toBe(true);
		expect(result.latest).toMatchObject({
			tag: 'v9.9.9',
			version: '9.9.9',
			url: 'https://github.com/cogsend/cogsend/releases/tag/v9.9.9'
		});
		expect(result.current).toBe('1.0.0');
		expect(urls).toEqual(['https://github.com/cogsend/cogsend/releases.atom']);
	});

	it('asks the API when the feed cannot answer, as when GitHub limits the address', async () => {
		const { fetchImpl, urls } = gitHub({
			feed: () => new Response('slow down', { status: 429 }),
			api: () => releaseBody('v9.9.9')
		});
		const result = await checkForRelease(db, { fetchImpl, current: '1.0.0', refresh: true });
		expect(result.latest?.tag).toBe('v9.9.9');
		expect(urls.at(-1)).toContain('/releases/latest');
	});

	it('caches the answer, and refresh bypasses the cache', async () => {
		const first = gitHub({ feed: () => feedOf('v9.9.9') });
		await checkForRelease(db, { fetchImpl: first.fetchImpl, current: '1.0.0', refresh: true });
		expect(first.urls).toHaveLength(1);

		const second = gitHub({ feed: () => feedOf('v9.9.9') });
		const cached = await checkForRelease(db, { fetchImpl: second.fetchImpl, current: '1.0.0' });
		expect(second.urls).toEqual([]);
		expect(cached.updateAvailable).toBe(true);

		const forced = gitHub({ feed: () => feedOf('v9.9.9') });
		await checkForRelease(db, { fetchImpl: forced.fetchImpl, current: '1.0.0', refresh: true });
		expect(forced.urls).toHaveLength(1);

		// A release published since is noticed within the hour, without a click.
		const stale = gitHub({ feed: () => feedOf('v9.9.10', 'v9.9.9') });
		const nextHour = await checkForRelease(db, {
			fetchImpl: stale.fetchImpl,
			current: '1.0.0',
			now: new Date(Date.now() + 61 * 60_000)
		});
		expect(stale.urls).toHaveLength(1);
		expect(nextHour.latest?.tag).toBe('v9.9.10');
	});

	it('reports why when GitHub fails, and does not cache it for long', async () => {
		const failing = gitHub({ api: () => new Response('nope', { status: 403 }) });
		const failed = await checkForRelease(db, {
			fetchImpl: failing.fetchImpl,
			current: '1.0.0',
			refresh: true
		});
		expect(failed.latest).toBe(null);
		expect(failed.updateAvailable).toBe(false);
		expect(failed.error).toContain('403');

		// A failure is remembered briefly, so a page reload does not re-ask.
		const retry = gitHub({ feed: () => feedOf('v9.9.9') });
		await checkForRelease(db, { fetchImpl: retry.fetchImpl, current: '1.0.0' });
		expect(retry.urls).toEqual([]);

		// ...but not for the hour a real answer keeps.
		const later = new Date(Date.now() + 45 * 60_000);
		const afterTtl = gitHub({ feed: () => feedOf('v9.9.9') });
		const refreshed = await checkForRelease(db, {
			fetchImpl: afterTtl.fetchImpl,
			current: '1.0.0',
			now: later
		});
		expect(afterTtl.urls).toHaveLength(1);
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
		vi.stubGlobal('fetch', gitHub({ feed: () => feedOf('v9.9.9') }).fetchImpl);
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

	it('offers pre-releases only when the instance asks, and asks GitHub again when that changes', async () => {
		const { fetchImpl, urls } = gitHub({ feed: () => feedOf('v9.10.0-rc.2', 'v9.9.9') });

		expect(
			(await checkForRelease(db, { fetchImpl, current: '1.0.0', refresh: true })).latest?.tag
		).toBe('v9.9.9');
		await setOfferPrereleases(db, true);
		expect((await checkForRelease(db, { fetchImpl, current: '1.0.0' })).latest?.tag).toBe(
			'v9.10.0-rc.2'
		);

		// Cached in its own mode; switching back asks again instead of serving the rc.
		urls.length = 0;
		expect((await checkForRelease(db, { fetchImpl, current: '1.0.0' })).latest?.tag).toBe(
			'v9.10.0-rc.2'
		);
		expect(urls).toEqual([]);
		await setOfferPrereleases(db, false);
		expect((await checkForRelease(db, { fetchImpl, current: '1.0.0' })).latest?.tag).toBe('v9.9.9');
		expect(urls).toHaveLength(1);
	});

	it('picks pre-releases from the API too when the feed is down, drafts left out', async () => {
		const list = new Response(
			JSON.stringify([
				{ tag_name: 'v9.10.0-rc.2', html_url: 'https://x/rc2', published_at: null },
				{ tag_name: 'v9.11.0', html_url: 'https://x/draft', published_at: null, draft: true },
				{ tag_name: 'v9.9.9', html_url: 'https://x/stable', published_at: null }
			]),
			{ status: 200, headers: { 'content-type': 'application/json' } }
		);
		const { fetchImpl, urls } = gitHub({
			api: (url) => (url.endsWith('/releases/latest') ? releaseBody('v9.9.9') : list.clone())
		});
		await setOfferPrereleases(db, true);
		try {
			const withRc = await checkForRelease(db, { fetchImpl, current: '1.0.0', refresh: true });
			expect(withRc.latest?.tag).toBe('v9.10.0-rc.2');
			expect(urls.at(-1)).toContain('/releases?per_page=');
		} finally {
			await setOfferPrereleases(db, false);
		}
	});

	it('keeps its cache key out of the other instance settings', async () => {
		expect(await readAppSetting(db, CRON_STATE_SETTING)).toBe(null);
	});
});

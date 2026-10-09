/**
 * Fetching the latest release, with a cache.
 *
 * Workers share Cloudflare's egress addresses, and GitHub's unauthenticated API
 * allows 60 requests per hour *per address* — so asking on every Settings load
 * would get rate-limited by strangers' traffic. The answer is cached in
 * `app_settings`: six hours for a real answer, thirty minutes for a failure, so
 * a GitHub outage does not pin "unknown" for the rest of the day.
 *
 * Nothing here is allowed to break a page: every failure path returns a result
 * with `latest: null` and an `error` string, and the callers stay quiet.
 */
import {
	RELEASE_API_URL,
	RELEASES_API_URL,
	newestRelease,
	TAGS_API_URL,
	highestVersionTag,
	parseRelease,
	releaseCheckResult,
	type ReleaseCheck,
	type ReleaseInfo
} from '$lib/domain/release-check';
import { readAppSetting, writeAppSetting } from './app-settings';
import type { AppDb } from './db/client';

const CACHE_KEY = 'release_check';
/** '1' when Settings → Instance offers pre-releases too. */
export const OFFER_PRERELEASES_SETTING = 'offer_prereleases';
const OK_TTL_MS = 6 * 60 * 60_000;
const FAIL_TTL_MS = 30 * 60_000;
const TIMEOUT_MS = 8_000;

interface CachedRelease {
	latest: ReleaseInfo | null;
	checkedAt: string;
	error?: string;
	/** Which answer this is, so switching the setting asks GitHub again. */
	prereleases?: boolean;
}

export async function readOfferPrereleases(db: AppDb): Promise<boolean> {
	return (await readAppSetting(db, OFFER_PRERELEASES_SETTING)) === '1';
}

export async function setOfferPrereleases(db: AppDb, on: boolean): Promise<void> {
	await writeAppSetting(db, OFFER_PRERELEASES_SETTING, on ? '1' : '');
}

function parseCache(raw: string | null): CachedRelease | null {
	if (!raw) return null;
	try {
		const data = JSON.parse(raw) as CachedRelease;
		if (!data?.checkedAt) return null;
		return data;
	} catch {
		return null;
	}
}

function isFresh(cache: CachedRelease, now: number): boolean {
	const age = now - new Date(cache.checkedAt).getTime();
	if (Number.isNaN(age)) return false;
	return age < (cache.latest ? OK_TTL_MS : FAIL_TTL_MS);
}

/**
 * The latest release, from cache when it is fresh.
 *
 * `refresh` forces a fetch (the "Check now" affordance), and `fetchImpl` is for
 * tests. `current` defaults to the version this build reports.
 */
export async function checkForRelease(
	db: AppDb,
	options: { refresh?: boolean; fetchImpl?: typeof fetch; current?: string; now?: Date } = {}
): Promise<ReleaseCheck> {
	const current = options.current ?? __APP_VERSION__;
	const now = options.now ?? new Date();
	const cached = parseCache(await readAppSetting(db, CACHE_KEY));
	const prereleases = await readOfferPrereleases(db);

	if (
		cached &&
		!options.refresh &&
		(cached.prereleases ?? false) === prereleases &&
		isFresh(cached, now.getTime())
	) {
		return releaseCheckResult(current, cached.latest, cached.checkedAt, cached.error);
	}

	const doFetch = options.fetchImpl ?? fetch;
	let latest: ReleaseInfo | null = null;
	let error: string | undefined;
	try {
		const res = await doFetch(prereleases ? RELEASES_API_URL : RELEASE_API_URL, {
			headers: {
				accept: 'application/vnd.github+json',
				// GitHub rejects requests without a User-Agent.
				'user-agent': 'cogsend'
			},
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
		if (res.ok) {
			const body = await res.json().catch(() => null);
			latest = prereleases ? newestRelease(body) : parseRelease(body);
			if (!latest) error = 'GitHub returned an unexpected release document';
		} else if (res.status === 404) {
			// No published release object: fall back to tags, because a tag is
			// what a release actually marks. Still quiet if that fails too.
			const tags = await doFetch(TAGS_API_URL, {
				headers: {
					accept: 'application/vnd.github+json',
					'user-agent': 'cogsend'
				},
				signal: AbortSignal.timeout(TIMEOUT_MS)
			}).catch(() => null);
			if (tags?.ok) {
				latest = highestVersionTag(await tags.json().catch(() => null));
				if (!latest) error = 'no version tags published yet';
			} else {
				error = 'no releases or tags published yet';
			}
		} else {
			error = `GitHub answered HTTP ${res.status}`;
		}
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	}

	const checkedAt = now.toISOString();
	await writeAppSetting(
		db,
		CACHE_KEY,
		JSON.stringify({ latest, checkedAt, error, prereleases } satisfies CachedRelease)
	);
	return releaseCheckResult(current, latest, checkedAt, error);
}

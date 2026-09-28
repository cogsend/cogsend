/**
 * Instance values that are discovered or set at runtime instead of at deploy
 * time.
 *
 * The keys this module owns: the public URL (recorded from the first signed-in
 * visit, so a deployment does not have to know its own hostname before it
 * exists), the display name (set in Settings → Instance, so renaming an
 * instance is a form field rather than a redeploy), what the last deploy did
 * with the cron trigger, the tick token, the cached release check, and when the
 * scheduler's janitors last ran — see the constants below and their owners
 * (tick-token.ts, release.ts, scheduler.ts).
 *
 * Cached per database handle in module scope, for a minute at a time: a
 * deployment that pins APP_URL never reads for it, and everything else should
 * not pay a query per request. The expiry matters because a Worker runs many
 * isolates, and a write only updates the cache of the isolate that made it —
 * without one, a rename would never reach the others. The cache is keyed weakly
 * so a value cannot outlive the binding it came from (tests, hot reloads).
 * Security-relevant reads (the tick token) pass `fresh` and skip it.
 */
import { eq } from 'drizzle-orm';
import {
	parseDeployCronState,
	type DeployCronState,
	type DeployCronStatus
} from '$lib/domain/deploy-cron';
import { first, type AppDb } from './db/client';
import { appSettings } from './db/schema';
import { rawBinding } from './budget';

export const APP_URL_SETTING = 'app_url';
export const APP_NAME_SETTING = 'app_name';
/** What the last deploy did with the cron trigger. Written by
 *  `scripts/wrangler.mjs` (scripts/lib/wrangler-config.mjs), read here. */
export const CRON_STATE_SETTING = 'cron_state';

export type { DeployCronState, DeployCronStatus };

type CacheKey = object;
type CacheEntry = { value: string | null; at: number };

/** How long an isolate trusts a value it read or wrote. */
export const APP_SETTING_CACHE_MS = 60_000;

const cache = new WeakMap<CacheKey, Map<string, CacheEntry>>();

/** The drizzle handle is rebuilt per request; the D1 binding behind it is not
 *  (each request wraps it to count calls, hence the unwrap). */
function cacheKey(db: AppDb): CacheKey | null {
	const session = (db as unknown as { session?: { client?: unknown } }).session;
	const client = rawBinding(session?.client);
	return client && typeof client === 'object' ? (client as CacheKey) : null;
}

function memoFor(db: AppDb): Map<string, CacheEntry> | null {
	const key = cacheKey(db);
	if (!key) return null;
	const existing = cache.get(key);
	if (existing) return existing;
	const created = new Map<string, CacheEntry>();
	cache.set(key, created);
	return created;
}

function freshEntry(memo: Map<string, CacheEntry> | null, key: string): CacheEntry | undefined {
	const entry = memo?.get(key);
	if (!entry) return undefined;
	if (Date.now() - entry.at >= APP_SETTING_CACHE_MS) {
		memo?.delete(key);
		return undefined;
	}
	return entry;
}

/** A stored value, or null when it is missing or blank. */
export async function readAppSetting(
	db: AppDb,
	key: string,
	options: { fresh?: boolean } = {}
): Promise<string | null> {
	const memo = memoFor(db);
	if (!options.fresh) {
		const cached = freshEntry(memo, key);
		if (cached) return cached.value;
	}
	try {
		const row = await first(db.select().from(appSettings).where(eq(appSettings.key, key)));
		const value = row?.value?.trim() ? row.value : null;
		memo?.set(key, { value, at: Date.now() });
		return value;
	} catch {
		// Schema not bootstrapped yet, or an older database without the table:
		// "nothing recorded" is a valid answer, not an error.
		return null;
	}
}

/** Store a value, or clear it when blank. Best effort. */
export async function writeAppSetting(db: AppDb, key: string, value: string): Promise<void> {
	const stored = value.trim();
	const memo = memoFor(db);
	// Skipping an unchanged write is only safe while this isolate's copy is
	// recent: another isolate may have written something else since.
	if (freshEntry(memo, key)?.value === (stored || null)) return;
	memo?.set(key, { value: stored || null, at: Date.now() });
	try {
		await db
			.insert(appSettings)
			.values({ key, value: stored, updatedAt: new Date() })
			.onConflictDoUpdate({
				target: appSettings.key,
				set: { value: stored, updatedAt: new Date() }
			});
	} catch {
		// Non-fatal, and not remembered: the next request retries the write.
		memo?.delete(key);
	}
}

/** The remembered origin, or null when nothing has been recorded yet. */
export function readStoredAppUrl(db: AppDb): Promise<string | null> {
	return readAppSetting(db, APP_URL_SETTING);
}

/** Record the origin the instance is actually served from. */
export function rememberAppUrl(db: AppDb, url: string): Promise<void> {
	if (!url) return Promise.resolve();
	return writeAppSetting(db, APP_URL_SETTING, url);
}

/** The instance name set in Settings → Instance, or null for the default. */
export function readStoredAppName(db: AppDb): Promise<string | null> {
	return readAppSetting(db, APP_NAME_SETTING);
}

/** Store the instance name; a blank value falls back to the default. */
export function rememberAppName(db: AppDb, name: string): Promise<void> {
	return writeAppSetting(db, APP_NAME_SETTING, name);
}

/**
 * What the last deploy recorded about the cron trigger.
 *
 * Deliberately uncached and never throwing: it is diagnostic text for the
 * Settings page and `npm run doctor`, and a database that predates the table
 * (or the feature) simply has nothing to say.
 */
export async function readDeployCronState(db: AppDb): Promise<DeployCronState | null> {
	try {
		const row = await first(
			db.select().from(appSettings).where(eq(appSettings.key, CRON_STATE_SETTING))
		);
		const parsed = parseDeployCronState(row?.value);
		if (!parsed) return null;
		return { ...parsed, updatedAt: row?.updatedAt ?? null };
	} catch {
		return null;
	}
}

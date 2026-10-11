import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import {
	ALL_SCOPES,
	normalizeApiScopes,
	parseApiScopes,
	type ApiScope
} from '#lib/domain/api-scopes.js';
import { bytesToHex, randomHex, utf8Bytes } from '#lib/domain/bytes.js';
import { first, newId, type AppDb } from './db/client';
import { apiKeys } from './db/schema';

/** Raw keys look like `cog_<64 hex>` (256 bits). The 12-char prefix
 *  (`cog_` + 6 hex) is stored alongside the hash for display only. */
export const API_KEY_PREFIX = 'cog_';
const RAW_HEX_LEN = 64;

export function isApiKeyFormat(raw: string | null | undefined): raw is string {
	if (!raw?.startsWith(API_KEY_PREFIX)) return false;
	const hex = raw.slice(API_KEY_PREFIX.length);
	return hex.length === RAW_HEX_LEN && /^[0-9a-fA-F]+$/.test(hex);
}

// Domain-separated hash (`apikey:`) so a key hash can never collide with
// session (`session:`), MFA (`mfa:`) or other HMAC/hash domains even if raw
// values repeat. Lookup is exact-match on the hash — the same pattern as
// sessions/mfa_challenges — so the 256-bit entropy is the brute-force defense.
export async function hashApiKey(raw: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', utf8Bytes(`apikey:${raw}`) as BufferSource);
	return bytesToHex(new Uint8Array(digest));
}

export type ApiKeyRow = typeof apiKeys.$inferSelect;

export async function getActiveApiKey(db: AppDb, userId: string): Promise<ApiKeyRow | null> {
	return (
		(await first(
			db
				.select()
				.from(apiKeys)
				.where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
				.orderBy(desc(apiKeys.createdAt))
				.limit(1)
		)) ?? null
	);
}

/** Mint a replacement key. The new row is inserted BEFORE old rows are
 *  revoked, so an insert failure keeps the previous key working instead of
 *  leaving the user keyless. Returns the raw key — shown once, never stored. */
export async function rotateApiKey(
	db: AppDb,
	userId: string,
	scopes: unknown = ALL_SCOPES
): Promise<{ raw: string; prefix: string; createdAt: Date; scopes: ApiScope[] }> {
	const raw = `${API_KEY_PREFIX}${randomHex(32)}`;
	const now = new Date();
	const id = newId();
	const finalScopes = normalizeApiScopes(scopes);
	await db.insert(apiKeys).values({
		id,
		userId,
		keyHash: await hashApiKey(raw),
		prefix: raw.slice(0, 12),
		scopes: JSON.stringify(finalScopes),
		createdAt: now,
		lastUsedAt: null,
		revokedAt: null
	});
	await db
		.update(apiKeys)
		.set({ revokedAt: now })
		.where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt), ne(apiKeys.id, id)));
	return { raw, prefix: raw.slice(0, 12), createdAt: now, scopes: finalScopes };
}

export async function revokeApiKeys(db: AppDb, userId: string): Promise<number> {
	const active = await db
		.select({ id: apiKeys.id })
		.from(apiKeys)
		.where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)));
	if (active.length === 0) return 0;
	await db
		.update(apiKeys)
		.set({ revokedAt: new Date() })
		.where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)));
	return active.length;
}

export async function verifyApiKey(
	db: AppDb,
	raw: string | null | undefined
): Promise<{ keyId: string; userId: string; scopes: ApiScope[] } | null> {
	// Format gate first: no hashing and no DB query for values that can
	// never be a key (wrong prefix, wrong length, non-hex).
	if (!isApiKeyFormat(raw)) return null;
	const row = await first(
		db
			.select({ keyId: apiKeys.id, userId: apiKeys.userId, scopes: apiKeys.scopes })
			.from(apiKeys)
			.where(and(eq(apiKeys.keyHash, await hashApiKey(raw)), isNull(apiKeys.revokedAt)))
	);
	if (!row) return null;
	return { keyId: row.keyId, userId: row.userId, scopes: parseApiScopes(row.scopes) };
}

/** Best-effort `last_used_at` touch. Never throws — key metadata must not
 *  break request handling. Callers should prefer `locals.waitUntil`. */
export function touchApiKey(db: AppDb, keyId: string): Promise<void> {
	return (async () => {
		try {
			await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, keyId));
		} catch {
			// metadata only; ignore
		}
	})();
}

import { and, desc, eq, ne } from 'drizzle-orm';
import type { PlatformId } from '#lib/domain/platforms.js';
import { fromZernioPlatform, isZernioConnection } from '#lib/domain/zernio.js';
import { decryptJson, encryptJson } from './crypto';
import { newId, parseJson, type AppDb } from './db/client';
import { connections } from './db/schema';
import type { AppEnv } from './env';
import { fail } from './http';
import { ProviderError, type ConnectionCredentials } from './providers/types';
import {
	isZernioAccountDead,
	zernioApiMessage,
	zernioProfileId,
	type ZernioAccount
} from './zernio';

export interface ImportableAccount {
	id: string;
	platform: PlatformId;
	profileId: string;
	handle: string | null;
	displayName: string | null;
	avatarUrl: string | null;
	needsReconnection: boolean;
	imported: boolean;
}

function handleOf(account: ZernioAccount): string | null {
	const handle = (account.username ?? '').replace(/^@/, '').trim();
	return handle || null;
}

export function toImportable(
	account: ZernioAccount,
	importedIds: Set<string>
): ImportableAccount | null {
	const platform = fromZernioPlatform(account.platform);
	if (!platform || account.enabled === false) return null;
	const handle = handleOf(account);
	return {
		id: account._id,
		platform,
		profileId: zernioProfileId(account),
		handle,
		displayName: account.displayName?.trim() || handle,
		avatarUrl: account.profilePicture || null,
		needsReconnection: isZernioAccountDead(account),
		imported: importedIds.has(account._id)
	};
}

export async function zernioConnectionRows(opts: { db: AppDb; userId: string }) {
	const rows = await opts.db
		.select()
		.from(connections)
		.where(and(eq(connections.userId, opts.userId), ne(connections.status, 'disconnected')))
		.orderBy(desc(connections.updatedAt));
	return rows.filter((row) => isZernioConnection(row.metaJson));
}

/** The key on the most recently touched Zernio row, so it is pasted once. */
export async function storedZernioKey(opts: {
	db: AppDb;
	env: AppEnv;
	userId: string;
}): Promise<string | null> {
	for (const row of await zernioConnectionRows(opts)) {
		if (!row.credentialsEncrypted) continue;
		try {
			const creds = await decryptJson<ConnectionCredentials>(
				row.credentialsEncrypted,
				opts.env.APP_ENCRYPTION_KEY
			);
			if (creds.zernioApiKey) return creds.zernioApiKey;
		} catch {
			// A row encrypted under an older key is not a reason to fail the
			// dialog; the next row may still carry a usable one.
		}
	}
	return null;
}

export async function resolveZernioKey(opts: {
	db: AppDb;
	env: AppEnv;
	userId: string;
	apiKey?: unknown;
}): Promise<string> {
	const given = typeof opts.apiKey === 'string' ? opts.apiKey.trim() : '';
	if (given) return given;
	const stored = await storedZernioKey(opts);
	if (stored) return stored;
	throw Object.assign(new Error('A Zernio API key is required'), { status: 400 });
}

export async function upsertZernioConnection(opts: {
	db: AppDb;
	env: AppEnv;
	userId: string;
	apiKey: string;
	account: ZernioAccount;
}) {
	const { db, env, userId, apiKey, account } = opts;
	const platform = fromZernioPlatform(account.platform);
	if (!platform) {
		throw Object.assign(new Error(`Unsupported platform ${account.platform}`), { status: 400 });
	}
	const handle = handleOf(account);
	const now = new Date();
	const data = {
		displayName: account.displayName?.trim() || handle,
		handle,
		avatarUrl: account.profilePicture || null,
		credentialsEncrypted: await encryptJson(
			{ zernioApiKey: apiKey, zernioAccountId: account._id },
			env.APP_ENCRYPTION_KEY
		),
		metaJson: JSON.stringify({
			provider: 'zernio',
			zernioAccountId: account._id,
			zernioProfileId: zernioProfileId(account)
		}),
		status: isZernioAccountDead(account) ? 'expired' : 'active',
		updatedAt: now
	};
	// Only rows that are already Zernio-backed are candidates, matched on the
	// Zernio account id alone: a direct connection to the same handle is a
	// different credential and must never be overwritten by an import.
	const existing = (
		await db
			.select()
			.from(connections)
			.where(and(eq(connections.userId, userId), eq(connections.platform, platform)))
	).find(
		(row) =>
			isZernioConnection(row.metaJson) &&
			parseJson<{ zernioAccountId?: string }>(row.metaJson, {}).zernioAccountId === account._id
	);
	if (existing) {
		return (
			await db.update(connections).set(data).where(eq(connections.id, existing.id)).returning()
		)[0];
	}
	return (
		await db
			.insert(connections)
			.values({ id: newId(), userId, platform, ...data, createdAt: now })
			.returning()
	)[0];
}

/**
 * A key the dialog can act on gets a sentence, not a status code: `humanizeError`
 * reads "401" as a dead account and "403" as a refused post, which is the wrong
 * advice for someone pasting a key.
 */
export function zernioKeyProblem(err: unknown): Response | null {
	if (!(err instanceof ProviderError)) return null;
	if (err.code === 'auth') return fail('Zernio rejected this API key', 400);
	if (err.status === 403) {
		return fail(`This Zernio API key cannot be used here: ${zernioApiMessage(err)}`, 400);
	}
	return null;
}

export function zernioCallbackUrl(appUrl: string, boundState: string): string {
	const url = new URL('/api/connections/zernio/callback', appUrl.replace(/\/+$/, '') + '/');
	url.searchParams.set('pending', boundState);
	return url.toString();
}

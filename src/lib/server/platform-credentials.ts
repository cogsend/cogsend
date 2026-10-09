/**
 * OAuth app credentials for LinkedIn, Threads and X, from either of two places:
 * Worker secrets, or the form in the accounts dialog, which stores them in D1
 * encrypted with APP_ENCRYPTION_KEY (the same protection as the account tokens
 * they lead to).
 *
 * Worker secrets win for a platform whenever its required ones are all set, so
 * a deployment configured from the terminal keeps behaving exactly as before
 * and the dialog cannot override it.
 *
 * These keys bypass the app-settings cache on purpose: a value saved in one
 * isolate has to be visible to the connect request that follows it, which may
 * land on another.
 */
import { like, eq } from 'drizzle-orm';
import {
	PLATFORM_SETUP,
	platformConfigured,
	platformSecretNames,
	type OAuthPlatformId,
	type PlatformConfigured
} from '$lib/domain/platform-setup';
import { decryptJson, encryptJson } from './crypto';
import { first, type AppDb } from './db/client';
import { appSettings } from './db/schema';
import type { AppEnv } from './env';

export type CredentialSource = 'env' | 'app';

export type PlatformCredentials = {
	/** Keyed by secret name (`X_CLIENT_ID`), whichever source they came from. */
	values: Record<string, string>;
	source: CredentialSource;
};

const KEY_PREFIX = 'oauth_app:';

export function platformAppSettingKey(id: OAuthPlatformId): string {
	return `${KEY_PREFIX}${id}`;
}

const PLATFORM_IDS = Object.keys(PLATFORM_SETUP) as OAuthPlatformId[];

function envValues(env: AppEnv, id: OAuthPlatformId): Record<string, string> {
	const values: Record<string, string> = {};
	for (const name of platformSecretNames(id)) {
		const value = (env as unknown as Record<string, unknown>)[name];
		if (typeof value === 'string' && value.length > 0) values[name] = value;
	}
	return values;
}

function hasRequired(id: OAuthPlatformId, values: Record<string, string>): boolean {
	return PLATFORM_SETUP[id].secrets.every((name) => Boolean(values[name]));
}

/** Only the names this platform reads, so a stored blob cannot smuggle in
 *  anything else. */
function pickSecrets(id: OAuthPlatformId, raw: unknown): Record<string, string> {
	const values: Record<string, string> = {};
	if (!raw || typeof raw !== 'object') return values;
	for (const name of platformSecretNames(id)) {
		const value = (raw as Record<string, unknown>)[name];
		if (typeof value === 'string' && value.trim()) values[name] = value.trim();
	}
	return values;
}

async function decryptStored(
	id: OAuthPlatformId,
	ciphertext: string | null | undefined,
	env: AppEnv
): Promise<Record<string, string>> {
	if (!ciphertext?.trim()) return {};
	try {
		return pickSecrets(id, await decryptJson<unknown>(ciphertext, env.APP_ENCRYPTION_KEY));
	} catch {
		// Written under a different APP_ENCRYPTION_KEY: unusable, and the dialog
		// asks for the credentials again rather than failing the page.
		console.error(`[platform-credentials] could not decrypt the stored ${id} app credentials`);
		return {};
	}
}

/** What the dialog saved for the platform, or an empty record. */
async function storedValues(
	db: AppDb,
	env: AppEnv,
	id: OAuthPlatformId
): Promise<Record<string, string>> {
	try {
		const row = await first(
			db
				.select()
				.from(appSettings)
				.where(eq(appSettings.key, platformAppSettingKey(id)))
		);
		return decryptStored(id, row?.value, env);
	} catch {
		// No app_settings table yet: nothing stored is the right answer.
		return {};
	}
}

/** Worker secrets first, then the dialog's: the rule for every lookup. */
function resolve(
	id: OAuthPlatformId,
	fromEnv: Record<string, string>,
	fromApp: Record<string, string>
): PlatformCredentials | null {
	if (hasRequired(id, fromEnv)) return { values: fromEnv, source: 'env' };
	if (hasRequired(id, fromApp)) return { values: fromApp, source: 'app' };
	return null;
}

/** The credentials a connect request should use, or null when there are none. */
export async function resolvePlatformCredentials(
	db: AppDb,
	env: AppEnv,
	id: OAuthPlatformId
): Promise<PlatformCredentials | null> {
	const fromEnv = envValues(env, id);
	if (hasRequired(id, fromEnv)) return { values: fromEnv, source: 'env' };
	const fromApp = await storedValues(db, env, id);
	return hasRequired(id, fromApp) ? { values: fromApp, source: 'app' } : null;
}

export type PlatformCredentialStatus = {
	configured: PlatformConfigured;
	/** Per secret name: available from the source that will be used, or, for a
	 *  platform with no complete source, from either one. */
	secrets: Record<string, boolean>;
	/** Where each configured platform's credentials come from. */
	sources: Record<OAuthPlatformId, CredentialSource | null>;
	/** For credentials saved in the dialog, the client id's last four
	 *  characters: enough to tell which app is saved, never a secret. */
	savedClientIds: Record<OAuthPlatformId, string | null>;
};

/** Every platform at once, for the accounts page: one query, no secret values. */
export async function platformCredentialStatus(
	db: AppDb,
	env: AppEnv
): Promise<PlatformCredentialStatus> {
	let rows: Array<{ key: string; value: string }>;
	try {
		rows = await db
			.select({ key: appSettings.key, value: appSettings.value })
			.from(appSettings)
			.where(like(appSettings.key, `${KEY_PREFIX}%`));
	} catch {
		rows = [];
	}
	const stored = new Map(rows.map((row) => [row.key, row.value]));
	const secrets: Record<string, boolean> = {};
	const sources = {} as Record<OAuthPlatformId, CredentialSource | null>;
	const configured = {} as PlatformConfigured;
	const savedClientIds = {} as Record<OAuthPlatformId, string | null>;
	for (const id of PLATFORM_IDS) {
		const fromEnv = envValues(env, id);
		const fromApp = await decryptStored(id, stored.get(platformAppSettingKey(id)), env);
		const winner = resolve(id, fromEnv, fromApp);
		sources[id] = winner?.source ?? null;
		const savedId = fromApp[PLATFORM_SETUP[id].secrets[0]];
		savedClientIds[id] = savedId ? savedId.slice(-4) : null;
		for (const name of platformSecretNames(id)) {
			secrets[name] = winner
				? Boolean(winner.values[name])
				: Boolean(fromEnv[name] || fromApp[name]);
		}
		configured[id] = platformConfigured(id, secrets);
	}
	return { configured, secrets, sources, savedClientIds };
}

/** True when Worker secrets already configure the platform, which the dialog's
 *  form must not shadow. */
export function configuredByEnv(env: AppEnv, id: OAuthPlatformId): boolean {
	return hasRequired(id, envValues(env, id));
}

/**
 * Save the dialog's credentials. Required values must all be present; an
 * optional one left empty is simply not stored. Throws on a database error,
 * unlike the best-effort app settings, because "saved" must mean saved.
 */
export async function savePlatformCredentials(
	db: AppDb,
	env: AppEnv,
	id: OAuthPlatformId,
	input: Record<string, unknown>
): Promise<void> {
	const values = pickSecrets(id, input);
	const missing = PLATFORM_SETUP[id].secrets.filter((name) => !values[name]);
	if (missing.length) throw new Error(`Missing ${missing.join(', ')}`);
	const value = await encryptJson(values, env.APP_ENCRYPTION_KEY);
	const now = new Date();
	await db
		.insert(appSettings)
		.values({ key: platformAppSettingKey(id), value, updatedAt: now })
		.onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: now } });
}

export async function deletePlatformCredentials(db: AppDb, id: OAuthPlatformId): Promise<void> {
	await db.delete(appSettings).where(eq(appSettings.key, platformAppSettingKey(id)));
}

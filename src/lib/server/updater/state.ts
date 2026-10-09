/**
 * What the in-app updater remembers between its steps, in `app_settings`.
 *
 * The job, target and previous version are not secret: the bindings are the
 * ones Cloudflare lists for the serving version, which carry no secret values,
 * and the upload-session JWTs only authorise uploading this release's files to
 * this Worker, and expire within the hour. The API token reaches storage only
 * when the operator asks it to be remembered, and then only locked (see
 * ./saved-token.ts).
 *
 * Read fresh every time, bypassing the app-settings cache: two steps of one
 * update can land on different isolates.
 */
import { eq } from 'drizzle-orm';
import type { ApiBinding } from '$lib/domain/update-manifest';
import { first, type AppDb } from '../db/client';
import { appSettings } from '../db/schema';

export const UPDATE_TARGET_SETTING = 'update_target';
export const UPDATE_JOB_SETTING = 'update_job';
export const UPDATE_PREVIOUS_SETTING = 'update_previous';
export const UPDATE_TOKEN_SAVED_SETTING = 'update_token_saved';
export const UPDATE_TOKEN_UNLOCKED_SETTING = 'update_token_unlocked';

/** An upload session's JWT lasts an hour; a job older than that cannot finish. */
export const UPDATE_JOB_TTL_MS = 55 * 60_000;

export type UpdateTarget = { accountId: string; scriptName: string };

export type UpdatePhase = 'prepared' | 'assets' | 'uploaded' | 'staged';

export type UpdateJob = {
	tag: string;
	version: string;
	accountId: string;
	scriptName: string;
	/** The version serving when the update began: what a rollback returns to. */
	previousVersionId: string;
	/** The serving version's bindings as Cloudflare lists them (no secret values). */
	bindings: ApiBinding[];
	startedAt: number;
	phase: UpdatePhase;
	uploadJwt?: string;
	/** The session asked for one raw file per request (singleAssetUploads). */
	singleUploads?: boolean;
	buckets?: string[][];
	completionJwt?: string;
	newVersionId?: string;
};

export type UpdatePrevious = {
	versionId: string;
	/** The version the update installed. Roll back applies only while it still
	 *  serves: a deploy since then (a checkout, Workers Builds, the dashboard)
	 *  makes returning to `versionId` skip over that deploy. */
	installedVersionId?: string;
	/** The release that version runs, for the Roll back button's label. */
	version: string;
	replacedBy: string;
	schemaChange: boolean;
	at: number;
};

async function read<T>(db: AppDb, key: string): Promise<T | null> {
	try {
		const row = await first(db.select().from(appSettings).where(eq(appSettings.key, key)));
		return row?.value ? (JSON.parse(row.value) as T) : null;
	} catch {
		return null;
	}
}

async function write(db: AppDb, key: string, value: unknown): Promise<void> {
	const now = new Date();
	const text = JSON.stringify(value);
	await db
		.insert(appSettings)
		.values({ key, value: text, updatedAt: now })
		.onConflictDoUpdate({ target: appSettings.key, set: { value: text, updatedAt: now } });
}

async function clear(db: AppDb, key: string): Promise<void> {
	await db.delete(appSettings).where(eq(appSettings.key, key));
}

export const readTarget = (db: AppDb) => read<UpdateTarget>(db, UPDATE_TARGET_SETTING);
export const writeTarget = (db: AppDb, target: UpdateTarget) =>
	write(db, UPDATE_TARGET_SETTING, target);

export const readJob = (db: AppDb) => read<UpdateJob>(db, UPDATE_JOB_SETTING);
export const writeJob = (db: AppDb, job: UpdateJob) => write(db, UPDATE_JOB_SETTING, job);
export const clearJob = (db: AppDb) => clear(db, UPDATE_JOB_SETTING);

export const readPrevious = (db: AppDb) => read<UpdatePrevious>(db, UPDATE_PREVIOUS_SETTING);
export const writePrevious = (db: AppDb, previous: UpdatePrevious) =>
	write(db, UPDATE_PREVIOUS_SETTING, previous);
export const clearPrevious = (db: AppDb) => clear(db, UPDATE_PREVIOUS_SETTING);

export function jobExpired(job: UpdateJob, now = Date.now()): boolean {
	return now - job.startedAt > UPDATE_JOB_TTL_MS;
}

/** The remembered token, locked with a key derived from the account password. */
export type SavedToken = { salt: string; payload: string; hint: string; savedAt: number };

/** The token for one update, re-locked with a key only the browser holds. */
export type UnlockedToken = { payload: string; expiresAt: number };

export const readSavedToken = (db: AppDb) => read<SavedToken>(db, UPDATE_TOKEN_SAVED_SETTING);
export const writeSavedToken = (db: AppDb, saved: SavedToken) =>
	write(db, UPDATE_TOKEN_SAVED_SETTING, saved);
export const readUnlockedToken = (db: AppDb) =>
	read<UnlockedToken>(db, UPDATE_TOKEN_UNLOCKED_SETTING);
export const writeUnlockedToken = (db: AppDb, unlocked: UnlockedToken) =>
	write(db, UPDATE_TOKEN_UNLOCKED_SETTING, unlocked);
export async function clearSavedToken(db: AppDb): Promise<void> {
	await clear(db, UPDATE_TOKEN_SAVED_SETTING);
	await clear(db, UPDATE_TOKEN_UNLOCKED_SETTING);
}

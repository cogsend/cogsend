/**
 * Remembering the Cloudflare token between updates, locked with the account
 * password.
 *
 * The saved copy is encrypted with a key derived from the password
 * (passwordKeyHex), not from APP_ENCRYPTION_KEY: the token may edit every
 * Worker on the account, so a leak of D1 and that key together must not hand
 * it over. Callers verify the password first; a password that verifies but
 * cannot open the copy means it was locked with an earlier password (a reset
 * from the terminal), and the copy is dropped.
 *
 * To update, the operator unlocks it once. The token is then re-locked for
 * that update with a random key that only the browser receives, and each step
 * sends that key instead of the token: the steps stay cheap (no password
 * derivation per request), and the token itself never reaches the browser.
 * That copy is deleted when the update is installed, rolled back or cancelled.
 */
import { bytesToBase64, base64ToBytes, bytesToHex, randomBytes } from '$lib/domain/bytes';
import { decryptSecret, encryptSecret, passwordKeyHex } from '../crypto';
import type { AppDb } from '../db/client';
import {
	UPDATE_JOB_TTL_MS,
	clearSavedToken,
	clearUnlockedToken,
	readSavedToken,
	readUnlockedToken,
	writeSavedToken,
	writeUnlockedToken
} from './state';

const UNLOCK_KEY = /^[0-9a-f]{64}$/;

export class SavedTokenError extends Error {
	constructor(
		message: string,
		readonly status = 409
	) {
		super(message);
	}
}

/** What Settings may show about the saved token: never the token. */
export async function savedTokenStatus(db: AppDb) {
	const saved = await readSavedToken(db);
	return saved ? { hint: saved.hint, savedAt: saved.savedAt } : null;
}

/** Lock and keep `token`. The password must already be verified. */
export async function saveToken(db: AppDb, token: string, password: string, now = Date.now()) {
	const salt = randomBytes(16);
	const payload = await encryptSecret(token, await passwordKeyHex(password, salt));
	await writeSavedToken(db, {
		salt: bytesToBase64(salt),
		payload,
		hint: token.slice(-4),
		savedAt: now
	});
	return { hint: token.slice(-4), savedAt: now };
}

/**
 * Open the saved token with the (already verified) password and re-lock it for
 * one update. Returns the key the browser sends with each step.
 */
export async function unlockToken(db: AppDb, password: string, now = Date.now()) {
	const saved = await readSavedToken(db);
	if (!saved) throw new SavedTokenError('No Cloudflare token is saved: paste one');
	let token: string;
	try {
		token = await decryptSecret(
			saved.payload,
			await passwordKeyHex(password, base64ToBytes(saved.salt))
		);
	} catch {
		await clearSavedToken(db);
		throw new SavedTokenError(
			'The saved token was locked with an earlier password, so it is gone: paste the token once more'
		);
	}
	const key = bytesToHex(randomBytes(32));
	await writeUnlockedToken(db, {
		payload: await encryptSecret(token, key),
		expiresAt: now + UPDATE_JOB_TTL_MS
	});
	return key;
}

/** The token for a step that sent the key `unlockToken` handed out. */
export async function tokenFromUnlockKey(db: AppDb, key: string, now = Date.now()) {
	const expired = new SavedTokenError('Enter your password again to continue the update', 401);
	if (!UNLOCK_KEY.test(key)) throw expired;
	const unlocked = await readUnlockedToken(db);
	if (!unlocked) throw expired;
	if (unlocked.expiresAt < now) {
		await clearUnlockedToken(db);
		throw expired;
	}
	try {
		return await decryptSecret(unlocked.payload, key);
	} catch {
		throw expired;
	}
}

export { clearSavedToken as forgetToken };

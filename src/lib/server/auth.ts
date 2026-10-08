import { and, eq, lt, ne } from 'drizzle-orm';
import {
	isSessionIdle,
	nextSessionExpiry,
	sessionMaxAgeSeconds,
	shouldSlideSession,
	shouldTouchSeen,
	shouldUseSecureCookie
} from '$lib/domain/session-cookie';
import { randomHex } from '$lib/domain/bytes';
import { parseProfileSettings } from '$lib/domain/profile-settings';
import { hmacHex, verifyPassword } from './crypto';
import { first, newId, type AppDb } from './db/client';
import { sessions, users } from './db/schema';
import type { AppEnv } from './env';

export const SESSION_COOKIE = 'cog_session';

export type SessionUser = {
	id: string;
	email: string;
	timezone: string;
	totpEnabled: boolean;
	mfaVerified: boolean;
	/** Filled by the session read. Omitted on hand-built callers (tests, machine stubs). */
	displayName?: string | null;
	profilePictureUrl?: string;
};

export function isFullyVerified(user: SessionUser | null): boolean {
	return Boolean(user && user.totpEnabled && user.mfaVerified);
}

/** Session-shaped admin for Bearer API_TOKEN requests. Does not change the D1 user row. */
export function asMachineUser(admin: {
	id: string;
	email: string;
	timezone: string;
	displayName?: string | null;
	settingsJson?: string | null;
}): SessionUser {
	return {
		id: admin.id,
		email: admin.email,
		timezone: admin.timezone,
		totpEnabled: true,
		mfaVerified: true,
		displayName: admin.displayName ?? null,
		profilePictureUrl: parseProfileSettings(admin.settingsJson).profilePictureUrl
	};
}

export function needsTotpEnroll(user: SessionUser | null): boolean {
	return Boolean(user && !user.totpEnabled);
}

// Domain-separated HMAC: session tokens live in the `session:` domain so a
// token hash can never collide with MFA (`mfa:`), backup (`backup:`) or
// OAuth-state (`oauth-state:`) hashes even if raw values repeat. Lockout
// counters (auth-gate.ts) also hash through here, as `session:gate:…`: their
// input is never a random token, and they live in their own rows.
// NOTE: this invalidates sessions minted before the prefix was added — users
// sign in again once after deploy.
export async function hashToken(raw: string, secret: string): Promise<string> {
	return hmacHex(secret, `session:${raw}`);
}

/**
 * Binds a session to the password that minted it: changing the password
 * invalidates every outstanding session on next use, instead of leaving it alive
 * until it expires. The `hash:` label keeps this derivation distinct from the
 * other HMAC domains in this file. Never logged.
 */
export async function passwordFingerprint(
	env: AppEnv,
	passwordHash?: string | null
): Promise<string> {
	return hmacHex(env.AUTH_SECRET, `pwd-fp:hash:${passwordHash ?? ''}`);
}

/** True while the instance has no account at all: before `npm run setup` wrote
 *  one into D1, or the login page's claim form (api/auth/claim) created it. */
export async function needsSetup(db: AppDb): Promise<boolean> {
	const row = await first(db.select({ id: users.id }).from(users).limit(1));
	return !row;
}

/** The single account, or null before `npm run setup` created it. */
export async function getAdminUser(db: AppDb) {
	return (await first(db.select().from(users).limit(1))) ?? null;
}

export async function createSession(
	db: AppDb,
	env: AppEnv,
	userId: string,
	remember = true,
	mfaVerified = false,
	passwordHash?: string | null
): Promise<{ raw: string; maxAge: number }> {
	const raw = randomHex(32);
	const token = await hashToken(raw, env.AUTH_SECRET);
	const maxAge = sessionMaxAgeSeconds(remember);
	const now = new Date();
	await db.insert(sessions).values({
		id: newId(),
		token,
		userId,
		expiresAt: nextSessionExpiry(now, maxAge),
		remember,
		mfaVerified,
		createdAt: now,
		pwdFp: await passwordFingerprint(env, passwordHash),
		lastSeenAt: now
	});
	return { raw, maxAge };
}

export async function revokeOtherSessions(db: AppDb, userId: string, keepSessionId?: string) {
	if (keepSessionId) {
		await db
			.delete(sessions)
			.where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)));
		return;
	}
	await db.delete(sessions).where(eq(sessions.userId, userId));
}

export async function destroySession(db: AppDb, env: AppEnv, rawToken: string | undefined) {
	if (!rawToken) return;
	const token = await hashToken(rawToken, env.AUTH_SECRET);
	await db.delete(sessions).where(eq(sessions.token, token));
}

export function cookieSecureFlag(env: AppEnv, requestHost?: string): boolean {
	return shouldUseSecureCookie({
		isProduction: import.meta.env.PROD,
		appUrl: env.APP_URL,
		requestHost
	});
}

export async function getSessionUser(
	db: AppDb,
	env: AppEnv,
	rawToken: string | undefined
): Promise<{ user: SessionUser; slideMaxAge?: number } | null> {
	if (!rawToken) return null;
	const token = await hashToken(rawToken, env.AUTH_SECRET);
	const row = await first(
		db
			.select({
				sessionId: sessions.id,
				expiresAt: sessions.expiresAt,
				remember: sessions.remember,
				pwdFp: sessions.pwdFp,
				lastSeenAt: sessions.lastSeenAt,
				userId: users.id,
				email: users.email,
				timezone: users.timezone,
				totpEnabled: users.totpEnabled,
				mfaVerified: sessions.mfaVerified,
				passwordHash: users.passwordHash,
				displayName: users.displayName,
				settingsJson: users.settingsJson
			})
			.from(sessions)
			.innerJoin(users, eq(sessions.userId, users.id))
			.where(eq(sessions.token, token))
	);

	if (!row) return null;
	const now = new Date();
	if (row.expiresAt < now) {
		await db.delete(sessions).where(eq(sessions.id, row.sessionId));
		return null;
	}
	// Password rotation kills outstanding sessions. A NULL fingerprint predates
	// the column, so there is nothing to compare against — reject it instead of
	// backfilling, which would let a pre-migration session outlive a password
	// change. (Deploying this signs those sessions out once.)
	const fp = await passwordFingerprint(env, row.passwordHash);
	if (!row.pwdFp || row.pwdFp !== fp) {
		await db.delete(sessions).where(eq(sessions.id, row.sessionId));
		return null;
	}
	if (isSessionIdle(row.lastSeenAt, now, Boolean(row.remember))) {
		await db.delete(sessions).where(eq(sessions.id, row.sessionId));
		return null;
	}

	const user: SessionUser = {
		id: row.userId,
		email: row.email,
		timezone: row.timezone,
		totpEnabled: Boolean(row.totpEnabled),
		mfaVerified: Boolean(row.mfaVerified),
		displayName: row.displayName ?? null,
		profilePictureUrl: parseProfileSettings(row.settingsJson).profilePictureUrl
	};
	const maxAge = sessionMaxAgeSeconds(row.remember);
	// Throttle lastSeenAt writes. Rows without one were rejected above.
	const touch = shouldTouchSeen(row.lastSeenAt, now);
	if (shouldSlideSession(row.expiresAt, now, maxAge)) {
		await db
			.update(sessions)
			.set({
				expiresAt: nextSessionExpiry(now, maxAge),
				...(touch ? { pwdFp: fp, lastSeenAt: now } : {})
			})
			.where(eq(sessions.id, row.sessionId));
		return { user, slideMaxAge: maxAge };
	}
	if (touch) {
		await db
			.update(sessions)
			.set({ pwdFp: fp, lastSeenAt: now })
			.where(eq(sessions.id, row.sessionId));
	}
	return { user };
}

export async function authenticatePassword(db: AppDb, email: string, password: string) {
	// The row is the account. Emails are stored lowercased, so lookups are
	// case-insensitive; the hash is the only thing that decides.
	const user = await first(
		db.select().from(users).where(eq(users.email, email.trim().toLowerCase()))
	);
	if (!user) return null;
	return (await verifyPassword(password, user.passwordHash)) ? user : null;
}

export async function purgeExpiredSessions(db: AppDb) {
	await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}

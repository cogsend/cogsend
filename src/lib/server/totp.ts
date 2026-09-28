import { and, count, eq, isNull, lt, or } from 'drizzle-orm';
import { generateBackupCodes, normalizeBackupCode } from '$lib/domain/backup-codes';
import { formatSecretGroups } from '$lib/domain/base32';
import { randomHex } from '$lib/domain/bytes';
import {
	buildOtpauthUrl,
	generateTotpSecret,
	secretFromBase32,
	verifyTotp
} from '$lib/domain/totp';
import { createSession, revokeOtherSessions, type SessionUser } from './auth';
import { timingSafeEqual, utf8Bytes } from '$lib/domain/bytes';
import { decryptSecret, encryptSecret, hmacHex } from './crypto';
import { first, newId, type AppDb } from './db/client';
import { mfaChallenges, totpBackupCodes, users } from './db/schema';
import type { AppEnv } from './env';
import { qrSvg } from './qr';
import { assertAuthGateOpen, clearAuthGate, recordAuthGateFailure } from './auth-gate';

export const MFA_COOKIE = 'cog_mfa';
export const MFA_MAX_AGE = 10 * 60;
export const MFA_MAX_FAILURES = 8;

export type MfaKind = 'enroll' | 'login' | 'rotate';

export async function hashBackupCode(env: AppEnv, code: string): Promise<string> {
	return hmacHex(env.AUTH_SECRET, `backup:${normalizeBackupCode(code)}`);
}

// MFA challenge tokens live in the `mfa:` HMAC domain (see auth.hashToken
// `session:` domain). Invalidates pre-prefix challenges — users retry login once.
async function mfaTokenHash(raw: string, secret: string): Promise<string> {
	return hmacHex(secret, `mfa:${raw}`);
}

function backupCodeEqual(a: string, b: string): boolean {
	// Constant-time compare on fixed-length HMAC hex; avoids prefix timing oracle.
	const ab = utf8Bytes(a);
	const bb = utf8Bytes(b);
	return ab.length === bb.length && timingSafeEqual(ab, bb);
}

async function createChallenge(
	db: AppDb,
	env: AppEnv,
	opts: {
		userId: string;
		kind: MfaKind;
		remember: boolean;
		secretEnc?: string | null;
		backupCodesEnc?: string | null;
	}
): Promise<string> {
	const raw = randomHex(32);
	const now = new Date();
	await db.insert(mfaChallenges).values({
		id: newId(),
		userId: opts.userId,
		tokenHash: await mfaTokenHash(raw, env.AUTH_SECRET),
		kind: opts.kind,
		secretEnc: opts.secretEnc ?? null,
		backupCodesEnc: opts.backupCodesEnc ?? null,
		remember: opts.remember,
		failedAttempts: 0,
		expiresAt: new Date(now.getTime() + MFA_MAX_AGE * 1000),
		createdAt: now
	});
	return raw;
}

export async function readChallenge(db: AppDb, env: AppEnv, raw: string | undefined) {
	if (!raw) return null;
	const tokenHash = await mfaTokenHash(raw, env.AUTH_SECRET);
	const row = await first(
		db.select().from(mfaChallenges).where(eq(mfaChallenges.tokenHash, tokenHash))
	);
	if (!row) return null;
	if (row.expiresAt < new Date()) {
		await db.delete(mfaChallenges).where(eq(mfaChallenges.id, row.id));
		return null;
	}
	return row;
}

export async function startLoginChallenge(
	db: AppDb,
	env: AppEnv,
	userId: string,
	remember: boolean
) {
	await db
		.delete(mfaChallenges)
		.where(and(eq(mfaChallenges.userId, userId), eq(mfaChallenges.kind, 'login')));
	return createChallenge(db, env, { userId, kind: 'login', remember });
}

export async function startEnrollChallenge(
	db: AppDb,
	env: AppEnv,
	userId: string,
	remember: boolean
) {
	await db
		.delete(mfaChallenges)
		.where(and(eq(mfaChallenges.userId, userId), eq(mfaChallenges.kind, 'enroll')));
	return createChallenge(db, env, { userId, kind: 'enroll', remember });
}

async function bumpFailure(db: AppDb, challengeId: string, current: number) {
	const next = current + 1;
	if (next >= MFA_MAX_FAILURES) {
		await db.delete(mfaChallenges).where(eq(mfaChallenges.id, challengeId));
		return { locked: true as const };
	}
	await db
		.update(mfaChallenges)
		.set({ failedAttempts: next })
		.where(eq(mfaChallenges.id, challengeId));
	return { locked: false as const };
}

export async function resolveEnrollToken(
	db: AppDb,
	env: AppEnv,
	opts: { user: SessionUser | null; mfaRaw?: string; remember?: boolean }
): Promise<string> {
	const existing = await readChallenge(db, env, opts.mfaRaw);
	if (existing && existing.kind === 'enroll') return opts.mfaRaw as string;
	if (opts.user && !opts.user.totpEnabled) {
		return startEnrollChallenge(db, env, opts.user.id, opts.remember ?? true);
	}
	throw Object.assign(new Error('Setup expired — sign in again'), { status: 401 });
}

export async function enrollStart(db: AppDb, env: AppEnv, rawToken: string) {
	const challenge = await readChallenge(db, env, rawToken);
	if (!challenge || (challenge.kind !== 'enroll' && challenge.kind !== 'rotate')) {
		throw Object.assign(new Error('Setup expired — sign in again'), { status: 401 });
	}
	const user = await first(db.select().from(users).where(eq(users.id, challenge.userId)));
	if (!user) throw Object.assign(new Error('Unauthorized'), { status: 401 });
	if (challenge.kind === 'enroll' && user.totpEnabled) {
		throw Object.assign(new Error('Already enrolled'), { status: 400 });
	}

	let secretBase32: string;
	let backupCodes: string[];
	if (challenge.secretEnc && challenge.backupCodesEnc) {
		secretBase32 = await decryptSecret(challenge.secretEnc, env.APP_ENCRYPTION_KEY);
		backupCodes = JSON.parse(
			await decryptSecret(challenge.backupCodesEnc, env.APP_ENCRYPTION_KEY)
		) as string[];
	} else {
		secretBase32 = generateTotpSecret().base32;
		backupCodes = generateBackupCodes();
		await db
			.update(mfaChallenges)
			.set({
				secretEnc: await encryptSecret(secretBase32, env.APP_ENCRYPTION_KEY),
				backupCodesEnc: await encryptSecret(JSON.stringify(backupCodes), env.APP_ENCRYPTION_KEY)
			})
			.where(eq(mfaChallenges.id, challenge.id));
	}

	const otpauthUrl = buildOtpauthUrl({ email: user.email, secretBase32 });
	return {
		email: user.email,
		secret: formatSecretGroups(secretBase32),
		otpauthUrl,
		qrSvg: qrSvg(otpauthUrl),
		backupCodes
	};
}

export async function enrollConfirm(db: AppDb, env: AppEnv, rawToken: string, code: string) {
	const challenge = await readChallenge(db, env, rawToken);
	if (!challenge || (challenge.kind !== 'enroll' && challenge.kind !== 'rotate')) {
		throw Object.assign(new Error('Setup expired — sign in again'), { status: 401 });
	}
	if (!challenge.secretEnc || !challenge.backupCodesEnc) {
		throw Object.assign(new Error('Start setup first'), { status: 400 });
	}

	const user = await first(db.select().from(users).where(eq(users.id, challenge.userId)));
	if (!user) throw Object.assign(new Error('Unauthorized'), { status: 401 });
	// Cross-challenge throttle: per-challenge bumpFailure resets when a fresh
	// challenge is minted, so count TOTP guesses globally per user too.
	await assertAuthGateOpen(db, env, user.id, 'totp-gate');

	const secretBase32 = await decryptSecret(challenge.secretEnc, env.APP_ENCRYPTION_KEY);
	const checked = await verifyTotp(secretFromBase32(secretBase32), code);
	if (!checked.ok) {
		const fail = await bumpFailure(db, challenge.id, challenge.failedAttempts);
		const gate = await recordAuthGateFailure(db, env, user.id, 'totp-gate');
		if (fail.locked || gate.locked)
			throw Object.assign(new Error('Too many attempts — sign in again'), { status: 401 });
		throw Object.assign(new Error('Invalid code'), { status: 400 });
	}
	await clearAuthGate(db, env, user.id, 'totp-gate');

	const backupCodes = JSON.parse(
		await decryptSecret(challenge.backupCodesEnc, env.APP_ENCRYPTION_KEY)
	) as string[];
	const now = new Date();
	await db.delete(totpBackupCodes).where(eq(totpBackupCodes.userId, user.id));
	for (const backup of backupCodes) {
		await db.insert(totpBackupCodes).values({
			id: newId(),
			userId: user.id,
			codeHash: await hashBackupCode(env, backup),
			usedAt: null,
			createdAt: now
		});
	}
	await db
		.update(users)
		.set({
			totpEnabled: true,
			totpSecretEnc: challenge.secretEnc,
			totpEnrolledAt: now,
			totpLastStep: checked.step,
			updatedAt: now
		})
		.where(eq(users.id, user.id));
	// Only clear challenges of this kind; a login or rotate challenge from
	// another tab must survive.
	await db
		.delete(mfaChallenges)
		.where(and(eq(mfaChallenges.userId, user.id), eq(mfaChallenges.kind, challenge.kind)));
	await revokeOtherSessions(db, user.id);
	const session = await createSession(
		db,
		env,
		user.id,
		challenge.remember,
		true,
		user.passwordHash
	);
	return {
		user: { id: user.id, email: user.email, timezone: user.timezone },
		...session
	};
}

/**
 * Check one code against the account: a TOTP code or an unused backup code,
 * with the replay protection the login flow depends on (a TOTP step that has
 * already been spent is refused; a backup code is consumed).
 *
 * The caller owns the throttle — `assertAuthGateOpen` and
 * `recordAuthGateFailure` on the `totp-gate` — because two very different
 * callers need it: signing in, and confirming that whoever is asking to delete
 * the account is still the person who owns it.
 *
 * @returns which kind of code matched, or nothing.
 */
export async function checkUserCode(
	db: AppDb,
	env: AppEnv,
	user: {
		id: string;
		totpEnabled?: boolean | null;
		totpSecretEnc?: string | null;
		totpLastStep?: number | null;
	},
	code: string
): Promise<{ ok: true; usedBackup: boolean } | { ok: false }> {
	let totp: { ok: true; step: number } | { ok: false } = { ok: false };
	try {
		if (user.totpEnabled && user.totpSecretEnc) {
			const secret = secretFromBase32(
				await decryptSecret(user.totpSecretEnc, env.APP_ENCRYPTION_KEY)
			);
			totp = await verifyTotp(secret, code, { lastStep: user.totpLastStep });
		}
	} catch {
		// Encryption key rotated or payload corrupt — still allow a backup code.
	}
	if (totp.ok) {
		// Fenced on the step, not just checked against it: the caller read
		// `totpLastStep` before this call, so two requests presenting the same
		// code can both pass `verifyTotp`. Only the one whose UPDATE matches the
		// previous value wins; the other is refused rather than replaying a code.
		const consumed = await db
			.update(users)
			.set({ totpLastStep: totp.step, updatedAt: new Date() })
			.where(
				and(
					eq(users.id, user.id),
					or(isNull(users.totpLastStep), lt(users.totpLastStep, totp.step))
				)
			)
			.returning({ id: users.id });
		if (!consumed.length) return { ok: false };
		return { ok: true, usedBackup: false };
	}

	const normalized = normalizeBackupCode(code);
	if (normalized.length >= 8) {
		const hash = await hashBackupCode(env, code);
		const unused = await db
			.select()
			.from(totpBackupCodes)
			.where(and(eq(totpBackupCodes.userId, user.id), isNull(totpBackupCodes.usedAt)));
		const match = unused.find((row) => backupCodeEqual(row.codeHash, hash));
		if (match) {
			// Same fence as the TOTP step: `used_at IS NULL` is part of the
			// UPDATE, so a code two requests both read as unused is consumed by
			// exactly one of them.
			const consumed = await db
				.update(totpBackupCodes)
				.set({ usedAt: new Date() })
				.where(and(eq(totpBackupCodes.id, match.id), isNull(totpBackupCodes.usedAt)))
				.returning({ id: totpBackupCodes.id });
			if (!consumed.length) return { ok: false };
			return { ok: true, usedBackup: true };
		}
	}
	return { ok: false };
}

export async function verifyMfa(db: AppDb, env: AppEnv, rawToken: string, code: string) {
	const challenge = await readChallenge(db, env, rawToken);
	if (!challenge || challenge.kind !== 'login') {
		throw Object.assign(new Error('Verification expired — sign in again'), { status: 401 });
	}
	const user = await first(db.select().from(users).where(eq(users.id, challenge.userId)));
	if (!user?.totpEnabled || !user.totpSecretEnc) {
		throw Object.assign(new Error('Unauthorized'), { status: 401 });
	}
	// Cross-challenge throttle (see enrollConfirm): fresh login challenges must
	// not reset the global TOTP guess budget.
	await assertAuthGateOpen(db, env, user.id, 'totp-gate');

	const check = await checkUserCode(db, env, user, code);
	if (check.ok) {
		await db.delete(mfaChallenges).where(eq(mfaChallenges.id, challenge.id));
		await clearAuthGate(db, env, user.id, 'totp-gate');
		const session = await createSession(
			db,
			env,
			user.id,
			challenge.remember,
			true,
			user.passwordHash
		);
		return { user: { id: user.id, email: user.email }, ...session, usedBackup: check.usedBackup };
	}

	const fail = await bumpFailure(db, challenge.id, challenge.failedAttempts);
	const gate = await recordAuthGateFailure(db, env, user.id, 'totp-gate');
	if (fail.locked || gate.locked)
		throw Object.assign(new Error('Too many attempts — sign in again'), { status: 401 });
	throw Object.assign(new Error('Invalid code'), { status: 400 });
}

// Janitor for rows no client will ever present again. Run by the scheduler's
// hourly janitors (runJanitorsIfDue in scheduler.ts) so expired challenges
// cannot accumulate.
export async function purgeExpiredMfaChallenges(db: AppDb, now = new Date()) {
	await db.delete(mfaChallenges).where(lt(mfaChallenges.expiresAt, now));
}

export async function totpStatus(db: AppDb, userId: string) {
	const user = await first(
		db.select({ totpEnabled: users.totpEnabled }).from(users).where(eq(users.id, userId))
	);
	const [unused] = await db
		.select({ n: count() })
		.from(totpBackupCodes)
		.where(and(eq(totpBackupCodes.userId, userId), isNull(totpBackupCodes.usedAt)));
	const remaining = typeof unused?.n === 'bigint' ? Number(unused.n) : Number(unused?.n ?? 0);
	return {
		enabled: Boolean(user?.totpEnabled),
		backupRemaining: Number.isFinite(remaining) ? remaining : 0
	};
}

export async function rotateStart(db: AppDb, env: AppEnv, user: SessionUser, currentCode: string) {
	if (!user.totpEnabled || !user.mfaVerified)
		throw Object.assign(new Error('Unauthorized'), { status: 401 });
	await assertAuthGateOpen(db, env, user.id, 'rotate-gate');
	const row = await first(db.select().from(users).where(eq(users.id, user.id)));
	if (!row?.totpSecretEnc) throw Object.assign(new Error('Unauthorized'), { status: 401 });

	let currentOk: { ok: true; step: number } | { ok: false };
	try {
		currentOk = await verifyTotp(
			secretFromBase32(await decryptSecret(row.totpSecretEnc, env.APP_ENCRYPTION_KEY)),
			currentCode,
			{ lastStep: row.totpLastStep }
		);
	} catch {
		currentOk = { ok: false };
	}
	let backupOk = false;
	if (!currentOk.ok) {
		const unused = await db
			.select()
			.from(totpBackupCodes)
			.where(and(eq(totpBackupCodes.userId, user.id), isNull(totpBackupCodes.usedAt)));
		const hash = await hashBackupCode(env, currentCode);
		const match = unused.find((c) => backupCodeEqual(c.codeHash, hash));
		if (match) {
			// Same fence as checkUserCode: `used_at IS NULL` is part of the
			// UPDATE, so the code that started this rotation cannot also sign in
			// later (or start a second rotation).
			const consumed = await db
				.update(totpBackupCodes)
				.set({ usedAt: new Date() })
				.where(and(eq(totpBackupCodes.id, match.id), isNull(totpBackupCodes.usedAt)))
				.returning({ id: totpBackupCodes.id });
			if (consumed.length) backupOk = true;
		}
	} else {
		// Fenced like checkUserCode: only the update that advances past the step
		// we just verified wins, so a replayed code cannot start two rotations.
		const consumed = await db
			.update(users)
			.set({ totpLastStep: currentOk.step, updatedAt: new Date() })
			.where(
				and(
					eq(users.id, user.id),
					or(isNull(users.totpLastStep), lt(users.totpLastStep, currentOk.step))
				)
			)
			.returning({ id: users.id });
		if (!consumed.length) currentOk = { ok: false };
	}
	if (!currentOk.ok && !backupOk) {
		const fail = await recordAuthGateFailure(db, env, user.id, 'rotate-gate');
		if (fail.locked)
			throw Object.assign(new Error('Too many attempts — try again in 15 minutes'), {
				status: 401
			});
		throw Object.assign(new Error('Invalid code'), { status: 400 });
	}
	await clearAuthGate(db, env, user.id, 'rotate-gate');

	const secretBase32 = generateTotpSecret().base32;
	const backupCodes = generateBackupCodes();
	await db
		.delete(mfaChallenges)
		.where(and(eq(mfaChallenges.userId, user.id), eq(mfaChallenges.kind, 'rotate')));
	const raw = await createChallenge(db, env, {
		userId: user.id,
		kind: 'rotate',
		remember: true,
		secretEnc: await encryptSecret(secretBase32, env.APP_ENCRYPTION_KEY),
		backupCodesEnc: await encryptSecret(JSON.stringify(backupCodes), env.APP_ENCRYPTION_KEY)
	});
	const otpauthUrl = buildOtpauthUrl({ email: user.email, secretBase32 });
	return {
		mfaToken: raw,
		secret: formatSecretGroups(secretBase32),
		otpauthUrl,
		qrSvg: qrSvg(otpauthUrl),
		backupCodes
	};
}

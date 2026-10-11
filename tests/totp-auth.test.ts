import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { secretFromBase32, totpAt } from '#lib/domain/totp.js';
import { authenticatePassword } from '#lib/server/auth.js';
import { first } from '#lib/server/db/client.js';
import { users } from '#lib/server/db/schema.js';
import { createTestAdmin, createTestDb, TEST_ENV } from '#lib/server/db/test.js';
import { mfaChallenges, totpBackupCodes } from '#lib/server/db/schema.js';
import {
	checkUserCode,
	enrollConfirm,
	enrollStart,
	rotateStart,
	startEnrollChallenge,
	startLoginChallenge,
	verifyMfa
} from '#lib/server/totp.js';
import type { AppDb } from '#lib/server/db/client.js';

/** A database whose backup-code reads always answer with `rows` — the "both
 *  callers read before either wrote" race, with the timing taken out. Writes
 *  still go to the real database. */
function staleBackupCodes(db: AppDb, rows: unknown[]): AppDb {
	const real = db as unknown as Record<string, (...args: unknown[]) => unknown>;
	return new Proxy(db as unknown as object, {
		get(target, prop, receiver) {
			if (prop !== 'select') return Reflect.get(target, prop, receiver);
			return (...args: unknown[]) => {
				const chain = real.select!(...args) as Record<string, (...a: unknown[]) => unknown>;
				return new Proxy(chain as object, {
					get(chainTarget, chainProp, chainReceiver) {
						if (chainProp !== 'from') return Reflect.get(chainTarget, chainProp, chainReceiver);
						return (table: unknown) => {
							const fromChain = chain.from!(table) as Record<string, (...a: unknown[]) => unknown>;
							if (table !== totpBackupCodes) return fromChain;
							return new Proxy(fromChain as object, {
								get(t, p, r) {
									if (p === 'where') return async () => rows;
									return Reflect.get(t, p, r);
								}
							});
						};
					}
				});
			};
		}
	}) as unknown as AppDb;
}

describe('totp auth flow', () => {
	let db: AppDb;
	let close: () => void;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		// `npm run setup` writes this row before the first request; the suite
		// seeds it the same way.
		await createTestAdmin(db);
	});
	afterAll(() => close());

	it('password success does not enable totp by itself', async () => {
		const user = await authenticatePassword(db, 'admin@localhost', 'admin123');
		expect(user).toBeTruthy();
		expect(user!.totpEnabled).toBe(false);
	});

	it('enroll without a valid code does not enable totp', async () => {
		const user = await authenticatePassword(db, 'admin@localhost', 'admin123');
		const token = await startEnrollChallenge(db, TEST_ENV, user!.id, true);
		await enrollStart(db, TEST_ENV, token);
		await expect(enrollConfirm(db, TEST_ENV, token, '000000')).rejects.toThrow(/Invalid code/);
		const row = await first(db.select().from(users).where(eq(users.id, user!.id)));
		expect(row?.totpEnabled).toBe(false);
	});

	it('enroll + login with totp and one-time backup code', async () => {
		const user = await authenticatePassword(db, 'admin@localhost', 'admin123');
		const enrollToken = await startEnrollChallenge(db, TEST_ENV, user!.id, true);
		const started = await enrollStart(db, TEST_ENV, enrollToken);
		expect(started.otpauthUrl).toContain('otpauth://totp/');
		expect(started.backupCodes).toHaveLength(10);

		const secret = started.secret.replace(/\s+/g, '');
		const code = await totpAt(secretFromBase32(secret), Math.floor(Date.now() / 1000));
		const enrolled = await enrollConfirm(db, TEST_ENV, enrollToken, code);
		expect(enrolled.raw).toBeTruthy();
		const after = await first(db.select().from(users).where(eq(users.id, user!.id)));
		expect(after?.totpEnabled).toBe(true);

		const loginToken = await startLoginChallenge(db, TEST_ENV, user!.id, true);
		const again = await totpAt(secretFromBase32(secret), Math.floor(Date.now() / 1000) + 30);
		const verified = await verifyMfa(db, TEST_ENV, loginToken, again);
		expect(verified.usedBackup).toBe(false);

		const loginToken2 = await startLoginChallenge(db, TEST_ENV, user!.id, true);
		const backup = started.backupCodes[0];
		const withBackup = await verifyMfa(db, TEST_ENV, loginToken2, backup);
		expect(withBackup.usedBackup).toBe(true);
		const loginToken3 = await startLoginChallenge(db, TEST_ENV, user!.id, true);
		await expect(verifyMfa(db, TEST_ENV, loginToken3, backup)).rejects.toThrow(/Invalid code/);
	});

	/** A freshly enrolled account, with the row as a caller would have read it
	 *  before consuming anything. */
	async function enrolledAccount(email: string) {
		const row = await createTestAdmin(db, { email });
		const token = await startEnrollChallenge(db, TEST_ENV, row.id, true);
		const started = await enrollStart(db, TEST_ENV, token);
		const secret = secretFromBase32(started.secret.replace(/\s+/g, ''));
		await enrollConfirm(db, TEST_ENV, token, await totpAt(secret, Math.floor(Date.now() / 1000)));
		const snapshot = (await first(db.select().from(users).where(eq(users.id, row.id))))!;
		return { row, secret, started, snapshot };
	}

	it('consumes a code once even when two callers read the same stale row', async () => {
		// The race the fence exists for: two requests (a login and an account
		// deletion, say) each read the user row before either writes, so both
		// see the same `totpLastStep` and both pass `verifyTotp`. Passing the
		// same snapshot twice is that race with the timing removed.
		const { secret, snapshot } = await enrolledAccount('fence-totp@localhost');
		const code = await totpAt(secret, Math.floor(Date.now() / 1000) + 30);

		const firstUse = await checkUserCode(db, TEST_ENV, snapshot, code);
		expect(firstUse).toEqual({ ok: true, usedBackup: false });
		// Same snapshot, same code: the UPDATE no longer matches, so this is a
		// replay rather than a second success.
		const replay = await checkUserCode(db, TEST_ENV, snapshot, code);
		expect(replay).toEqual({ ok: false });
	});

	it('refuses a backup code whose read predates another caller using it', async () => {
		// The backup-code lookup happens inside `checkUserCode`, so two
		// overlapping requests can both read the row as unused. Two `Promise.all`
		// calls do not reproduce that on a single SQLite connection (the
		// statements do not interleave), so the stale read is injected instead:
		// the second call is given the rows as they were before the first write.
		const { started, snapshot } = await enrolledAccount('fence-backup@localhost');
		const backup = started.backupCodes[2]!;
		const staleRows = await db
			.select()
			.from(totpBackupCodes)
			.where(and(eq(totpBackupCodes.userId, snapshot.id), isNull(totpBackupCodes.usedAt)));

		expect(await checkUserCode(db, TEST_ENV, snapshot, backup)).toEqual({
			ok: true,
			usedBackup: true
		});
		// Same stale rows, same code: `used_at IS NULL` no longer matches, so the
		// UPDATE consumes nothing and the code is refused.
		expect(
			await checkUserCode(staleBackupCodes(db, staleRows), TEST_ENV, snapshot, backup)
		).toEqual({ ok: false });
		// And it stays spent for a caller with a current view.
		expect(await checkUserCode(db, TEST_ENV, snapshot, backup)).toEqual({ ok: false });
	});
});

describe('rotate start', () => {
	let db: AppDb;
	let close: () => void;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		await createTestAdmin(db);
	});
	afterAll(() => close());

	it('consumes the backup code that started the rotation', async () => {
		const user = await authenticatePassword(db, 'admin@localhost', 'admin123');
		const enrollToken = await startEnrollChallenge(db, TEST_ENV, user!.id, true);
		const started = await enrollStart(db, TEST_ENV, enrollToken);
		const secret = started.secret.replace(/\s+/g, '');
		const code = await totpAt(secretFromBase32(secret), Math.floor(Date.now() / 1000));
		await enrollConfirm(db, TEST_ENV, enrollToken, code);

		const backup = started.backupCodes[1];
		await rotateStart(
			db,
			TEST_ENV,
			{ id: user!.id, email: user!.email, timezone: 'UTC', totpEnabled: true, mfaVerified: true },
			backup
		);
		const rows = await db
			.select()
			.from(totpBackupCodes)
			.where(eq(totpBackupCodes.userId, user!.id));
		expect(rows.filter((row) => row.usedAt != null).length).toBe(1);
		await expect(
			rotateStart(
				db,
				TEST_ENV,
				{
					id: user!.id,
					email: user!.email,
					timezone: 'UTC',
					totpEnabled: true,
					mfaVerified: true
				},
				backup
			)
		).rejects.toThrow(/Invalid code/);
	});
});

describe('rotate confirm cycle', () => {
	let db: AppDb;
	let close: () => void;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		await createTestAdmin(db);
	});
	afterAll(() => close());

	it('confirming rotation replaces backup codes and keeps other challenges', async () => {
		const user = await authenticatePassword(db, 'admin@localhost', 'admin123');
		const enrollToken = await startEnrollChallenge(db, TEST_ENV, user!.id, true);
		const started = await enrollStart(db, TEST_ENV, enrollToken);
		const secret = started.secret.replace(/\s+/g, '');
		await enrollConfirm(
			db,
			TEST_ENV,
			enrollToken,
			await totpAt(secretFromBase32(secret), Math.floor(Date.now() / 1000))
		);
		const oldBackup = started.backupCodes[2];

		// An unrelated login challenge must survive the rotate confirm below.
		await startLoginChallenge(db, TEST_ENV, user!.id, true);

		const rotated = await rotateStart(
			db,
			TEST_ENV,
			{ id: user!.id, email: user!.email, timezone: 'UTC', totpEnabled: true, mfaVerified: true },
			oldBackup
		);
		const newSecret = rotated.secret.replace(/\s+/g, '');
		await enrollConfirm(
			db,
			TEST_ENV,
			rotated.mfaToken,
			await totpAt(secretFromBase32(newSecret), Math.floor(Date.now() / 1000))
		);

		// Old backups are dead after rotation.
		const loginToken = await startLoginChallenge(db, TEST_ENV, user!.id, true);
		await expect(verifyMfa(db, TEST_ENV, loginToken, oldBackup)).rejects.toThrow();
		const remaining = await db
			.select()
			.from(totpBackupCodes)
			.where(and(eq(totpBackupCodes.userId, user!.id), isNull(totpBackupCodes.usedAt)));
		expect(remaining).toHaveLength(10);

		// The unrelated login challenge survived the confirm.
		const logins = await db
			.select()
			.from(mfaChallenges)
			.where(and(eq(mfaChallenges.userId, user!.id), eq(mfaChallenges.kind, 'login')));
		expect(logins.length).toBeGreaterThanOrEqual(1);
	});
});

describe('totp brute-force gate', () => {
	let db: AppDb;
	let close: () => void;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		await createTestAdmin(db);
	});
	afterAll(() => close());

	it('fresh login challenges do not reset the global TOTP guess budget', async () => {
		const user = await authenticatePassword(db, 'admin@localhost', 'admin123');
		const enrollToken = await startEnrollChallenge(db, TEST_ENV, user!.id, true);
		const started = await enrollStart(db, TEST_ENV, enrollToken);
		const secret = started.secret.replace(/\s+/g, '');
		await enrollConfirm(
			db,
			TEST_ENV,
			enrollToken,
			await totpAt(secretFromBase32(secret), Math.floor(Date.now() / 1000))
		);

		// Attacker with the password mints a fresh challenge per guess batch.
		// Per-challenge counters reset, but the cross-challenge totp-gate must
		// still lock after 8 total guesses.
		for (let i = 0; i < 8; i++) {
			const token = await startLoginChallenge(db, TEST_ENV, user!.id, true);
			await expect(verifyMfa(db, TEST_ENV, token, '000000')).rejects.toThrow();
		}
		const fresh = await startLoginChallenge(db, TEST_ENV, user!.id, true);
		await expect(verifyMfa(db, TEST_ENV, fresh, '000000')).rejects.toThrow(/Too many attempts/);
	});
});

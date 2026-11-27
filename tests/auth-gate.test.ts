import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
	AUTH_GATE_MAX_FAILURES,
	AUTH_GATE_WINDOW_MS,
	PASSWORD_GATE_GLOBAL_MAX,
	assertAuthGateOpen,
	checkAccountPassword,
	recordAuthGateFailure,
	reserveAuthGateAttempt
} from '#lib/server/auth-gate.js';
import { hashPassword } from '#lib/server/crypto.js';
import { mfaChallenges } from '#lib/server/db/schema.js';
import { createTestAdmin, createTestDb, TEST_ENV } from '#lib/server/db/test.js';
import type { AppDb } from '#lib/server/db/client.js';

describe('auth gate', () => {
	let db: AppDb;
	let close: () => void;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
	});
	afterAll(() => close());

	it('locks after too many failures', async () => {
		const admin = await createTestAdmin(db);
		for (let i = 0; i < AUTH_GATE_MAX_FAILURES; i++) {
			await recordAuthGateFailure(db, TEST_ENV, admin.id, 'password');
		}
		await expect(assertAuthGateOpen(db, TEST_ENV, admin.id, 'password')).rejects.toThrow(
			/Too many attempts/
		);
	});

	it('counts a concurrent burst without losing failures', async () => {
		const admin = await createTestAdmin(db, { email: 'burst@localhost' });
		// All eight in flight at once: a read-then-write gate lets some of them
		// overwrite each other, and the account never locks.
		await Promise.all(
			Array.from({ length: AUTH_GATE_MAX_FAILURES }, () =>
				recordAuthGateFailure(db, TEST_ENV, admin.id, 'password')
			)
		);
		await expect(assertAuthGateOpen(db, TEST_ENV, admin.id, 'password')).rejects.toThrow(
			/Too many attempts/
		);
	});

	it('resets the count once the window has passed', async () => {
		const admin = await createTestAdmin(db, { email: 'window@localhost' });
		for (let i = 0; i < AUTH_GATE_MAX_FAILURES - 1; i++) {
			await recordAuthGateFailure(db, TEST_ENV, admin.id, 'password');
		}
		const stale = new Date(Date.now() - AUTH_GATE_WINDOW_MS - 60_000);
		await db
			.update(mfaChallenges)
			.set({ expiresAt: stale })
			.where(eq(mfaChallenges.userId, admin.id));
		const { locked } = await recordAuthGateFailure(db, TEST_ENV, admin.id, 'password');
		expect(locked).toBe(false);
		await db.delete(mfaChallenges).where(eq(mfaChallenges.userId, admin.id));
	});

	it('stops a concurrent burst past the cap before verification runs', async () => {
		const admin = await createTestAdmin(db, { email: 'atomic-burst@localhost' });
		const results = await Promise.allSettled(
			Array.from({ length: AUTH_GATE_MAX_FAILURES + 4 }, () =>
				reserveAuthGateAttempt(db, TEST_ENV, admin.id, 'totp-gate')
			)
		);
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(AUTH_GATE_MAX_FAILURES);
		expect(results.filter((r) => r.status === 'rejected')).toHaveLength(4);
	});

	it('keeps signed-in checkAccountPassword working even if login global lockout tripped', async () => {
		const passwordHash = await hashPassword('owner-secret-password');
		const admin = await createTestAdmin(db, { email: 'owner-unlock@localhost' });
		for (let i = 0; i < PASSWORD_GATE_GLOBAL_MAX; i++) {
			await recordAuthGateFailure(db, TEST_ENV, admin.id, 'password-all', {
				max: PASSWORD_GATE_GLOBAL_MAX
			});
		}
		expect(
			await checkAccountPassword(
				db,
				TEST_ENV,
				{ id: admin.id, passwordHash },
				'owner-secret-password',
				'203.0.113.5'
			)
		).toBe('ok');
	});
});

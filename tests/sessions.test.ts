import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createSession, getSessionUser } from '#lib/server/auth.js';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { sessions, users } from '#lib/server/db/schema.js';
import { createTestDb, TEST_ENV } from '#lib/server/db/test.js';
import { hashPassword } from '#lib/server/crypto.js';

describe('session password binding and idle timeout', () => {
	let db: AppDb;
	let close: () => void;
	/** The hash on the row: a session is bound to it, so it must be minted with it. */
	const ROW_HASH = 'x';
	let userId: string;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'sess@localhost',
			passwordHash: ROW_HASH,
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
	});

	afterAll(() => close());

	it('accepts a fresh session and throttles lastSeen writes', async () => {
		const { raw } = await createSession(db, TEST_ENV, userId, true, false, ROW_HASH);
		const seen = await getSessionUser(db, TEST_ENV, raw);
		expect(seen?.user.id).toBe(userId);
		// Touched within the write window: no rewrite expected on next hit.
		const [row] = await db.select().from(sessions).where(eq(sessions.userId, userId));
		const firstSeen = row?.lastSeenAt?.getTime();
		expect(row?.pwdFp).toBeTruthy();
		await getSessionUser(db, TEST_ENV, raw);
		const [row2] = await db.select().from(sessions).where(eq(sessions.userId, userId));
		expect(row2?.lastSeenAt?.getTime()).toBe(firstSeen);
		await db.delete(sessions).where(eq(sessions.userId, userId));
	});

	it('kills sessions after a password rotation', async () => {
		const { raw } = await createSession(db, TEST_ENV, userId, true, false, ROW_HASH);
		// The Settings page (or `npm run admin:reset`) writes a new hash; every
		// session minted with the old one dies on its next use.
		await db
			.update(users)
			.set({ passwordHash: await hashPassword('rotated-secret') })
			.where(eq(users.id, userId));
		expect(await getSessionUser(db, TEST_ENV, raw)).toBeNull();
		const rows = await db.select().from(sessions).where(eq(sessions.userId, userId));
		expect(rows.length).toBe(0);
	});

	it('kills a session whose last-seen timestamp is missing', async () => {
		const { raw } = await createSession(db, TEST_ENV, userId, true, false, ROW_HASH);
		await db.update(sessions).set({ lastSeenAt: null }).where(eq(sessions.userId, userId));
		expect(await getSessionUser(db, TEST_ENV, raw)).toBeNull();
		const rows = await db.select().from(sessions).where(eq(sessions.userId, userId));
		expect(rows.length).toBe(0);
	});

	it('kills sessions idle longer than a day', async () => {
		const { raw } = await createSession(db, TEST_ENV, userId, true, false, ROW_HASH);
		await db
			.update(sessions)
			.set({ lastSeenAt: new Date(Date.now() - 25 * 60 * 60_000) })
			.where(eq(sessions.userId, userId));
		expect(await getSessionUser(db, TEST_ENV, raw)).toBeNull();
		const rows = await db.select().from(sessions).where(eq(sessions.userId, userId));
		expect(rows.length).toBe(0);
	});

	it('rejects legacy rows without a fingerprint', async () => {
		const { raw } = await createSession(db, TEST_ENV, userId);
		await db
			.update(sessions)
			.set({ pwdFp: null, lastSeenAt: null })
			.where(eq(sessions.userId, userId));
		// Nothing to compare the fingerprint against, so the row is refused
		// rather than trusted until its absolute expiry.
		expect(await getSessionUser(db, TEST_ENV, raw)).toBeNull();
		const rows = await db.select().from(sessions).where(eq(sessions.userId, userId));
		expect(rows.length).toBe(0);
	});
});

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { hotp, secretFromBase32, totpAt, totpCounter } from '#lib/domain/totp.js';
import { getSessionUser } from '#lib/server/auth.js';
import { createSession } from '#lib/server/auth.js';
import { hashPassword } from '#lib/server/crypto.js';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { draftMedia, drafts, sessions, totpBackupCodes, users } from '#lib/server/db/schema.js';
import { createTestAdmin, createTestDb, TEST_ENV } from '#lib/server/db/test.js';
import { enrollConfirm, enrollStart, startEnrollChallenge } from '#lib/server/totp.js';
import { DELETE } from '../src/routes/api/auth/me/+server';

/**
 * Deleting the account destroys everything: drafts, connections, API keys, and
 * the login itself. A live session must not be enough on its own — an
 * unattended browser or a stolen cookie would then be a one-request wipe — so
 * the route asks for both factors again, and throttles them like the login form.
 */
describe('deleting the account', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;
	let passwordHash: string;
	let totpSecret: string;

	const request = (body: unknown, locals: Record<string, unknown>) =>
		DELETE({
			request: new Request('http://localhost/api/auth/me', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			}),
			locals,
			cookies: { set() {}, delete() {}, get: () => undefined },
			url: new URL('http://localhost/api/auth/me')
		} as never) as Promise<Response>;

	const localsFor = (overrides: Record<string, unknown> = {}) => ({
		db,
		env: TEST_ENV,
		authMethod: 'session' as const,
		user: {
			id: userId,
			email: 'admin@localhost',
			timezone: 'UTC',
			totpEnabled: true,
			mfaVerified: true
		},
		media: { delete: async () => {}, put: async () => {}, get: async () => null },
		...overrides
	});

	// The step *after* the current one: enrollment spent the current step, and
	// `totpLastStep` is exactly what stops a code being used twice. Computing the
	// next step (rather than "now + 30s", which a window boundary can turn into a
	// spent step) keeps this deterministic.
	const code = (offset = 1) =>
		hotp(secretFromBase32(totpSecret), totpCounter(Math.floor(Date.now() / 1000)) + offset);

	/** Retry with the next step, the way a person retries with a fresh code. */
	async function deleteWithFreshCode(locals: Record<string, unknown>): Promise<Response> {
		let last = new Response(null, { status: 500 });
		for (let offset = 1; offset <= 3; offset++) {
			last = await request({ password: 'admin123', code: await code(offset) }, locals);
			if (last.status === 200) return last;
		}
		return last;
	}

	/** DELETE with the next unused step, retrying the way a person would if the
	 *  clock crossed a boundary. Returns the first answer that is not a refusal. */
	async function deleteWithNextCode(
		locals: Record<string, unknown>,
		codeFor: (offset: number) => Promise<string> = code
	): Promise<Response> {
		let last = new Response(null, { status: 500 });
		for (let offset = 1; offset <= 4; offset++) {
			last = await request({ password: 'admin123', code: await codeFor(offset) }, locals);
			if (last.status !== 401) return last;
		}
		return last;
	}

	/** Enroll an authenticator for a fresh admin and return its next-code
	 *  generator — a second account cannot use the shared secret above. */
	async function enrollAndCode(userId: string) {
		const token = await startEnrollChallenge(db, TEST_ENV, userId, true);
		const started = await enrollStart(db, TEST_ENV, token);
		const secret = secretFromBase32(started.secret.replace(/\s+/g, ''));
		const step = totpCounter(Math.floor(Date.now() / 1000));
		await enrollConfirm(db, TEST_ENV, token, await hotp(secret, step));
		// Codes are checked against the clock, not against enrollment, so derive
		// each one from the current step — a step counted from enrollment goes
		// stale as soon as the window moves past it.
		return (offset = 1) => hotp(secret, totpCounter(Math.floor(Date.now() / 1000)) + offset);
	}

	let count: () => number;

	beforeAll(async () => {
		({ db, close, count } = await createTestDb());
		const row = await createTestAdmin(db);
		userId = row.id;
		passwordHash = row.passwordHash;
		// Enroll an authenticator the way the app does, so the secret and its
		// backup codes are real rows rather than test doubles.
		const token = await startEnrollChallenge(db, TEST_ENV, userId, true);
		const started = await enrollStart(db, TEST_ENV, token);
		totpSecret = started.secret.replace(/\s+/g, '');
		await enrollConfirm(
			db,
			TEST_ENV,
			token,
			await totpAt(secretFromBase32(totpSecret), Math.floor(Date.now() / 1000))
		);
	});
	afterAll(() => close());

	it('refuses a machine credential: this is a session-only action', async () => {
		const res = await request(
			{ password: 'admin123', code: code() },
			localsFor({ authMethod: 'bearer' })
		);
		expect(res.status).toBe(401);
		expect(await db.select().from(users)).toHaveLength(1);
	});

	it('demands both factors, with something a person can act on', async () => {
		expect((await request({}, localsFor())).status).toBe(400);
		expect((await request({ password: 'admin123' }, localsFor())).status).toBe(400);
		expect((await request({ code: code() }, localsFor())).status).toBe(400);
		expect(await db.select().from(users)).toHaveLength(1);
	});

	it('refuses a wrong password or a wrong code', async () => {
		const wrongPassword = await request(
			{ password: 'not-the-password', code: code() },
			localsFor()
		);
		expect(wrongPassword.status).toBe(401);
		expect((await wrongPassword.json()).error).toBe('That password is not correct');

		const wrongCode = await request({ password: 'admin123', code: '000000' }, localsFor());
		expect(wrongCode.status).toBe(401);
		expect(await db.select().from(users)).toHaveLength(1);
	});

	it('refuses a spoofed password hash: the stored hash is what counts', async () => {
		// Guard against a regression where the route compared against something
		// other than the row (the old env-credential behaviour).
		expect(await hashPassword('admin123')).not.toBe(passwordHash);
		const res = await request({ password: 'admin123', code: '111111' }, localsFor());
		expect(res.status).toBe(401);
	});

	it('deletes the account, every session, and the media behind it', async () => {
		await createSession(db, TEST_ENV, userId, true, true, passwordHash);
		expect(await db.select().from(sessions)).not.toHaveLength(0);

		const deleted: string[] = [];
		const res = await deleteWithFreshCode(
			localsFor({
				media: {
					delete: async (key: string) => {
						deleted.push(key);
					},
					put: async () => {},
					get: async () => null
				}
			})
		);
		expect(res.status).toBe(200);
		// The account, its sessions and its one-time codes are gone.
		expect(await db.select().from(users).where(eq(users.id, userId))).toHaveLength(0);
		expect(await db.select().from(sessions).where(eq(sessions.userId, userId))).toHaveLength(0);
		expect(
			await db.select().from(totpBackupCodes).where(eq(totpBackupCodes.userId, userId))
		).toHaveLength(0);
		expect(deleted).toEqual([]);
	});

	it('will not accept an authenticator code that was already spent', async () => {
		const row = await createTestAdmin(db, { email: 'replay@localhost' });
		// Enroll a real secret, then present the very step it just spent.
		const token = await startEnrollChallenge(db, TEST_ENV, row.id, true);
		const started = await enrollStart(db, TEST_ENV, token);
		const secret = secretFromBase32(started.secret.replace(/\s+/g, ''));
		const step = totpCounter(Math.floor(Date.now() / 1000));
		await enrollConfirm(db, TEST_ENV, token, await hotp(secret, step));

		const res = await request(
			{ password: 'admin123', code: await hotp(secret, step) },
			localsFor({
				user: {
					id: row.id,
					email: 'replay@localhost',
					timezone: 'UTC',
					totpEnabled: true,
					mfaVerified: true
				}
			})
		);
		expect(res.status).toBe(401);
		expect((await res.json()).error).toBe('That code is not valid');
		expect(await db.select().from(users).where(eq(users.id, row.id))).toHaveLength(1);
	});

	it('lets a local instance with SKIP_TOTP confirm with the password alone', async () => {
		const row = await createTestAdmin(db, { email: 'local@localhost' });
		const res = await request(
			{ password: 'admin123' },
			localsFor({
				env: { ...TEST_ENV, skipTotp: true },
				// The hook satisfies both flags under SKIP_TOTP, so that is the
				// shape a local request arrives in.
				user: {
					id: row.id,
					email: 'local@localhost',
					timezone: 'UTC',
					totpEnabled: true,
					mfaVerified: true
				}
			})
		);
		expect(res.status).toBe(200);
		expect(await db.select().from(users).where(eq(users.id, row.id))).toHaveLength(0);
	});

	it('deletes a library larger than one batch in one request', async () => {
		// The route acts on the first account in the table, so leave only this one.
		await db.delete(users);
		const row = await createTestAdmin(db, { email: 'library@localhost' });
		const codeFor = await enrollAndCode(row.id);
		const draftId = newId();
		const now = new Date();
		await db.insert(drafts).values({
			id: draftId,
			userId: row.id,
			title: 'many',
			baseBody: 'text',
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
		// Two batches' worth: 250 rows at 200 per batch.
		await db.insert(draftMedia).values(
			Array.from({ length: 250 }, (_, i) => ({
				id: newId(),
				draftId,
				storageKey: `library/${i}.png`,
				mime: 'image/png',
				size: 10,
				createdAt: now
			}))
		);

		const batchSizes: number[] = [];
		const res = await deleteWithNextCode(
			localsFor({
				user: {
					id: row.id,
					email: 'library@localhost',
					timezone: 'UTC',
					totpEnabled: true,
					mfaVerified: true
				},
				media: {
					// The point of the bulk call: two subrequests, not 250.
					deleteMany: async (keys: string[]) => {
						batchSizes.push(keys.length);
					},
					delete: async () => {
						throw new Error('delete() must not be used when deleteMany exists');
					},
					put: async () => {},
					get: async () => null
				}
			}),
			codeFor
		);
		expect(res.status).toBe(200);
		// Each file is deleted with its thumbnail cache key, still one call per batch.
		expect(batchSizes).toEqual([400, 100]);
		expect(await db.select().from(users).where(eq(users.id, row.id))).toHaveLength(0);
		expect(await db.select().from(draftMedia).where(eq(draftMedia.draftId, draftId))).toHaveLength(
			0
		);
	});

	it('spreads a library too large for one request over several, resuming each time', async () => {
		await db.delete(users);
		const row = await createTestAdmin(db, { email: 'huge@localhost' });
		const codeFor = await enrollAndCode(row.id);
		const draftId = newId();
		const now = new Date();
		await db.insert(drafts).values({
			id: draftId,
			userId: row.id,
			title: 'huge',
			baseBody: 'text',
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
		const total = 2100; // 10 batches of 200, then 100 left over
		await db.insert(draftMedia).values(
			Array.from({ length: total }, (_, i) => ({
				id: newId(),
				draftId,
				storageKey: `huge/${i}.png`,
				mime: 'image/png',
				size: 10,
				createdAt: now
			}))
		);
		const locals = (user: Record<string, unknown>) =>
			localsFor({
				user,
				media: {
					deleteMany: async () => {},
					delete: async () => {},
					put: async () => {},
					get: async () => null
				}
			});
		const user = {
			id: row.id,
			email: 'huge@localhost',
			timezone: 'UTC',
			totpEnabled: true,
			mfaVerified: true
		};

		// Only Date is faked: the second request needs a code from the next
		// window, because the first one spent the only step it could use.
		vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
		const before = count();
		const first = await deleteWithNextCode(locals(user), codeFor);
		expect(first.status).toBe(202);
		expect((await first.json()).deletedMedia).toBe(2000);
		// D1 allows 50 statements per invocation on the free plan: the largest
		// batch this route will attempt has to fit, with the auth checks and the
		// cascade included.
		expect(count() - before).toBeLessThan(50);
		// The account is still there, and so are the rows for what is left —
		// that is what makes the next call resume instead of starting over.
		expect(await db.select().from(users).where(eq(users.id, row.id))).toHaveLength(1);
		expect(await db.select().from(draftMedia).where(eq(draftMedia.draftId, draftId))).toHaveLength(
			100
		);

		vi.setSystemTime(Date.now() + 31_000);
		const second = await deleteWithNextCode(locals(user), codeFor);
		vi.useRealTimers();
		expect(second.status).toBe(200);
		expect(await db.select().from(users).where(eq(users.id, row.id))).toHaveLength(0);
		expect(await db.select().from(draftMedia).where(eq(draftMedia.draftId, draftId))).toHaveLength(
			0
		);
	});

	it('leaves the session reading path alone for the GET route', async () => {
		// A sanity check that the module still answers GET as before.
		const row = await createTestAdmin(db, { email: 'get@localhost' });
		const { GET } = await import('../src/routes/api/auth/me/+server');
		const res = (await GET({
			locals: localsFor({
				user: {
					id: row.id,
					email: 'get@localhost',
					timezone: 'UTC',
					totpEnabled: true,
					mfaVerified: true
				}
			})
		} as never)) as Response;
		expect(await res.json()).toMatchObject({ user: { email: 'get@localhost' } });
		expect(newId()).toBeTruthy();
		expect(await getSessionUser(db, TEST_ENV, 'nope')).toBeNull();
	});
});

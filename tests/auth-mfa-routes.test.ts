import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { hotp, secretFromBase32, totpAt, totpCounter } from '#lib/domain/totp.js';
import { getSessionUser, SESSION_COOKIE } from '#lib/server/auth.js';
import type { AppDb } from '#lib/server/db/client.js';
import { totpBackupCodes, users } from '#lib/server/db/schema.js';
import { createTestAdmin, createTestDb, TEST_ADMIN, TEST_ENV } from '#lib/server/db/test.js';
import { MFA_COOKIE } from '#lib/server/totp.js';
import { POST as loginPOST } from '../src/routes/api/auth/login/+server';
import { GET as meGET } from '../src/routes/api/auth/me/+server';
import { POST as logoutPOST } from '../src/routes/api/auth/logout/+server';
import { POST as enrollConfirmPOST } from '../src/routes/api/auth/totp/enroll/confirm/+server';
import { POST as enrollStartPOST } from '../src/routes/api/auth/totp/enroll/start/+server';
import { GET as statusGET } from '../src/routes/api/auth/totp/status/+server';
import { POST as verifyPOST } from '../src/routes/api/auth/totp/verify/+server';

/**
 * The whole second-factor path, driven through the routes the browser calls:
 * password → enrol or verify → session. The e2e suite runs with SKIP_TOTP, so
 * nothing else covers it, and it is the only thing standing between a leaked
 * password and the account.
 */
function cookieJar(initial: Record<string, string> = {}) {
	const jar = new Map(Object.entries(initial));
	const written: Array<{ name: string; value: string; opts: Record<string, unknown> }> = [];
	return {
		jar,
		written,
		get: (name: string) => jar.get(name),
		set: (name: string, value: string, opts: Record<string, unknown> = {}) => {
			jar.set(name, value);
			written.push({ name, value, opts });
		},
		delete: (name: string) => {
			jar.delete(name);
		},
		lastWrite: (name: string) => [...written].reverse().find((w) => w.name === name)
	};
}

type Jar = ReturnType<typeof cookieJar>;

describe('password + TOTP login routes', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;
	let secret: string;
	let backupCodes: string[];
	/** What the one-time enrolment left behind, for the assertions that need it. */
	const harness: { jar: Jar | null } = { jar: null };

	const json = (body: unknown) =>
		new Request('http://localhost/api/auth/login', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});

	const login = (jar: Jar, password = TEST_ADMIN.password) =>
		loginPOST({
			request: json({ email: TEST_ADMIN.email, password }),
			locals: { db, env: TEST_ENV },
			cookies: jar,
			url: new URL('http://localhost/api/auth/login')
		} as never) as Promise<Response>;

	const post = (handler: unknown, jar: Jar, body: unknown) =>
		(handler as (event: unknown) => Promise<Response>)({
			request: json(body),
			locals: { db, env: TEST_ENV },
			cookies: jar,
			url: new URL('http://localhost/api/auth/totp')
		});

	/** What the hook would put on locals for the cookie the routes just wrote. */
	async function localsFor(jar: Jar) {
		const raw = jar.get(SESSION_COOKIE);
		const session = raw ? await getSessionUser(db, TEST_ENV, raw) : null;
		return {
			db,
			env: TEST_ENV,
			user: session?.user ?? null,
			authMethod: session ? ('session' as const) : null
		};
	}

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		// `npm run setup` writes this row before the first request, so the suite
		// seeds it the same way rather than expecting the login route to invent it.
		await createTestAdmin(db);
		const admin = (await db.select().from(users).where(eq(users.email, TEST_ADMIN.email)))[0];
		userId = admin.id;
		await enrolFirstTime();
	});

	/** Runs once: password login → enrol → a verified session. */
	async function enrolFirstTime() {
		const jar = cookieJar();
		harness.jar = jar;
		const started = await login(jar);
		expect(await started.json()).toEqual({ needEnroll: true });
		expect(jar.get(MFA_COOKIE)).toBeTruthy();
		// The cookie is httpOnly and scoped to the whole app.
		const mfaWrite = jar.lastWrite(MFA_COOKIE)!;
		expect(mfaWrite.opts).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });

		const enroll = await post(enrollStartPOST, jar, {});
		expect(enroll.status).toBe(200);
		const data = (await enroll.json()) as { secret: string; qrSvg: string; backupCodes: string[] };
		// The route formats it in groups of four for the setup screen.
		expect(data.secret).toMatch(/^(?:[A-Z2-7]{4} )+[A-Z2-7]{4}$/);
		secret = data.secret.replace(/\s+/g, '');
		backupCodes = data.backupCodes;
		expect(data.qrSvg).toContain('<svg');
		expect(data.backupCodes).toHaveLength(10);

		const code = await totpAt(secretFromBase32(secret), Math.floor(Date.now() / 1000));
		const confirmed = await post(enrollConfirmPOST, jar, { code });
		expect(confirmed.status).toBe(200);
		const body = (await confirmed.json()) as { user: { email: string } };
		expect(body.user.email).toBe(TEST_ADMIN.email);
		expect(jar.get(SESSION_COOKIE)).toBeTruthy();
		// The MFA cookie is spent, and the account is enrolled.
		expect(jar.get(MFA_COOKIE)).toBeUndefined();
		expect((await db.select().from(users).where(eq(users.id, userId)))[0].totpEnabled).toBe(true);
	}

	afterAll(() => close());

	it('enrolled the account during setup and left a working session', async () => {
		// The enrolment flow itself runs in beforeAll so that every test here can
		// run on its own (`vitest -t`); this asserts what it left behind.
		expect(secret).toMatch(/^[A-Z2-7]+$/);
		expect(backupCodes).toHaveLength(10);
		expect((await db.select().from(users).where(eq(users.id, userId)))[0].totpEnabled).toBe(true);
		expect(await getSessionUser(db, TEST_ENV, harness.jar!.get(SESSION_COOKIE)!)).toBeTruthy();
	});

	it('rejects a wrong code and keeps the session closed', async () => {
		const jar = cookieJar();
		expect(await (await login(jar)).json()).toEqual({ needTotp: true });

		// A wrong code is a 400 with copy the page can show; 401 is reserved for
		// the lockout, so a client that redirects on 401 does not bounce the
		// user away from the code form.
		const wrong = await post(verifyPOST, jar, { code: '000000' });
		expect(wrong.status).toBe(400);
		expect(((await wrong.json()) as { error: string }).error).toBe('Invalid code');
		expect(jar.get(SESSION_COOKIE)).toBeUndefined();

		// The same challenge still works with the right code afterwards.
		const step = totpCounter(Math.floor(Date.now() / 1000));
		const code = await hotp(secretFromBase32(secret), step + 1);
		const ok = await post(verifyPOST, jar, { code });
		expect(ok.status).toBe(200);
		expect(jar.get(SESSION_COOKIE)).toBeTruthy();
	});

	it('accepts a backup code once, and only once', async () => {
		const jar = cookieJar();
		await login(jar);
		const used = backupCodes[0];
		const first = await post(verifyPOST, jar, { code: used });
		expect(first.status).toBe(200);
		expect(((await first.json()) as { usedBackup: boolean }).usedBackup).toBe(true);

		const again = cookieJar();
		await login(again);
		const second = await post(verifyPOST, again, { code: used });
		expect(second.status).toBe(400);
		expect(again.get(SESSION_COOKIE)).toBeUndefined();
	});

	it('serves 2FA status to a session and refuses a bearer key', async () => {
		const jar = cookieJar();
		await login(jar);
		await post(verifyPOST, jar, { code: backupCodes[1] });

		const locals = await localsFor(jar);
		expect(locals.user).toBeTruthy();
		const res = (await statusGET({ locals } as never)) as Response;
		expect(res.status).toBe(200);
		const status = (await res.json()) as { enabled: boolean; backupRemaining: number };
		expect(status.enabled).toBe(true);
		// Cross-check the count against the table instead of a running total, so
		// this assertion does not depend on which tests ran before it.
		const unused = (
			await db
				.select()
				.from(totpBackupCodes)
				.where(and(eq(totpBackupCodes.userId, userId), isNull(totpBackupCodes.usedAt)))
		).length;
		expect(status.backupRemaining).toBe(unused);

		// A personal key must not be able to read credential metadata.
		const bearer = await statusGET({
			locals: { db, env: TEST_ENV, user: locals.user, authMethod: 'bearer', apiKeyScopes: ['read'] }
		} as never);
		expect((bearer as Response).status).toBe(401);
	});

	it('tells an anonymous caller nothing about enrolment', async () => {
		const res = (await meGET({ locals: { db, env: TEST_ENV, user: null } } as never)) as Response;
		expect(await res.json()).toEqual({ user: null, needsEnroll: false, totpEnabled: false });
	});

	it('logs out and invalidates the session', async () => {
		const jar = cookieJar();
		await login(jar);
		await post(verifyPOST, jar, { code: backupCodes[2] });
		const raw = jar.get(SESSION_COOKIE)!;
		expect(await getSessionUser(db, TEST_ENV, raw)).toBeTruthy();

		const res = (await logoutPOST({
			locals: { db, env: TEST_ENV },
			cookies: jar,
			url: new URL('http://localhost/api/auth/logout')
		} as never)) as Response;
		expect(res.status).toBe(200);
		expect(jar.get(SESSION_COOKIE)).toBeUndefined();
		expect(await getSessionUser(db, TEST_ENV, raw)).toBeNull();
		// ...and the hook would now see an anonymous request.
		const me = (await meGET({
			locals: await localsFor(jar)
		} as never)) as Response;
		expect(((await me.json()) as { user: unknown }).user).toBeNull();
	});
});

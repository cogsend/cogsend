import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDb } from '$lib/server/db/client';
import { users } from '$lib/server/db/schema';
import { createTestAdmin, createTestDb, TEST_ENV } from '$lib/server/db/test';
import { SESSION_COOKIE } from '$lib/server/auth';
import { verifyPassword } from '$lib/server/crypto';
import { MFA_COOKIE } from '$lib/server/totp';
import { POST as claimPOST } from '../src/routes/api/auth/claim/+server';
import { POST as enrollStartPOST } from '../src/routes/api/auth/totp/enroll/start/+server';

/**
 * Claiming a fresh instance from the browser. The key is the proof of
 * ownership, so everything here is about what happens without it, and about
 * there never being a second account.
 */
function cookieJar() {
	const jar = new Map<string, string>();
	return {
		get: (name: string) => jar.get(name),
		set: (name: string, value: string) => void jar.set(name, value),
		delete: (name: string) => void jar.delete(name)
	};
}

type Jar = ReturnType<typeof cookieJar>;

const GOOD = {
	setupKey: TEST_ENV.APP_ENCRYPTION_KEY,
	email: '  Owner@Example.com ',
	password: 'a-long-enough-password'
};

describe('claim route', () => {
	let db: AppDb;
	let close: () => void;

	beforeEach(async () => {
		({ db, close } = await createTestDb());
	});

	afterEach(() => close());

	function claim(body: unknown, jar: Jar = cookieJar()) {
		return claimPOST({
			request: new Request('http://localhost/api/auth/claim', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: typeof body === 'string' ? body : JSON.stringify(body)
			}),
			locals: { db, env: TEST_ENV },
			cookies: jar,
			url: new URL('http://localhost/api/auth/claim')
		} as never) as Promise<Response>;
	}

	const accounts = async () => db.select().from(users);

	it('creates the one account and hands over to authenticator enrolment', async () => {
		const jar = cookieJar();
		const res = await claim(GOOD, jar);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ needEnroll: true });
		expect(jar.get(MFA_COOKIE)).toBeTruthy();

		const rows = await accounts();
		expect(rows).toHaveLength(1);
		expect(rows[0].email).toBe('owner@example.com');
		expect(rows[0].totpEnabled).toBe(false);
		expect(await verifyPassword(GOOD.password, rows[0].passwordHash)).toBe(true);

		// The challenge cookie is the same one a password login issues, so the
		// next step is the ordinary enrolment route.
		const enroll = (await (enrollStartPOST as (event: unknown) => Promise<Response>)({
			request: new Request('http://localhost/api/auth/totp/enroll/start', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{}'
			}),
			locals: { db, env: TEST_ENV },
			cookies: jar,
			url: new URL('http://localhost/api/auth/totp/enroll/start')
		})) as Response;
		expect(enroll.status).toBe(200);
	});

	it('refuses a wrong key and creates nothing', async () => {
		for (const setupKey of [
			'',
			'not-the-key',
			TEST_ENV.APP_ENCRYPTION_KEY.slice(0, -1),
			`${TEST_ENV.APP_ENCRYPTION_KEY}x`,
			TEST_ENV.APP_ENCRYPTION_KEY.toUpperCase()
		]) {
			const res = await claim({ ...GOOD, setupKey });
			expect(res.status).toBeGreaterThanOrEqual(400);
			expect(res.status).toBeLessThan(500);
			expect(JSON.stringify(await res.json())).not.toContain(TEST_ENV.APP_ENCRYPTION_KEY);
		}
		expect(await accounts()).toHaveLength(0);
	});

	it('accepts the key with surrounding whitespace, as a paste often has', async () => {
		const res = await claim({ ...GOOD, setupKey: `\n ${TEST_ENV.APP_ENCRYPTION_KEY}  ` });
		expect(res.status).toBe(200);
	});

	it('applies the login rules to the email and password', async () => {
		expect((await claim({ ...GOOD, email: 'not-an-email' })).status).toBe(400);
		expect((await claim({ ...GOOD, password: 'short' })).status).toBe(400);
		expect((await claim('not json')).status).toBe(400);
		expect(await accounts()).toHaveLength(0);
	});

	it('is closed once an account exists, even with the right key', async () => {
		await createTestAdmin(db);
		const res = await claim(GOOD);
		expect(res.status).toBe(409);
		expect(await accounts()).toHaveLength(1);
	});

	it('signs straight in on a local instance with SKIP_TOTP, as sign-in does', async () => {
		const jar = cookieJar();
		const res = (await claimPOST({
			request: new Request('http://localhost/api/auth/claim', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(GOOD)
			}),
			locals: { db, env: { ...TEST_ENV, skipTotp: true } },
			cookies: jar,
			url: new URL('http://localhost/api/auth/claim')
		} as never)) as Response;
		expect(res.status).toBe(200);
		expect((await res.json()).user.email).toBe('owner@example.com');
		expect(jar.get(SESSION_COOKIE)).toBeTruthy();
		expect(jar.get(MFA_COOKIE)).toBeUndefined();
	});

	it('never creates a second account when two claims race', async () => {
		const results = await Promise.all([
			claim(GOOD),
			claim({ ...GOOD, email: 'someone-else@example.com' })
		]);
		const statuses = results.map((r) => r.status).sort();
		expect(statuses).toEqual([200, 409]);
		expect(await accounts()).toHaveLength(1);
	});
});

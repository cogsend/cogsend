import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestAdmin, createTestDb, TEST_ADMIN, TEST_ENV } from '$lib/server/db/test';
import type { AppDb } from '$lib/server/db/client';
import { POST as login } from '../src/routes/api/auth/login/+server';

/**
 * The password gate is keyed on the single admin row, so it must only advance
 * for attempts against the real admin identity. Otherwise anyone could lock the
 * owner out of a self-hosted instance with eight guesses at a made-up address.
 */
function attempt(db: AppDb, email: string, password: string) {
	return login({
		request: new Request('http://localhost/api/auth/login', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ email, password })
		}),
		locals: { db, env: TEST_ENV },
		cookies: { set() {}, get: () => undefined, delete() {} },
		url: new URL('http://localhost/api/auth/login')
	} as never) as Promise<Response>;
}

describe('login gate', () => {
	let db: AppDb;
	let close: () => void;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		await createTestAdmin(db);
	});

	afterAll(() => close());

	it('does not let an unknown email lock the admin out', async () => {
		// Ten times, to pass the 8-failure threshold with room to spare.
		for (let i = 0; i < 10; i++) {
			const res = await attempt(db, 'nobody@example.com', 'whatever');
			expect(res.status).toBe(401);
			expect((await res.json()).error).toBe('Invalid credentials');
		}

		// The real credentials still work, i.e. the gate was never advanced.
		const ok = await attempt(db, TEST_ADMIN.email, TEST_ADMIN.password);
		expect(ok.status).toBe(200);
	});

	it('locks after eight wrong passwords for the real admin', async () => {
		for (let i = 0; i < 7; i++) {
			const res = await attempt(db, TEST_ADMIN.email, 'wrong-password');
			expect(res.status).toBe(401);
			expect((await res.json()).error).toBe('Invalid credentials');
		}

		const eighth = await attempt(db, TEST_ADMIN.email, 'wrong-password');
		expect((await eighth.json()).error).toMatch(/Too many attempts/);

		// Even the correct password is refused while the gate is closed.
		const blocked = await attempt(db, TEST_ADMIN.email, TEST_ADMIN.password);
		expect(blocked.status).toBe(401);
		expect((await blocked.json()).error).toMatch(/Too many attempts/);
	});
});

function attemptFrom(db: AppDb, ip: string, email: string, password: string) {
	return login({
		request: new Request('http://localhost/api/auth/login', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
			body: JSON.stringify({ email, password })
		}),
		locals: { db, env: TEST_ENV },
		cookies: { set() {}, get: () => undefined, delete() {} },
		url: new URL('http://localhost/api/auth/login')
	} as never) as Promise<Response>;
}

/**
 * With a client address, a wrong email and a wrong password get the same
 * answers: a lockout that only a wrong password could trigger would confirm
 * which email is the account's.
 */
describe('login gate by client address', () => {
	let db: AppDb;
	let close: () => void;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		await createTestAdmin(db);
	});

	afterAll(() => close());

	async function errorsFor(ip: string, email: string, password: string, times: number) {
		const errors: string[] = [];
		for (let i = 0; i < times; i++) {
			errors.push((await (await attemptFrom(db, ip, email, password)).json()).error);
		}
		return errors;
	}

	it('locks an address the same way for a wrong email as for a wrong password', async () => {
		const wrongEmail = await errorsFor('198.51.100.7', 'nobody@example.com', 'whatever', 8);
		const wrongPassword = await errorsFor('198.51.100.8', TEST_ADMIN.email, 'wrong', 8);
		expect(wrongEmail).toEqual(wrongPassword);
		expect(wrongEmail.slice(0, 7).every((e) => e === 'Invalid credentials')).toBe(true);
		expect(wrongEmail[7]).toMatch(/Too many attempts/);

		// The locked address stays locked, even with the right credentials…
		const blocked = await attemptFrom(db, '198.51.100.7', TEST_ADMIN.email, TEST_ADMIN.password);
		expect(blocked.status).toBe(401);
		// …and the owner signs in from anywhere else.
		const owner = await attemptFrom(db, '203.0.113.5', TEST_ADMIN.email, TEST_ADMIN.password);
		expect(owner.status).toBe(200);
	});

	it('never counts a wrong email against the whole account', async () => {
		// More addresses than the account-wide cap, one made-up email each.
		for (let i = 1; i <= 45; i++) {
			const res = await attemptFrom(db, `192.0.2.${i}`, 'nobody@example.com', 'whatever');
			expect((await res.json()).error).toBe('Invalid credentials');
		}
		const owner = await attemptFrom(db, '203.0.113.9', TEST_ADMIN.email, TEST_ADMIN.password);
		expect(owner.status).toBe(200);
	});
});

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_MAX_ACTIVE_USERS,
	initialStatus,
	parseRegistrationMode,
	parseUserCap,
	resolveRegistration,
	statusProblem
} from '#lib/domain/registration.js';
import type { AppDb } from '#lib/server/db/client.js';
import { invites, users } from '#lib/server/db/schema.js';
import { createTestAdmin, createTestDb, TEST_ADMIN, TEST_ENV } from '#lib/server/db/test.js';
import type { AppEnv } from '#lib/server/env.js';
import { createInvite } from '#lib/server/invites.js';
import { saveRegistrationSettings } from '#lib/server/registration.js';
import { checkSignupFormToken, signupFormToken, UNVERIFIED_HOLD_MS } from '#lib/server/signup.js';
import { MFA_COOKIE } from '#lib/server/totp.js';
import { POST as signupRoute } from '../src/routes/api/auth/signup/+server';
import { POST as verifyRoute } from '../src/routes/api/auth/signup/verify/+server';
import { POST as loginRoute } from '../src/routes/api/auth/login/+server';
import { load as signupPage } from '../src/routes/signup/+page.server';

describe('the registration rules', () => {
	it('stays off unless the environment opts in, whatever the database says', () => {
		const off = resolveRegistration({ storedMode: 'open', storedCap: '50' });
		expect(off).toMatchObject({ mode: 'off', enabled: false });
		expect(resolveRegistration({ envMode: 'banana', storedMode: 'open' }).enabled).toBe(false);
	});

	it('lets the admin override the environment once it opted in', () => {
		expect(resolveRegistration({ envMode: 'waitlist' })).toMatchObject({
			mode: 'waitlist',
			enabled: true,
			cap: DEFAULT_MAX_ACTIVE_USERS,
			modeSource: 'env',
			capSource: 'default'
		});
		expect(
			resolveRegistration({ envMode: 'open', envCap: '5', storedMode: 'off', storedCap: '7' })
		).toMatchObject({
			mode: 'off',
			enabled: true,
			cap: 7,
			modeSource: 'admin',
			capSource: 'admin'
		});
		expect(resolveRegistration({ envMode: 'Open', envCap: '5' }).cap).toBe(5);
	});

	it('parses modes and caps strictly', () => {
		expect(parseRegistrationMode(' WAITLIST ')).toBe('waitlist');
		expect(parseRegistrationMode('yes')).toBeNull();
		expect(parseUserCap('12')).toBe(12);
		for (const bad of ['0', '-1', '1.5', 'ten', '', null]) expect(parseUserCap(bad)).toBeNull();
	});

	it('decides a new account’s status from the mode, the cap and an invite', () => {
		const base = { cap: 3, activeCount: 1, invited: false };
		expect(initialStatus({ ...base, mode: 'off' })).toBeNull();
		expect(initialStatus({ ...base, mode: 'waitlist' })).toBe('pending');
		expect(initialStatus({ ...base, mode: 'open' })).toBe('active');
		expect(initialStatus({ ...base, mode: 'open', activeCount: 3 })).toBe('pending');
		expect(initialStatus({ ...base, mode: 'waitlist', invited: true })).toBe('active');
		expect(statusProblem('active')).toBeNull();
		expect(statusProblem('pending')).toMatch(/waitlist/);
		expect(statusProblem('suspended')).toMatch(/suspended/);
	});

	it('signs the form token and refuses one that is forged, stale or too quick', async () => {
		const now = Date.now();
		expect(await checkSignupFormToken(TEST_ENV, await signupFormToken(TEST_ENV, now - 5000))).toBe(
			'ok'
		);
		expect(await checkSignupFormToken(TEST_ENV, await signupFormToken(TEST_ENV, now))).toBe(
			'too-fast'
		);
		expect(await checkSignupFormToken(TEST_ENV, `${now - 5000}.deadbeef`)).toBe('invalid');
		expect(
			await checkSignupFormToken(TEST_ENV, await signupFormToken(TEST_ENV, now - 2 * 86_400_000))
		).toBe('invalid');
	});
});

describe('public sign-up', () => {
	let db: AppDb;
	let close: () => void;
	let ownerId: string;
	const sent: Array<{ to: string[]; text: string }> = [];

	beforeEach(async () => {
		({ db, close } = await createTestDb());
		ownerId = (await createTestAdmin(db, { totpEnabled: true })).id;
		sent.length = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: string, init: RequestInit) => {
				sent.push(JSON.parse(String(init.body)));
				return new Response('{}', { status: 200 });
			})
		);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		close();
	});

	const envWith = (extra: Partial<AppEnv>): AppEnv => ({ ...TEST_ENV, ...extra });
	const WAITLIST = envWith({ REGISTRATION: 'waitlist' });
	const OPEN = envWith({ REGISTRATION: 'open', MAX_ACTIVE_USERS: '2' });
	const VERIFYING = envWith({
		REGISTRATION: 'open',
		MAX_ACTIVE_USERS: '5',
		RESEND_API_KEY: 're_test',
		NOTIFY_FROM: 'CogSend <hello@example.com>'
	});

	async function signup(env: AppEnv, body: Record<string, unknown>) {
		const set: Record<string, string> = {};
		const token = await signupFormToken(env, Date.now() - 5000);
		const res = await signupRoute({
			request: new Request('https://cogsend.example/api/auth/signup', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ formToken: token, password: 'a long password', ...body })
			}),
			locals: { db, env },
			cookies: { set: (name: string, value: string) => (set[name] = value), get: () => undefined },
			url: new URL('https://cogsend.example/api/auth/signup')
		} as never);
		return { res, body: await res.json(), cookies: set };
	}

	async function login(env: AppEnv, email: string, password: string, ip = '203.0.113.9') {
		const res = await loginRoute({
			request: new Request('https://cogsend.example/api/auth/login', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
				body: JSON.stringify({ email, password })
			}),
			locals: { db, env },
			cookies: { set() {}, get: () => undefined, delete() {} },
			url: new URL('https://cogsend.example/api/auth/login')
		} as never);
		return { status: res.status, body: await res.json() };
	}

	const row = async (email: string) =>
		(await db.select().from(users).where(eq(users.email, email)))[0];

	it('does not exist while REGISTRATION is off', async () => {
		const { res } = await signup(TEST_ENV, { email: 'new@example.com' });
		expect(res.status).toBe(404);
		expect(await row('new@example.com')).toBeUndefined();
		await expect(
			signupPage({
				locals: { db, env: TEST_ENV, user: null },
				url: new URL('https://x/signup')
			} as never)
		).rejects.toMatchObject({ status: 404 });
	});

	it('puts a waitlist sign-up on hold as a member, and says so only after the right password', async () => {
		const { res, body } = await signup(WAITLIST, { email: 'Wait@Example.com' });
		expect(res.status).toBe(202);
		expect(body).toEqual({ next: 'waitlist' });
		expect(await row('wait@example.com')).toMatchObject({ role: 'member', status: 'pending' });

		const wrong = await login(WAITLIST, 'wait@example.com', 'not the password');
		expect(wrong).toEqual({ status: 401, body: { error: 'Invalid credentials' } });
		const right = await login(WAITLIST, 'wait@example.com', 'a long password');
		expect(right.status).toBe(403);
		expect(right.body.error).toMatch(/waitlist/);
	});

	it('opens accounts until the cap, then falls back to the waitlist', async () => {
		const first = await signup(OPEN, { email: 'one@example.com' });
		expect(first.body).toEqual({ needEnroll: true });
		expect(first.cookies[MFA_COOKIE]).toBeTruthy();
		expect(await row('one@example.com')).toMatchObject({ role: 'member', status: 'active' });

		const second = await signup(OPEN, { email: 'two@example.com' });
		expect(second.body).toEqual({ next: 'waitlist' });
		expect((await row('two@example.com')).status).toBe('pending');
	});

	it('answers a taken address the way it answers a waitlisted one, and changes nothing', async () => {
		const before = await row(TEST_ADMIN.email);
		const { res, body } = await signup(WAITLIST, {
			email: TEST_ADMIN.email,
			password: 'x'.repeat(20)
		});
		expect(res.status).toBe(202);
		expect(body).toEqual({ next: 'waitlist' });
		expect(await row(TEST_ADMIN.email)).toEqual(before);
		expect(await db.select().from(users)).toHaveLength(1);
	});

	it('pretends to accept what the honeypot catches, and writes nothing', async () => {
		const { res, body } = await signup(OPEN, { email: 'bot@example.com', website: 'http://spam' });
		expect(res.status).toBe(202);
		expect(body).toEqual({ next: 'waitlist' });
		expect(await row('bot@example.com')).toBeUndefined();
	});

	it('refuses a form posted without loading the page', async () => {
		const { res } = await signup(OPEN, { email: 'script@example.com', formToken: 'nope' });
		expect(res.status).toBe(400);
		expect(await row('script@example.com')).toBeUndefined();
	});

	it('lets an invite skip the waitlist once, and never after it expires', async () => {
		const invite = await createInvite(db, WAITLIST, { createdBy: ownerId });
		const used = await signup(WAITLIST, { email: 'friend@example.com', invite: invite.code });
		expect(used.body).toEqual({ needEnroll: true });
		expect((await row('friend@example.com')).status).toBe('active');
		const [stored] = await db.select().from(invites).where(eq(invites.id, invite.id));
		expect(stored.usedBy).toBe((await row('friend@example.com')).id);

		const again = await signup(WAITLIST, { email: 'other@example.com', invite: invite.code });
		expect(again.res.status).toBe(400);
		expect(await row('other@example.com')).toBeUndefined();

		const old = await createInvite(db, WAITLIST, {
			createdBy: ownerId,
			ttlDays: 1,
			now: new Date(Date.now() - 2 * 86_400_000)
		});
		const expired = await signup(WAITLIST, { email: 'late@example.com', invite: old.code });
		expect(expired.res.status).toBe(400);
	});

	it('hands an invite back when it was spent on a taken address', async () => {
		const invite = await createInvite(db, WAITLIST, { createdBy: ownerId });
		const taken = await signup(WAITLIST, { email: TEST_ADMIN.email, invite: invite.code });
		expect(taken.body).toEqual({ next: 'waitlist' });
		const reused = await signup(WAITLIST, { email: 'real@example.com', invite: invite.code });
		expect(reused.body).toEqual({ needEnroll: true });
	});

	it('closes when the admin pauses it, except to invites', async () => {
		await saveRegistrationSettings(db, { mode: 'off' });
		const closed = await signup(OPEN, { email: 'paused@example.com' });
		expect(closed.res.status).toBe(403);
		const invite = await createInvite(db, OPEN, { createdBy: ownerId });
		const invited = await signup(OPEN, { email: 'paused@example.com', invite: invite.code });
		expect(invited.body).toEqual({ needEnroll: true });
	});

	it('confirms the address by email first when a sender is configured', async () => {
		const { res, body } = await signup(VERIFYING, { email: 'mail@example.com' });
		expect(res.status).toBe(202);
		expect(body).toEqual({ next: 'verify-email' });
		expect((await row('mail@example.com')).status).toBe('unverified');
		expect(sent).toHaveLength(1);
		expect(sent[0].to).toEqual(['mail@example.com']);
		const link = sent[0].text.match(/https:\/\/\S+/)?.[0] ?? '';
		const token = new URL(link).searchParams.get('token');

		const blocked = await login(VERIFYING, 'mail@example.com', 'a long password');
		expect(blocked.status).toBe(403);
		expect(blocked.body.error).toMatch(/Confirm your email/);

		const verify = async (t: unknown) => {
			const set: Record<string, string> = {};
			const r = await verifyRoute({
				request: new Request('https://cogsend.example/api/auth/signup/verify', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ token: t })
				}),
				locals: { db, env: VERIFYING },
				cookies: { set: (n: string, v: string) => (set[n] = v), get: () => undefined },
				url: new URL('https://cogsend.example/api/auth/signup/verify')
			} as never);
			return { status: r.status, body: await r.json(), cookies: set };
		};
		expect((await verify(`${token}x`)).status).toBe(400);
		const confirmed = await verify(token);
		expect(confirmed.body).toEqual({ next: 'enroll' });
		expect(confirmed.cookies[MFA_COOKIE]).toBeTruthy();
		expect((await row('mail@example.com')).status).toBe('active');
		expect((await verify(token)).body).toEqual({ next: 'login' });
	});

	it('gives a taken address the same inbox answer and sends it nothing', async () => {
		const { body } = await signup(VERIFYING, { email: TEST_ADMIN.email });
		expect(body).toEqual({ next: 'verify-email' });
		expect(sent).toEqual([]);
	});

	it('releases an address nobody confirmed within a day', async () => {
		await signup(VERIFYING, { email: 'squat@example.com' });
		await db
			.update(users)
			.set({ createdAt: new Date(Date.now() - UNVERIFIED_HOLD_MS - 1000) })
			.where(eq(users.email, 'squat@example.com'));
		const before = (await row('squat@example.com')).id;
		await signup(VERIFYING, { email: 'squat@example.com', password: 'the real owner' });
		const after = await row('squat@example.com');
		expect(after.id).not.toBe(before);
		expect(sent).toHaveLength(2);
	});

	it('keeps one lockout per address across accounts, so it cannot tell them apart', async () => {
		await signup(OPEN, { email: 'member@example.com' });
		for (let i = 0; i < 8; i++) {
			const res = await login(OPEN, `nobody${i}@example.com`, 'guess', '198.51.100.7');
			expect(res.status).toBe(401);
		}
		// A real member's address from the same client is locked out just the
		// same: the answer does not depend on whether the account exists.
		const probe = await login(OPEN, 'member@example.com', 'guess', '198.51.100.7');
		expect(probe.body.error).toMatch(/Too many attempts/);
		const elsewhere = await login(OPEN, 'member@example.com', 'a long password', '192.0.2.1');
		expect(elsewhere.status).toBe(200);
	});
});

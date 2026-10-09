import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { sessions, users } from '$lib/server/db/schema';
import { newId, type AppDb } from '$lib/server/db/client';
import { createTestDb, TEST_ENV } from '$lib/server/db/test';
import { hashPassword, verifyPassword } from '$lib/server/crypto';
import { needsSetup } from '$lib/server/auth';
import { AUTH_GATE_MAX_FAILURES, clearAuthGate } from '$lib/server/auth-gate';
import { load as loginLoad } from '../src/routes/login/+page.server';
import { POST as loginPOST } from '../src/routes/api/auth/login/+server';
import { GET as accountGET, PATCH as accountPATCH } from '../src/routes/api/account/+server';

const sessionLocals = (db: AppDb, id: string) => ({
	db,
	env: TEST_ENV,
	authMethod: 'session' as const,
	user: { id, email: 'owner@localhost', timezone: 'UTC', totpEnabled: true, mfaVerified: true }
});

function login(db: AppDb, email: string, password: string) {
	return loginPOST({
		request: new Request('http://localhost/api/auth/login', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email, password })
		}),
		locals: { db, env: TEST_ENV },
		cookies: { set() {}, get: () => undefined, delete() {} },
		url: new URL('http://localhost/api/auth/login')
	} as never) as Promise<Response>;
}

/**
 * The account comes from `npm run setup`, or from the claim form, which needs
 * APP_ENCRYPTION_KEY (tests/claim-route.test.ts). Until then sign-in has nothing
 * to check against.
 */
describe('an instance with no account yet', () => {
	let db: AppDb;
	let close: () => void;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
	});
	afterAll(() => close());

	it('reports that setup is still needed', async () => {
		expect(await needsSetup(db)).toBe(true);
	});

	it('shows the claim form instead of the sign-in form', async () => {
		await expect(loginLoad({ locals: { db, env: TEST_ENV } } as never)).resolves.toEqual({
			notConfigured: true
		});
	});

	it('refuses a sign-in attempt outright', async () => {
		const res = await login(db, 'anyone@localhost', 'anything at all');
		expect(res.status).toBe(409);
		expect((await res.json()).error).toBe('This instance has no account yet');
	});

	it('cannot be talked into creating one over HTTP', async () => {
		const res = await login(db, 'owner@localhost', 'a long enough password');
		expect(res.status).toBe(409);
		expect(await db.select().from(users)).toHaveLength(0);
	});
});

describe('account settings', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'owner@localhost',
			passwordHash: await hashPassword('correct horse'),
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
		await db.insert(sessions).values({
			id: newId(),
			token: 'token',
			userId,
			expiresAt: new Date(Date.now() + 3600_000),
			remember: true,
			mfaVerified: true,
			createdAt: now,
			pwdFp: 'x',
			lastSeenAt: now
		});
	});
	afterAll(() => close());

	const patch = (payload: unknown, locals: unknown = sessionLocals(db, userId)) =>
		accountPATCH({
			locals,
			request: new Request('http://localhost/api/account', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			})
		} as never) as Promise<Response>;

	it('requires a session, and refuses bearer credentials', async () => {
		const bearer = { ...sessionLocals(db, userId), authMethod: 'bearer' as const };
		expect((await accountGET({ locals: bearer } as never)).status).toBe(401);
		expect((await patch({ currentPassword: 'correct horse' }, bearer)).status).toBe(401);
	});

	it('reports the account this instance is signed in as', async () => {
		const res = (await accountGET({ locals: sessionLocals(db, userId) } as never)) as Response;
		expect(await res.json()).toEqual({ email: 'owner@localhost' });
	});

	it('re-authenticates with the current password', async () => {
		// Missing (400) and wrong (401) are different answers on purpose.
		expect((await patch({ email: 'new@localhost' })).status).toBe(400);
		expect((await patch({ currentPassword: 'wrong', email: 'new@localhost' })).status).toBe(401);
		expect((await patch({ currentPassword: 'correct horse' })).status).toBe(400);
	});

	it('counts wrong passwords against the login lockout, and a good one clears it', async () => {
		// Without this the route is an unlimited oracle for the password: a
		// stolen session (the case the route exists to defend against) could
		// guess as often as it liked.
		await clearAuthGate(db, TEST_ENV, userId, 'password');
		for (let i = 1; i < AUTH_GATE_MAX_FAILURES; i++) {
			const res = await patch({ currentPassword: 'wrong', email: 'new@localhost' });
			expect(res.status, `attempt ${i}`).toBe(401);
			expect((await res.json()).error).toBe('Current password is incorrect');
		}
		// The eighth failure is the lockout, and from then on even the right
		// password is refused — for the same fifteen minutes as the login form.
		const locking = await patch({ currentPassword: 'wrong', email: 'new@localhost' });
		expect(locking.status).toBe(401);
		const locked = await patch({ currentPassword: 'correct horse', email: 'new@localhost' });
		expect(locked.status).toBe(401);
		// The gate's own message names the window; the route's names the state.
		expect((await locked.json()).error).toMatch(/Too many attempts/);

		// Leave the account usable for the tests that follow (and prove the
		// counter is what blocked them).
		await clearAuthGate(db, TEST_ENV, userId, 'password');
		const ok = await patch({ currentPassword: 'correct horse', email: 'owner@localhost' });
		expect(ok.status).toBe(200);
	});

	it('changes the email without touching the password', async () => {
		const res = await patch({ currentPassword: 'correct horse', email: 'New@LocalHost' });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({ email: 'new@localhost', reauth: false });
		const row = (await db.select().from(users).where(eq(users.id, userId)))[0]!;
		expect(row.email).toBe('new@localhost');
		expect(await verifyPassword('correct horse', row.passwordHash)).toBe(true);
	});

	it('changes the password, refuses a repeat, and revokes every session', async () => {
		expect((await patch({ currentPassword: 'correct horse', newPassword: 'short' })).status).toBe(
			400
		);
		expect(
			(await patch({ currentPassword: 'correct horse', newPassword: 'correct horse' })).status
		).toBe(400);

		const res = await patch({ currentPassword: 'correct horse', newPassword: 'a longer one' });
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ reauth: true });
		const row = (await db.select().from(users).where(eq(users.id, userId)))[0]!;
		expect(await verifyPassword('a longer one', row.passwordHash)).toBe(true);
		expect(await db.select().from(sessions)).toHaveLength(0);
	});
});

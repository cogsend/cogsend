import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { appSettings, users } from '$lib/server/db/schema';
import { newId, type AppDb } from '$lib/server/db/client';
import { createTestDb, TEST_ENV } from '$lib/server/db/test';
import { decryptSecret, hashPassword } from '$lib/server/crypto';
import { clearAuthGate } from '$lib/server/auth-gate';
import { tokenFromUnlockKey } from '$lib/server/updater/saved-token';
import { readSavedToken, readUnlockedToken } from '$lib/server/updater/state';
import {
	DELETE as forgetDELETE,
	POST as rememberPOST
} from '../src/routes/api/update/remember/+server';
import { POST as unlockPOST } from '../src/routes/api/update/unlock/+server';
import { POST as stepPOST } from '../src/routes/api/update/[step]/+server';
import { GET as statusGET } from '../src/routes/api/update/+server';
import { PATCH as accountPATCH } from '../src/routes/api/account/+server';

/**
 * The Cloudflare token remembered between updates, locked with the account
 * password: Settings only ever sees its last four characters, D1 plus
 * APP_ENCRYPTION_KEY cannot open it, and each update step gets it through a
 * one-update key instead of the token itself.
 */
const TOKEN = 'cf_saved_token_never_shown_0123456789abcd';
const PASSWORD = 'correct horse battery';

describe('the saved update token', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;

	const locals = (authMethod: 'session' | 'bearer' = 'session') => ({
		db,
		env: TEST_ENV,
		authMethod,
		user: {
			id: userId,
			email: 'owner@localhost',
			timezone: 'UTC',
			totpEnabled: true,
			mfaVerified: true
		}
	});
	const json = (url: string, method: string, body?: unknown) =>
		new Request(`http://localhost${url}`, {
			method,
			headers: { 'Content-Type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		});
	const remember = (body: unknown, auth: 'session' | 'bearer' = 'session') =>
		rememberPOST({
			locals: locals(auth),
			request: json('/api/update/remember', 'POST', body)
		} as never) as Promise<Response>;
	const unlock = (password: string) =>
		unlockPOST({
			locals: locals(),
			request: json('/api/update/unlock', 'POST', { password })
		} as never) as Promise<Response>;
	const status = async () =>
		(await (
			(await statusGET({ locals: locals(), platform: { env: {} } } as never)) as Response
		).json()) as { savedToken: { hint: string; savedAt: number } | null };

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		userId = newId();
		const now = new Date();
		await db.insert(users).values({
			id: userId,
			email: 'owner@localhost',
			passwordHash: await hashPassword(PASSWORD),
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
	});
	afterAll(() => close());

	it('is saved only from a session, with the right password', async () => {
		expect((await remember({ token: TOKEN, password: PASSWORD }, 'bearer')).status).toBe(401);
		const wrong = await remember({ token: TOKEN, password: 'not it' });
		expect(wrong.status).toBe(401);
		expect(await readSavedToken(db)).toBeNull();
		expect((await remember({ token: 'short', password: PASSWORD })).status).toBe(400);
		await clearAuthGate(db, TEST_ENV, userId, 'password-all');
	});

	it('is locked with the password, so D1 and APP_ENCRYPTION_KEY cannot open it', async () => {
		const res = await remember({ token: TOKEN, password: PASSWORD });
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).not.toContain(TOKEN);
		expect(JSON.parse(text).savedToken.hint).toBe('abcd');

		const rows = await db.select().from(appSettings);
		expect(JSON.stringify(rows)).not.toContain(TOKEN);
		const saved = (await readSavedToken(db))!;
		await expect(decryptSecret(saved.payload, TEST_ENV.APP_ENCRYPTION_KEY)).rejects.toThrow();
		expect((await status()).savedToken).toEqual({ hint: 'abcd', savedAt: saved.savedAt });
	});

	it('opens with the password into a one-update key, and never hands out the token', async () => {
		expect((await unlock('not it')).status).toBe(401);
		const res = await unlock(PASSWORD);
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).not.toContain(TOKEN);
		const { unlockKey } = JSON.parse(text) as { unlockKey: string };
		expect(unlockKey).toMatch(/^[0-9a-f]{64}$/);

		expect(await tokenFromUnlockKey(db, unlockKey)).toBe(TOKEN);
		await expect(tokenFromUnlockKey(db, 'f'.repeat(64))).rejects.toThrow('password again');
		const { expiresAt } = (await readUnlockedToken(db))!;
		await expect(tokenFromUnlockKey(db, unlockKey, expiresAt + 1)).rejects.toThrow(
			'password again'
		);
	});

	it('reaches Cloudflare as the token when a step sends the key', async () => {
		const { unlockKey } = (await (await unlock(PASSWORD)).json()) as { unlockKey: string };
		const original = globalThis.fetch;
		const seen: string[] = [];
		globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			seen.push(new Headers(init?.headers).get('authorization') ?? '');
			return new Response(
				JSON.stringify({ success: false, errors: [{ code: 9109, message: 'nope' }] }),
				{
					status: 403
				}
			);
		}) as typeof fetch;
		try {
			const step = (body: unknown) =>
				stepPOST({
					params: { step: 'target' },
					locals: locals(),
					platform: { env: { MEDIA: {} } },
					url: new URL('http://localhost/settings'),
					request: json('/api/update/target', 'POST', body)
				} as never) as Promise<Response>;
			const res = await step({ unlockKey });
			expect(res.status).toBe(403);
			expect(seen).toEqual([`Bearer ${TOKEN}`]);
			expect(await res.text()).not.toContain(TOKEN);
			expect((await step({ unlockKey: 'f'.repeat(64) })).status).toBe(401);
		} finally {
			globalThis.fetch = original;
		}
	});

	it('is gone after a password change, and after Forget', async () => {
		const res = (await accountPATCH({
			locals: locals(),
			request: json('/api/account', 'PATCH', {
				currentPassword: PASSWORD,
				newPassword: 'a different long password'
			})
		} as never)) as Response;
		expect(res.status).toBe(200);
		expect(await readSavedToken(db)).toBeNull();
		expect(await readUnlockedToken(db)).toBeNull();
		await db
			.update(users)
			.set({ passwordHash: await hashPassword(PASSWORD) })
			.where(eq(users.id, userId));

		await remember({ token: TOKEN, password: PASSWORD });
		await forgetDELETE({ locals: locals() } as never);
		expect((await status()).savedToken).toBeNull();
	});

	it('is dropped, with a reason, when it was locked with an earlier password', async () => {
		await remember({ token: TOKEN, password: PASSWORD });
		// `npm run admin:reset` changes the password without the old one.
		await db
			.update(users)
			.set({ passwordHash: await hashPassword('reset from the terminal') })
			.where(eq(users.id, userId));
		const res = await unlock('reset from the terminal');
		expect(res.status).toBe(409);
		expect((await res.json()).error).toContain('earlier password');
		expect(await readSavedToken(db)).toBeNull();
	});
});

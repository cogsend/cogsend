import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rotateApiKey, verifyApiKey } from '#lib/server/api-keys.js';
import { createSession, type SessionUser } from '#lib/server/auth.js';
import { newId, type AppDb } from '#lib/server/db/client.js';
import {
	apiKeys,
	connections,
	draftMedia,
	drafts,
	publishTargets,
	sessions,
	users
} from '#lib/server/db/schema.js';
import { createTestAdmin, createTestDb, TEST_ADMIN, TEST_ENV } from '#lib/server/db/test.js';
import type { AppEnv } from '#lib/server/env.js';
import { memoryMediaStore, previewKey } from '#lib/server/media.js';
import { registrationConfig } from '#lib/server/registration.js';
import { claimDueTargets, maybeSendFailureDigest } from '#lib/server/scheduler.js';
import { wouldOrphanInstance } from '#lib/server/users.js';
import * as usersRoute from '../src/routes/api/admin/users/+server';
import * as userRoute from '../src/routes/api/admin/users/[id]/+server';
import * as invitesRoute from '../src/routes/api/admin/invites/+server';
import * as inviteRoute from '../src/routes/api/admin/invites/[id]/+server';
import * as registrationRoute from '../src/routes/api/admin/registration/+server';
import * as meRoute from '../src/routes/api/auth/me/+server';

/**
 * What the admin can do to other accounts, and the two things nobody can do:
 * leave an instance with members and no admin, or delete an account without
 * its R2 objects going too.
 */
let db: AppDb;
let close: () => void;
let media: ReturnType<typeof memoryMediaStore>;
let owner: SessionUser;
let memberId: string;

const ON: AppEnv = { ...TEST_ENV, REGISTRATION: 'waitlist' };

function asUser(row: { id: string; email: string }, role: 'admin' | 'member'): SessionUser {
	return {
		id: row.id,
		email: row.email,
		timezone: 'UTC',
		totpEnabled: true,
		mfaVerified: true,
		role
	};
}

async function addMember(email: string, status: 'active' | 'pending' = 'active') {
	const row = await createTestAdmin(db, { email, totpEnabled: true });
	await db.update(users).set({ role: 'member', status }).where(eq(users.id, row.id));
	return row;
}

async function call(
	handler: (event: never) => Promise<Response> | Response,
	user: SessionUser,
	opts: { method?: string; params?: Record<string, string>; body?: unknown; env?: AppEnv } = {}
) {
	const url = new URL('https://cogsend.example/api/admin/x');
	const res = await handler({
		request: new Request(url, {
			method: opts.method ?? 'POST',
			headers: { 'content-type': 'application/json' },
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
		}),
		locals: {
			db,
			env: opts.env ?? ON,
			media,
			user,
			authMethod: 'session',
			authCredential: 'session',
			apiKeyScopes: null
		},
		params: opts.params ?? {},
		url,
		cookies: { set() {}, delete() {}, get: () => undefined }
	} as never);
	return { status: res.status, body: await res.json() };
}

beforeEach(async () => {
	({ db, close } = await createTestDb());
	media = memoryMediaStore();
	const row = await createTestAdmin(db, { totpEnabled: true });
	owner = asUser(row, 'admin');
	memberId = (await addMember('member@example.com')).id;
});
afterEach(() => close());

describe('the Users page API', () => {
	it('lists every account with the cap usage', async () => {
		await addMember('waiting@example.com', 'pending');
		const { status, body } = await call(usersRoute.GET, owner, { method: 'GET' });
		expect(status).toBe(200);
		expect(
			body.users.map((u: { email: string; role: string; status: string }) => [
				u.email,
				u.role,
				u.status
			])
		).toEqual([
			[TEST_ADMIN.email, 'admin', 'active'],
			['member@example.com', 'member', 'active'],
			['waiting@example.com', 'member', 'pending']
		]);
		expect(body.registration).toMatchObject({
			enabled: true,
			mode: 'waitlist',
			activeCount: 2,
			pendingCount: 1
		});
	});

	it('approves a waiting account', async () => {
		const waiting = await addMember('waiting@example.com', 'pending');
		const res = await call(userRoute.PATCH, owner, {
			method: 'PATCH',
			params: { id: waiting.id },
			body: { status: 'active' }
		});
		expect(res.status).toBe(200);
		const [row] = await db.select().from(users).where(eq(users.id, waiting.id));
		expect(row.status).toBe('active');
	});

	it('suspends an account and signs it out everywhere', async () => {
		await createSession(db, TEST_ENV, memberId, true, true, 'x');
		const res = await call(userRoute.PATCH, owner, {
			method: 'PATCH',
			params: { id: memberId },
			body: { status: 'suspended' }
		});
		expect(res.status).toBe(200);
		expect(await db.select().from(sessions).where(eq(sessions.userId, memberId))).toEqual([]);
	});

	it('refuses to change the admin’s own account, or to strand the members', async () => {
		const self = await call(userRoute.PATCH, owner, {
			method: 'PATCH',
			params: { id: owner.id },
			body: { role: 'member' }
		});
		expect(self.status).toBe(400);
		expect(await wouldOrphanInstance(db, owner.id)).toBe(true);

		// A second admin may demote the first once there is one left.
		const second = await addMember('second@example.com');
		await db.update(users).set({ role: 'admin' }).where(eq(users.id, second.id));
		expect(await wouldOrphanInstance(db, owner.id)).toBe(false);
		const demoted = await call(userRoute.PATCH, asUser(second, 'admin'), {
			method: 'PATCH',
			params: { id: owner.id },
			body: { role: 'member' }
		});
		expect(demoted.status).toBe(200);
		expect(await wouldOrphanInstance(db, second.id)).toBe(true);
	});

	it('will not let the only admin delete themselves while members remain', async () => {
		const res = await call(meRoute.DELETE, owner, {
			method: 'DELETE',
			body: { password: TEST_ADMIN.password, code: '000000' },
			env: { ...ON, skipTotp: true }
		});
		expect(res.status).toBe(409);
		expect(await db.select().from(users).where(eq(users.id, owner.id))).toHaveLength(1);
	});

	it('deletes an account with its rows, its R2 objects and its keys', async () => {
		const now = new Date();
		const draft = newId();
		await db.insert(drafts).values({
			id: draft,
			userId: memberId,
			baseBody: 'mine',
			createdAt: now,
			updatedAt: now
		});
		const key = '1700000000000-cccccccccccccccc.jpg';
		await db.insert(draftMedia).values({
			id: newId(),
			draftId: draft,
			storageKey: key,
			mime: 'image/jpeg',
			size: 3,
			createdAt: now
		});
		await media.put(key, new Uint8Array([1, 2, 3]), 'image/jpeg');
		await media.put(previewKey(key), new Uint8Array([4]), 'image/jpeg');
		const connection = newId();
		await db.insert(connections).values({
			id: connection,
			userId: memberId,
			platform: 'bluesky',
			credentialsEncrypted: '{}',
			createdAt: now,
			updatedAt: now
		});
		await db.insert(publishTargets).values({
			id: newId(),
			draftId: draft,
			connectionId: connection,
			createdAt: now,
			updatedAt: now
		});
		const apiKey = (await rotateApiKey(db, memberId)).raw;
		await createSession(db, TEST_ENV, memberId, true, true, 'x');

		const wrong = await call(userRoute.DELETE, owner, {
			method: 'DELETE',
			params: { id: memberId },
			body: { password: 'not mine' }
		});
		expect(wrong.status).toBe(401);
		expect(await media.get(key)).not.toBeNull();

		const res = await call(userRoute.DELETE, owner, {
			method: 'DELETE',
			params: { id: memberId },
			body: { password: TEST_ADMIN.password }
		});
		expect(res).toEqual({ status: 200, body: { ok: true, deletedMedia: 1 } });
		expect(await media.get(key)).toBeNull();
		expect(await media.get(previewKey(key))).toBeNull();
		for (const table of [drafts, connections, apiKeys, sessions]) {
			expect(await db.select().from(table).where(eq(table.userId, memberId))).toEqual([]);
		}
		expect(await db.select().from(publishTargets)).toEqual([]);
		expect(await verifyApiKey(db, apiKey)).toBeNull();
	});

	it('will not delete the admin’s own account from here', async () => {
		const res = await call(userRoute.DELETE, owner, {
			method: 'DELETE',
			params: { id: owner.id },
			body: { password: TEST_ADMIN.password }
		});
		expect(res.status).toBe(400);
	});
});

describe('invites and sign-up controls', () => {
	it('are refused while the environment has sign-up off', async () => {
		expect((await call(invitesRoute.POST, owner, { body: {}, env: TEST_ENV })).status).toBe(409);
		expect(
			(
				await call(registrationRoute.PATCH, owner, {
					method: 'PATCH',
					body: { mode: 'open' },
					env: TEST_ENV
				})
			).status
		).toBe(409);
		expect((await registrationConfig(db, TEST_ENV)).enabled).toBe(false);
	});

	it('mint a link shown once, list it without the code, and revoke it', async () => {
		const created = await call(invitesRoute.POST, owner, { body: { note: 'Sam', ttlDays: 3 } });
		expect(created.status).toBe(201);
		expect(created.body.link).toMatch(/\/signup\?invite=inv_[0-9a-f]{32}$/);
		const listed = await call(invitesRoute.GET, owner, { method: 'GET' });
		expect(listed.body.invites).toHaveLength(1);
		expect(JSON.stringify(listed.body)).not.toContain(created.body.link.split('=')[1]);
		expect(listed.body.invites[0]).toMatchObject({ note: 'Sam', state: 'open' });
		const revoked = await call(inviteRoute.DELETE, owner, {
			method: 'DELETE',
			params: { id: created.body.id }
		});
		expect(revoked.status).toBe(200);
		expect((await call(invitesRoute.GET, owner, { method: 'GET' })).body.invites).toEqual([]);
	});

	it('save the mode and cap, and validate them', async () => {
		const saved = await call(registrationRoute.PATCH, owner, {
			method: 'PATCH',
			body: { mode: 'open', cap: 25 }
		});
		expect(saved.status).toBe(200);
		expect(saved.body.registration).toMatchObject({ mode: 'open', cap: 25, modeSource: 'admin' });
		const bad = await call(registrationRoute.PATCH, owner, { method: 'PATCH', body: { cap: 0 } });
		expect(bad.status).toBe(400);
		const reset = await call(registrationRoute.PATCH, owner, {
			method: 'PATCH',
			body: { mode: null, cap: null }
		});
		expect(reset.body.registration).toMatchObject({ mode: 'waitlist', modeSource: 'env' });
	});
});

describe('the failure digest on an instance with members', () => {
	it('tells the operator about the admins’ failures only', async () => {
		const now = new Date();
		for (const [userId, body] of [
			[owner.id, 'owner post'],
			[memberId, 'member private post']
		] as const) {
			const draft = newId();
			const connection = newId();
			await db
				.insert(drafts)
				.values({ id: draft, userId, baseBody: body, createdAt: now, updatedAt: now });
			await db.insert(connections).values({
				id: connection,
				userId,
				platform: 'bluesky',
				credentialsEncrypted: '{}',
				createdAt: now,
				updatedAt: now
			});
			await db.insert(publishTargets).values({
				id: newId(),
				draftId: draft,
				connectionId: connection,
				status: 'failed',
				errorMessage: 'boom',
				createdAt: now,
				updatedAt: now
			});
		}
		let mail = '';
		const result = await maybeSendFailureDigest(
			db,
			{ ...TEST_ENV, RESEND_API_KEY: 're_x', NOTIFY_EMAIL: 'ops@example.com' },
			{
				fetchImpl: (async (_url: string, init: RequestInit) => {
					mail = String(init.body);
					return new Response('{}');
				}) as typeof fetch
			}
		);
		expect(result).toMatchObject({ sent: true, failedCount: 1 });
		expect(mail).toContain('owner post');
		expect(mail).not.toContain('member private post');
	});
});

describe('a single-user instance', () => {
	it('shows no Users page and no sign-up link while it has one account and REGISTRATION is off', async () => {
		const { load: layoutLoad } = await import('../src/routes/+layout.server');
		const { load: loginLoad } = await import('../src/routes/login/+page.server');
		await db.delete(users).where(eq(users.id, memberId));
		const layout = (await layoutLoad({ locals: { db, env: TEST_ENV, user: owner } } as never)) as {
			showUsers: boolean;
		};
		expect(layout.showUsers).toBe(false);
		const login = (await loginLoad({ locals: { db, env: TEST_ENV, user: null } } as never)) as {
			signup?: boolean;
		};
		expect(login.signup).toBe(false);
	});

	it('shows the Users page again once a second account exists, even with REGISTRATION off', async () => {
		const { load: layoutLoad } = await import('../src/routes/+layout.server');
		const asOwner = (await layoutLoad({ locals: { db, env: TEST_ENV, user: owner } } as never)) as {
			showUsers: boolean;
		};
		expect(asOwner.showUsers).toBe(true);
		const asMember = (await layoutLoad({
			locals: { db, env: TEST_ENV, user: asUser({ id: memberId, email: 'm' }, 'member') }
		} as never)) as { showUsers: boolean };
		expect(asMember.showUsers).toBe(false);
	});
});

describe('the scheduler and suspended accounts', () => {
	it('holds a suspended account’s due posts until it is reinstated', async () => {
		const now = new Date();
		const draft = newId();
		const connection = newId();
		await db.insert(drafts).values({ id: draft, userId: memberId, createdAt: now, updatedAt: now });
		await db.insert(connections).values({
			id: connection,
			userId: memberId,
			platform: 'bluesky',
			credentialsEncrypted: '{}',
			createdAt: now,
			updatedAt: now
		});
		const target = newId();
		await db.insert(publishTargets).values({
			id: target,
			draftId: draft,
			connectionId: connection,
			status: 'scheduled',
			scheduledFor: new Date(now.getTime() - 60_000),
			createdAt: now,
			updatedAt: now
		});
		expect((await claimDueTargets(db, now)).map((t) => t.id)).toEqual([target]);
		await db.update(users).set({ status: 'suspended' }).where(eq(users.id, memberId));
		expect(await claimDueTargets(db, now)).toEqual([]);
		await db.update(users).set({ status: 'active' }).where(eq(users.id, memberId));
		expect((await claimDueTargets(db, now)).map((t) => t.id)).toEqual([target]);
	});
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { users } from '#lib/server/db/schema.js';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { createTestDb } from '#lib/server/db/test.js';
import {
	getActiveApiKey,
	hashApiKey,
	isApiKeyFormat,
	revokeApiKeys,
	rotateApiKey,
	verifyApiKey
} from '../src/lib/server/api-keys';
import { requireSession, requireUser } from '../src/lib/server/require';
import { DELETE as keyDELETE, GET as keyGET, POST as keyPOST } from '../src/routes/api/key/+server';

const sessionLocals = (db: AppDb, id: string) => ({
	db,
	authMethod: 'session' as const,
	user: { id, email: 'keys@localhost', timezone: 'UTC', totpEnabled: true, mfaVerified: true }
});
const bearerLocals = (db: AppDb, id: string) => ({
	db,
	authMethod: 'bearer' as const,
	user: { id, email: 'keys@localhost', timezone: 'UTC', totpEnabled: true, mfaVerified: true }
});

describe('api keys', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'keys@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
	});
	afterAll(() => close());

	it('rejects non-key formats without hashing or querying', async () => {
		expect(isApiKeyFormat(null)).toBe(false);
		expect(isApiKeyFormat('')).toBe(false);
		expect(isApiKeyFormat('Bearer cog_abc')).toBe(false);
		expect(isApiKeyFormat('cog_short')).toBe(false);
		expect(isApiKeyFormat('cog_' + 'zz'.repeat(32))).toBe(false);
		expect(isApiKeyFormat('token_' + 'a'.repeat(64))).toBe(false);
		expect(await verifyApiKey(db, 'not-a-key')).toBeNull();
		expect(await verifyApiKey(db, null)).toBeNull();
	});

	it('rotates, verifies, and revokes with single-active semantics', async () => {
		expect(await getActiveApiKey(db, userId)).toBeNull();

		const first = await rotateApiKey(db, userId);
		expect(isApiKeyFormat(first.raw)).toBe(true);
		expect(first.raw.startsWith('cog_')).toBe(true);
		expect(first.prefix).toBe(first.raw.slice(0, 12));

		// Raw key verifies; the stored value is a hash, not the key.
		const verified = await verifyApiKey(db, first.raw);
		expect(verified).toMatchObject({ userId });
		const stored = await getActiveApiKey(db, userId);
		expect(stored?.keyHash).not.toContain(first.raw);
		expect(stored?.keyHash).toBe(await hashApiKey(first.raw));
		expect(stored?.prefix).toBe(first.prefix);

		// Rotation revokes the old key and mints a working replacement.
		const second = await rotateApiKey(db, userId);
		expect(second.raw).not.toBe(first.raw);
		expect(await verifyApiKey(db, first.raw)).toBeNull();
		expect(await verifyApiKey(db, second.raw)).toMatchObject({ userId });

		// Revoke kills the replacement; double revoke reports zero.
		expect(await revokeApiKeys(db, userId)).toBe(1);
		expect(await verifyApiKey(db, second.raw)).toBeNull();
		expect(await getActiveApiKey(db, userId)).toBeNull();
		expect(await revokeApiKeys(db, userId)).toBe(0);
	});

	it('key endpoints require a cookie session, never a bearer', async () => {
		const denied = (await keyGET({ locals: bearerLocals(db, userId) } as never)) as Response;
		expect(denied.status).toBe(401);
		const deniedPost = (await keyPOST({ locals: bearerLocals(db, userId) } as never)) as Response;
		expect(deniedPost.status).toBe(401);
		const deniedDelete = (await keyDELETE({
			locals: bearerLocals(db, userId)
		} as never)) as Response;
		expect(deniedDelete.status).toBe(401);

		// Session GET with no key reports null; DELETE with no key is 404.
		const empty = (await keyGET({ locals: sessionLocals(db, userId) } as never)) as Response;
		expect(empty.status).toBe(200);
		expect(await empty.json()).toEqual({ active: null });
		const noKey = (await keyDELETE({ locals: sessionLocals(db, userId) } as never)) as Response;
		expect(noKey.status).toBe(404);

		// Session POST mints a key exactly once in the response.
		const minted = (await keyPOST({ locals: sessionLocals(db, userId) } as never)) as Response;
		expect(minted.status).toBe(201);
		const body = (await minted.json()) as { key: string; prefix: string };
		expect(isApiKeyFormat(body.key)).toBe(true);
		expect(await verifyApiKey(db, body.key)).toMatchObject({ userId });

		// ...and session DELETE revokes it.
		const revoked = (await keyDELETE({
			locals: sessionLocals(db, userId)
		} as never)) as Response;
		expect(revoked.status).toBe(200);
		expect(await revoked.json()).toEqual({ ok: true, revoked: 1 });
		expect(await verifyApiKey(db, body.key)).toBeNull();
	});

	it('rotation accepts scopes and verify round-trips them', async () => {
		const json = (scopes: unknown) =>
			keyPOST({
				request: new Request('http://localhost/api/key', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ scopes })
				}),
				locals: sessionLocals(db, userId)
			} as never) as Promise<Response>;
		const readOnly = (await (await json(['read'])).json()) as {
			key: string;
			scopes: string[];
		};
		expect(readOnly.scopes).toEqual(['read']);
		expect(await verifyApiKey(db, readOnly.key)).toMatchObject({
			userId,
			scopes: ['read']
		});
		// Unknown entries are dropped; empty falls back to full access.
		const fallback = (await (await json(['root'])).json()) as { scopes: string[] };
		expect(fallback.scopes).toEqual(['read', 'write']);
	});

	it('replaces the active key sequentially with the selected scopes', async () => {
		const create = (scopes: string[]) =>
			keyPOST({
				request: new Request('http://localhost/api/key', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ scopes })
				}),
				locals: sessionLocals(db, userId)
			} as never) as Promise<Response>;
		const firstResponse = await create(['read']);
		const first = (await firstResponse.json()) as { key: string; scopes: string[] };
		expect(first.scopes).toEqual(['read']);
		const secondResponse = await create(['read', 'write']);
		const second = (await secondResponse.json()) as { key: string; scopes: string[] };
		expect(second.scopes).toEqual(['read', 'write']);
		expect(await verifyApiKey(db, first.key)).toBeNull();
		expect(await verifyApiKey(db, second.key)).toMatchObject({
			userId,
			scopes: ['read', 'write']
		});
	});

	it('rejects a malformed body instead of minting a full-access key', async () => {
		const before = (await keyGET({ locals: sessionLocals(db, userId) } as never)) as Response;
		const activeBefore = ((await before.json()) as { active: { prefix: string } | null }).active;
		// A truncated request meant to mint a read-only key must not come back
		// 201 with a write key: `normalizeApiScopes` reads a missing list as all
		// scopes, so the request has to fail before it gets there.
		const post = (body: string) =>
			keyPOST({
				request: new Request('http://localhost/api/key', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body
				}),
				locals: sessionLocals(db, userId)
			} as never) as Promise<Response>;

		const truncated = await post('{"scopes":["read"');
		expect(truncated.status).toBe(400);
		expect(await truncated.json()).toEqual({ error: 'Invalid JSON body' });

		const notAnArray = await post(JSON.stringify({ scopes: 'read' }));
		expect(notAnArray.status).toBe(400);
		expect(await notAnArray.json()).toEqual({ error: 'scopes must be an array' });

		// Neither attempt minted anything: the active key is the one the earlier
		// test left behind, untouched.
		const active = (await keyGET({ locals: sessionLocals(db, userId) } as never)) as Response;
		const payload = (await active.json()) as { active: { prefix: string; createdAt: string } };
		expect(payload.active.prefix).toBe(activeBefore?.prefix);
	});

	it('requireSession rejects bearers while requireUser still accepts verified users', () => {
		const verified = {
			id: 'u',
			email: 'e',
			timezone: 'UTC',
			totpEnabled: true,
			mfaVerified: true
		};
		expect(requireSession(verified, 'session')).toBe(verified);
		expect(() => requireSession(verified, 'bearer')).toThrowError();
		expect(() => requireSession(verified, null)).toThrowError();
		expect(() => requireSession(null, 'session')).toThrowError();
		// Existing session routes are untouched: verified bearer users pass.
		expect(requireUser(verified)).toBe(verified);
	});
});

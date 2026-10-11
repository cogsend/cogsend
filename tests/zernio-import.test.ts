import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { decryptJson, encryptJson } from '#lib/server/crypto.js';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { connections, users } from '#lib/server/db/schema.js';
import { createTestDb, TEST_ENV } from '#lib/server/db/test.js';
import {
	resolveZernioKey,
	storedZernioKey,
	toImportable,
	upsertZernioConnection,
	zernioCallbackUrl,
	zernioKeyProblem
} from '#lib/server/zernio-import.js';
import { zernioHttpError, type ZernioAccount } from '#lib/server/zernio.js';

const account = (over: Partial<ZernioAccount> = {}): ZernioAccount => ({
	_id: 'acc-1',
	platform: 'twitter',
	profileId: { _id: 'p1', name: 'Brand' },
	username: '@acme',
	displayName: 'Acme',
	profilePicture: 'https://img.example/a.png',
	isActive: true,
	...over
});

describe('zernio import', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		userId = newId();
		const now = new Date();
		await db.insert(users).values({
			id: userId,
			email: 'zernio@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
	});
	afterAll(() => close());

	it('reads an inactive Zernio account as needing a reconnect, on import too', async () => {
		expect(
			toImportable(account({ _id: 'acc-off', isActive: false }), new Set())?.needsReconnection
		).toBe(true);
		const row = await upsertZernioConnection({
			db,
			env: TEST_ENV,
			userId,
			apiKey: 'zk_1',
			account: account({ _id: 'acc-off', platform: 'bluesky', isActive: false })
		});
		expect(row.status).toBe('expired');
	});

	it('describes an account for the dialog and drops what CogSend cannot post to', () => {
		const imported = new Set(['acc-9']);
		expect(toImportable(account(), imported)).toEqual({
			id: 'acc-1',
			platform: 'x',
			profileId: 'p1',
			handle: 'acme',
			displayName: 'Acme',
			avatarUrl: 'https://img.example/a.png',
			needsReconnection: false,
			imported: false
		});
		expect(toImportable(account({ _id: 'acc-9' }), imported)?.imported).toBe(true);
		expect(toImportable(account({ platform: 'instagram' }), imported)).toBeNull();
		// Created as a side effect of an ads connect: Zernio's own UI hides it.
		expect(toImportable(account({ enabled: false }), imported)).toBeNull();
	});

	it('creates a row with the marker, the key and the account id', async () => {
		const row = await upsertZernioConnection({
			db,
			env: TEST_ENV,
			userId,
			apiKey: 'zk_1',
			account: account()
		});
		expect(row.platform).toBe('x');
		expect(row.handle).toBe('acme');
		expect(row.displayName).toBe('Acme');
		expect(row.status).toBe('active');
		expect(JSON.parse(row.metaJson)).toEqual({
			provider: 'zernio',
			zernioAccountId: 'acc-1',
			zernioProfileId: 'p1'
		});
		expect(await decryptJson(row.credentialsEncrypted, TEST_ENV.APP_ENCRYPTION_KEY)).toEqual({
			zernioApiKey: 'zk_1',
			zernioAccountId: 'acc-1'
		});
		expect(await storedZernioKey({ db, env: TEST_ENV, userId })).toBe('zk_1');
	});

	it('re-importing refreshes the same row instead of adding one', async () => {
		const again = await upsertZernioConnection({
			db,
			env: TEST_ENV,
			userId,
			apiKey: 'zk_2',
			account: account({ displayName: 'Acme Inc', needsReconnection: true })
		});
		const rows = await db
			.select()
			.from(connections)
			.where(and(eq(connections.userId, userId), eq(connections.platform, 'x')));
		expect(rows).toHaveLength(1);
		expect(again.id).toBe(rows[0].id);
		expect(again.displayName).toBe('Acme Inc');
		expect(again.status).toBe('expired');
		expect(await storedZernioKey({ db, env: TEST_ENV, userId })).toBe('zk_2');
	});

	it('never touches a direct connection with the same handle', async () => {
		const directId = newId();
		const now = new Date();
		const directCreds = await encryptJson({ accessToken: 'direct' }, TEST_ENV.APP_ENCRYPTION_KEY);
		await db.insert(connections).values({
			id: directId,
			userId,
			platform: 'threads',
			handle: 'acme',
			credentialsEncrypted: directCreds,
			metaJson: JSON.stringify({ threadsUserId: '42' }),
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
		const viaZernio = await upsertZernioConnection({
			db,
			env: TEST_ENV,
			userId,
			apiKey: 'zk_2',
			account: account({ _id: 'acc-t', platform: 'threads' })
		});
		expect(viaZernio.id).not.toBe(directId);
		const direct = (await db.select().from(connections).where(eq(connections.id, directId)))[0];
		expect(direct.credentialsEncrypted).toBe(directCreds);
		expect(direct.metaJson).toBe(JSON.stringify({ threadsUserId: '42' }));
	});

	it('resolves the key from the request first, then from a stored row', async () => {
		expect(await resolveZernioKey({ db, env: TEST_ENV, userId, apiKey: ' zk_new ' })).toBe(
			'zk_new'
		);
		expect(await resolveZernioKey({ db, env: TEST_ENV, userId })).toBe('zk_2');
		const stranger = newId();
		await expect(resolveZernioKey({ db, env: TEST_ENV, userId: stranger })).rejects.toMatchObject({
			status: 400
		});
	});

	it('turns a rejected or under-scoped key into a sentence, and leaves the rest alone', async () => {
		const auth = zernioKeyProblem(zernioHttpError('list', 401, '{"error":"Invalid API key"}'));
		expect(auth?.status).toBe(400);
		expect(((await auth!.json()) as { error: string }).error).toBe('Zernio rejected this API key');
		const scoped = zernioKeyProblem(
			zernioHttpError('list', 403, '{"error":"This key cannot access accounts"}')
		);
		expect(((await scoped!.json()) as { error: string }).error).toBe(
			'This Zernio API key cannot be used here: This key cannot access accounts'
		);
		expect(zernioKeyProblem(zernioHttpError('list', 503, 'down'))).toBeNull();
		expect(zernioKeyProblem(new Error('boom'))).toBeNull();
	});

	it('builds the callback URL Zernio redirects to, with the bound state', () => {
		const url = new URL(zernioCallbackUrl('https://cog.example/', 'abc.def'));
		expect(url.origin + url.pathname).toBe('https://cog.example/api/connections/zernio/callback');
		expect(url.searchParams.get('pending')).toBe('abc.def');
	});
});

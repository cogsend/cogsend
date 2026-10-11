import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { encryptJson } from '#lib/server/crypto.js';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { connections, drafts, publishTargets, users } from '#lib/server/db/schema.js';
import { createTestDb, createTestMedia, TEST_ENV } from '#lib/server/db/test.js';
import { publishTarget } from '#lib/server/publish.js';
import type { FetchLike } from '#lib/server/providers/types.js';

/**
 * X rotates the refresh token on every use. Two publishes of one account that
 * both find the access token near expiry both refresh; the second presents a
 * token the first just replaced and is refused.
 */
describe('a refresh another publish already did', () => {
	let db: AppDb;
	let close: () => void;
	const store = createTestMedia();
	let userId: string;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'race@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
	});
	afterAll(() => close());

	const baseCreds = { clientId: 'cid', xUserId: '42', xUsername: 'me' };

	async function setup() {
		const now = new Date();
		const connId = newId();
		await db.insert(connections).values({
			id: connId,
			userId,
			platform: 'x',
			handle: '@me',
			credentialsEncrypted: await encryptJson(
				{ ...baseCreds, accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1 },
				TEST_ENV.APP_ENCRYPTION_KEY
			),
			metaJson: JSON.stringify({ xUserId: '42' }),
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
		const draftId = newId();
		await db.insert(drafts).values({
			id: draftId,
			userId,
			baseBody: 'hello X',
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
		const targetId = newId();
		await db.insert(publishTargets).values({
			id: targetId,
			draftId,
			connectionId: connId,
			status: 'pending',
			attemptCount: 0,
			createdAt: now,
			updatedAt: now
		});
		return { connId, targetId };
	}

	function xFetch(onRefresh: () => Promise<Response>, seenTokens: string[]): FetchLike {
		return async (input, init) => {
			const url = typeof input === 'string' ? input : input.toString();
			if (url.endsWith('/2/oauth2/token')) return onRefresh();
			if (url.endsWith('/2/tweets')) {
				seenTokens.push(new Headers(init?.headers).get('authorization') ?? '');
				return Response.json({ data: { id: '777' } });
			}
			return new Response('unmocked', { status: 404 });
		};
	}

	it('publishes with the credentials the other publish stored', async () => {
		const { connId, targetId } = await setup();
		const seen: string[] = [];
		const result = await publishTarget(db, TEST_ENV, store, targetId, {
			fetchImpl: xFetch(async () => {
				// The other publish won: it stored a fresh token first.
				await db
					.update(connections)
					.set({
						credentialsEncrypted: await encryptJson(
							{
								...baseCreds,
								accessToken: 'new-access',
								refreshToken: 'new-refresh',
								expiresAt: Date.now() + 2 * 60 * 60_000
							},
							TEST_ENV.APP_ENCRYPTION_KEY
						)
					})
					.where(eq(connections.id, connId));
				return new Response('{"error":"invalid_request"}', { status: 400 });
			}, seen)
		});
		expect(result.status).toBe('published');
		expect(seen).toEqual(['Bearer new-access']);
		const [conn] = await db.select().from(connections).where(eq(connections.id, connId));
		expect(conn.status).toBe('active');
	});

	it('still marks the account expired when nothing newer was stored', async () => {
		const { connId, targetId } = await setup();
		const seen: string[] = [];
		const result = await publishTarget(db, TEST_ENV, store, targetId, {
			fetchImpl: xFetch(async () => new Response('{}', { status: 400 }), seen)
		});
		expect(result.status).toBe('failed');
		expect(seen).toEqual([]);
		const [conn] = await db.select().from(connections).where(eq(connections.id, connId));
		expect(conn.status).toBe('expired');
	});
});

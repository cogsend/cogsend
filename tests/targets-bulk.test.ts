import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { connections, drafts, publishTargets, users } from '#lib/server/db/schema.js';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { createTestDb } from '#lib/server/db/test.js';
import { POST as bulkPOST } from '../src/routes/api/targets/bulk/+server';

describe('POST /api/targets/bulk', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;
	let otherId: string;
	let draftId: string;
	let connA: string;
	let connB: string;
	let schedA: string;
	let schedB: string;
	let otherTarget: string;

	const localsFor = (id: string) => ({
		db,
		user: { id, email: 'bulk@localhost', timezone: 'UTC', totpEnabled: true, mfaVerified: true }
	});
	const call = (user: string, body: unknown) =>
		bulkPOST({
			request: new Request('http://localhost/api/targets/bulk', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			}),
			locals: localsFor(user)
		} as never) as Promise<Response>;

	beforeAll(async () => {
		const ctx = await createTestDb();
		db = ctx.db;
		close = ctx.close;
		const now = new Date();
		userId = newId();
		otherId = newId();
		for (const [id, email] of [
			[userId, 'bulk@localhost'],
			[otherId, 'bulk-other@localhost']
		]) {
			await db
				.insert(users)
				.values({ id, email, passwordHash: 'x', timezone: 'UTC', createdAt: now, updatedAt: now });
		}
		connA = newId();
		connB = newId();
		for (const [id, platform] of [
			[connA, 'mastodon'],
			[connB, 'bluesky']
		]) {
			await db.insert(connections).values({
				id,
				userId,
				platform,
				credentialsEncrypted: 'enc',
				status: 'active',
				createdAt: now,
				updatedAt: now
			});
		}
		draftId = newId();
		await db.insert(drafts).values({
			id: draftId,
			userId,
			baseBody: 'bulk me',
			status: 'scheduled',
			createdAt: now,
			updatedAt: now
		});
		schedA = newId();
		schedB = newId();
		for (const [id, conn] of [
			[schedA, connA],
			[schedB, connB]
		]) {
			await db.insert(publishTargets).values({
				id,
				draftId,
				connectionId: conn,
				status: 'scheduled',
				scheduledFor: new Date(now.getTime() + 60_000),
				attemptCount: 0,
				createdAt: now,
				updatedAt: now
			});
		}
		// Another user's target: must never be touched or distinguished.
		const otherDraft = newId();
		await db.insert(drafts).values({
			id: otherDraft,
			userId: otherId,
			baseBody: 'not mine',
			status: 'scheduled',
			createdAt: now,
			updatedAt: now
		});
		const otherConn = newId();
		await db.insert(connections).values({
			id: otherConn,
			userId: otherId,
			platform: 'mastodon',
			credentialsEncrypted: 'enc',
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
		otherTarget = newId();
		await db.insert(publishTargets).values({
			id: otherTarget,
			draftId: otherDraft,
			connectionId: otherConn,
			status: 'scheduled',
			scheduledFor: new Date(now.getTime() + 60_000),
			attemptCount: 0,
			createdAt: now,
			updatedAt: now
		});
	});
	afterAll(() => close());

	it('rejects bad op, empty ids, and oversized batches', async () => {
		const badOp = (await (await call(userId, { op: 'nuke', ids: [schedA] })).json()) as {
			error: string;
		};
		expect(badOp.error).toMatch(/op must be/);
		const empty = (await (await call(userId, { op: 'cancel', ids: [] })).json()) as {
			error: string;
		};
		expect(empty.error).toMatch(/ids required/);
		const many = Array.from({ length: 11 }, () => newId());
		const over = await call(userId, { op: 'cancel', ids: many });
		expect(over.status).toBe(400);
	});

	it('reschedule validates runAt bounds', async () => {
		const past = await call(userId, {
			op: 'reschedule',
			ids: [schedA],
			runAt: new Date(Date.now() - 60_000).toISOString()
		});
		expect(past.status).toBe(400);
		const far = await call(userId, {
			op: 'reschedule',
			ids: [schedA],
			runAt: new Date(Date.now() + 400 * 24 * 60 * 60_000).toISOString()
		});
		expect(far.status).toBe(400);
	});

	it('reschedules every id in one request', async () => {
		const runAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
		const res = await call(userId, { op: 'reschedule', ids: [schedA, schedB], runAt });
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			results: { id: string; ok: boolean; status?: string }[];
		};
		expect(body.results).toHaveLength(2);
		expect(body.results.every((r) => r.ok)).toBe(true);
		for (const id of [schedA, schedB]) {
			const rows = await db.select().from(publishTargets).where(eq(publishTargets.id, id));
			expect(rows[0].status).toBe('scheduled');
			expect(rows[0].scheduledFor?.getTime()).toBe(new Date(runAt).getTime());
		}
	});

	it('reports foreign ids as Not found without touching them', async () => {
		const res = await call(userId, { op: 'cancel', ids: [otherTarget, 'does-not-exist'] });
		const body = (await res.json()) as {
			results: { id: string; ok: boolean; error?: string }[];
		};
		expect(body.results).toHaveLength(2);
		expect(body.results.every((r) => !r.ok && r.error === 'Not found')).toBe(true);
		const rows = await db.select().from(publishTargets).where(eq(publishTargets.id, otherTarget));
		expect(rows[0].status).toBe('scheduled');
	});

	it('cancels every id in one request', async () => {
		const res = await call(userId, { op: 'cancel', ids: [schedA, schedB] });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { results: { id: string; ok: boolean }[] };
		expect(body.results.every((r) => r.ok)).toBe(true);
		for (const id of [schedA, schedB]) {
			const rows = await db.select().from(publishTargets).where(eq(publishTargets.id, id));
			expect(rows[0].status).toBe('cancelled');
		}
	});
});

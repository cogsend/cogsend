import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { eq } from 'drizzle-orm';
import * as schema from '#lib/server/db/schema.js';
import {
	connections,
	drafts,
	publishAttempts,
	publishTargets,
	users
} from '#lib/server/db/schema.js';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { DELETE as disconnectDELETE } from '../src/routes/api/connections/[id]/+server';
import { POST as blueskyPOST } from '../src/routes/api/connections/bluesky/+server';
import { GET as connectionsGET } from '../src/routes/api/connections/+server';
import { POST as verifyPOST } from '../src/routes/api/connections/[id]/verify/+server';
import { GET as queueGET } from '../src/routes/api/queue/+server';
import { claimDueTargets, purgeDisconnectedConnections } from '#lib/server/scheduler.js';
import { TEST_ENV, createTestDb } from '#lib/server/db/test.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('DELETE /api/connections/[id] — archive, not destroy', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;
	let otherId: string;
	let count: () => number;
	let reset: () => void;

	async function addConnection(
		owner: string,
		overrides: Partial<typeof connections.$inferInsert> = {}
	) {
		const id = newId();
		const now = new Date();
		await db.insert(connections).values({
			id,
			userId: owner,
			platform: 'mastodon',
			handle: `acct-${id.slice(0, 8)}@example.social`,
			credentialsEncrypted: 'enc',
			status: 'active',
			createdAt: now,
			updatedAt: now,
			...overrides
		});
		return id;
	}

	async function addDraft(owner: string, status = 'scheduled') {
		const id = newId();
		const now = new Date();
		await db.insert(drafts).values({
			id,
			userId: owner,
			baseBody: 'disconnect fixture',
			status,
			createdAt: now,
			updatedAt: now
		});
		return id;
	}

	async function addTarget(
		draftId: string,
		connectionId: string,
		overrides: Partial<typeof publishTargets.$inferInsert> = {}
	) {
		const id = newId();
		const now = new Date();
		await db.insert(publishTargets).values({
			id,
			draftId,
			connectionId,
			status: 'scheduled',
			scheduledFor: new Date(now.getTime() + 60_000),
			attemptCount: 0,
			createdAt: now,
			updatedAt: now,
			...overrides
		});
		return id;
	}

	const sessionUser = (id: string) => ({
		db,
		user: {
			id,
			email: 'disconnect@localhost',
			timezone: 'UTC',
			totpEnabled: true,
			mfaVerified: true
		},
		authMethod: 'session' as const
	});
	const disconnect = (id: string) =>
		disconnectDELETE({ params: { id }, locals: sessionUser(userId) } as never);

	beforeAll(async () => {
		const ctx = await createTestDb();
		db = ctx.db;
		close = ctx.close;
		count = ctx.count;
		reset = ctx.reset;
		userId = newId();
		otherId = newId();
		const now = new Date();
		for (const [id, email] of [
			[userId, 'disconnect@localhost'],
			[otherId, 'disconnect-other@localhost']
		]) {
			await db
				.insert(users)
				.values({ id, email, passwordHash: 'x', timezone: 'UTC', createdAt: now, updatedAt: now });
		}
	});
	afterAll(() => {
		vi.unstubAllGlobals();
		close();
	});

	it('archives published targets, removes scheduled ones, and tombstones the account', async () => {
		const conn = await addConnection(userId);
		const pubDraft = await addDraft(userId, 'published');
		const pubTarget = await addTarget(pubDraft, conn, {
			status: 'published',
			remotePostId: 'remote-1',
			remoteUrl: 'https://example.social/@me/1'
		});
		const schedDraft = await addDraft(userId, 'scheduled');
		const schedTarget = await addTarget(schedDraft, conn);
		const pubDraftBefore = (await db.select().from(drafts).where(eq(drafts.id, pubDraft)))[0];

		const res = await disconnect(conn);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, removed: 1, archived: 1 });

		const [row] = await db.select().from(connections).where(eq(connections.id, conn));
		expect(row.status).toBe('disconnected');
		expect(row.credentialsEncrypted).toBe('');
		expect(row.handle).toBeTruthy();

		expect(
			await db.select().from(publishTargets).where(eq(publishTargets.id, pubTarget))
		).toHaveLength(1);
		expect(
			await db.select().from(publishTargets).where(eq(publishTargets.id, schedTarget))
		).toHaveLength(0);

		const [schedDraftAfter] = await db.select().from(drafts).where(eq(drafts.id, schedDraft));
		expect(schedDraftAfter.status).toBe('draft');
		// Published-only drafts keep their timestamp: no pointless "Edited"
		// bump from a disconnect that removed nothing of theirs.
		const [pubDraftAfter] = await db.select().from(drafts).where(eq(drafts.id, pubDraft));
		expect(pubDraftAfter.updatedAt.getTime()).toBe(pubDraftBefore.updatedAt.getTime());

		// The archive stays visible in the queue behind the tombstone.
		const queue = (await queueGET({
			locals: { db, user: sessionUser(userId).user }
		} as never)) as Response;
		const body = (await queue.json()) as {
			targets: Array<{
				id: string;
				remoteUrl: string | null;
				connection: { id: string; status: string };
			}>;
		};
		expect(body.targets).toHaveLength(1);
		expect(body.targets[0].id).toBe(pubTarget);
		expect(body.targets[0].connection.status).toBe('disconnected');
		expect(body.targets[0].remoteUrl).toBe('https://example.social/@me/1');

		// Retried disconnect is a no-op, not a 404 or a second sweep.
		const again = await disconnect(conn);
		expect(again.status).toBe(200);
		expect(await again.json()).toEqual({ ok: true, removed: 0, archived: 0 });
	});

	it('drops the connection row when nothing is archived', async () => {
		const conn = await addConnection(userId);
		const draft = await addDraft(userId);
		const target = await addTarget(draft, conn);

		const res = await disconnect(conn);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, removed: 1, archived: 0 });

		expect(await db.select().from(connections).where(eq(connections.id, conn))).toHaveLength(0);
		expect(
			await db.select().from(publishTargets).where(eq(publishTargets.id, target))
		).toHaveLength(0);
		const [d] = await db.select().from(drafts).where(eq(drafts.id, draft));
		expect(d.status).toBe('draft');
	});

	it('recomputes a mixed draft without touching sibling accounts', async () => {
		const connA = await addConnection(userId);
		const connB = await addConnection(userId, { platform: 'bluesky' });
		const draft = await addDraft(userId, 'partial');
		const pubOnA = await addTarget(draft, connA, {
			status: 'published',
			remotePostId: 'remote-2',
			remoteUrl: 'https://example.social/@me/2'
		});
		const schedOnB = await addTarget(draft, connB);

		const res = await disconnect(connB);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, removed: 1, archived: 0 });

		const [a] = await db.select().from(connections).where(eq(connections.id, connA));
		expect(a.status).toBe('active');
		expect(
			await db.select().from(publishTargets).where(eq(publishTargets.id, pubOnA))
		).toHaveLength(1);
		expect(
			await db.select().from(publishTargets).where(eq(publishTargets.id, schedOnB))
		).toHaveLength(0);
		// The scheduled sibling is gone, the published one remains: the draft
		// must flip from partial back to published, not stay stuck.
		const [d] = await db.select().from(drafts).where(eq(drafts.id, draft));
		expect(d.status).toBe('published');
	});

	it('refuses to disconnect while a publish is in flight', async () => {
		const now = new Date();
		const fresh = await addConnection(userId);
		const freshDraft = await addDraft(userId);
		const freshTarget = await addTarget(freshDraft, fresh, {
			status: 'publishing',
			scheduledFor: null,
			updatedAt: now
		});
		// A live claim has an attempt row whose checkpoint (segmentIds) is what
		// a partial-thread resume reads; the 409 must change nothing at all.
		await db.insert(publishAttempts).values({
			id: newId(),
			publishTargetId: freshTarget,
			startedAt: now,
			success: false,
			responseSummary: JSON.stringify({ segmentIds: ['seg-1'], checkpoint: true })
		});
		const freshRes = await disconnect(fresh);
		expect(freshRes.status).toBe(409);
		// The refused disconnect deleted the live claim's attempt checkpoint:
		// a resumed thread would then restart from segment 0 and post twice.
		expect(
			await db
				.select()
				.from(publishAttempts)
				.where(eq(publishAttempts.publishTargetId, freshTarget))
		).toHaveLength(1);
		expect((await db.select().from(connections).where(eq(connections.id, fresh)))[0].status).toBe(
			'active'
		);
		expect(
			await db.select().from(publishTargets).where(eq(publishTargets.id, freshTarget))
		).toHaveLength(1);

		const queued = await addConnection(userId);
		const queuedDraft = await addDraft(userId);
		const queuedTarget = await addTarget(queuedDraft, queued, { jobId: 'job-1' });
		const queuedRes = await disconnect(queued);
		expect(queuedRes.status).toBe(409);
		expect((await db.select().from(connections).where(eq(connections.id, queued)))[0].status).toBe(
			'active'
		);
		expect(
			await db.select().from(publishTargets).where(eq(publishTargets.id, queuedTarget))
		).toHaveLength(1);
	});

	it('404s another user’s connection and leaves it untouched', async () => {
		const otherConn = await addConnection(otherId);
		const res = await disconnect(otherConn);
		expect(res.status).toBe(404);
		const [row] = await db.select().from(connections).where(eq(connections.id, otherConn));
		expect(row.status).toBe('active');
	});

	it('refuses verify on a disconnected tombstone', async () => {
		const conn = await addConnection(userId, { status: 'disconnected', credentialsEncrypted: '' });
		const res = (await verifyPOST({
			params: { id: conn },
			// Verify is session-only now (it writes credentials), so the locals
			// have to say the request came from a session.
			locals: { ...sessionUser(userId), db, user: sessionUser(userId).user }
		} as never)) as Response;
		expect(res.status).toBe(409);
	});

	it('hides tombstones from the connectable account list', async () => {
		const tombstone = await addConnection(userId, {
			status: 'disconnected',
			credentialsEncrypted: ''
		});
		const live = await addConnection(userId);
		const res = (await connectionsGET({
			locals: { db, user: sessionUser(userId).user, env: TEST_ENV }
		} as never)) as Response;
		expect(res.status).toBe(200);
		const body = (await res.json()) as { connections: Array<{ id: string }> };
		const ids = body.connections.map((c) => c.id);
		expect(ids).not.toContain(tombstone);
		expect(ids).toContain(live);
	});

	it('reconnects into the same tombstone row so the archive stays attached', async () => {
		const handle = 'archive-test.bsky.social';
		const conn = await addConnection(userId, {
			platform: 'bluesky',
			handle,
			status: 'disconnected',
			credentialsEncrypted: ''
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: unknown) => {
				const url = String(input);
				if (url.includes('com.atproto.server.createSession')) {
					return Response.json({
						accessJwt: 'a',
						refreshJwt: 'r',
						did: 'did:plc:archive',
						handle
					});
				}
				if (url.includes('app.bsky.actor.getProfile')) {
					return Response.json({ handle, displayName: 'Archive Test' });
				}
				return new Response('unmocked', { status: 404 });
			})
		);
		const res = (await blueskyPOST({
			request: new Request('http://localhost/api/connections/bluesky', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ handle, appPassword: 'xxxx-xxxx-xxxx-xxxx' })
			}),
			locals: {
				db,
				user: sessionUser(userId).user,
				authMethod: 'session',
				env: TEST_ENV
			}
		} as never)) as Response;
		expect(res.status).toBe(200);
		const body = (await res.json()) as { connection: { id: string; status: string } };
		expect(body.connection.id).toBe(conn);

		const [row] = await db.select().from(connections).where(eq(connections.id, conn));
		expect(row.status).toBe('active');
		expect(row.credentialsEncrypted).not.toBe('');
		vi.unstubAllGlobals();
	});

	it('purges tombstones without targets and keeps archived ones', async () => {
		const empty = await addConnection(userId, { status: 'disconnected', credentialsEncrypted: '' });
		const archived = await addConnection(userId, {
			status: 'disconnected',
			credentialsEncrypted: ''
		});
		const draft = await addDraft(userId, 'published');
		await addTarget(draft, archived, { status: 'published', remotePostId: 'remote-3' });

		await purgeDisconnectedConnections(db);

		expect(await db.select().from(connections).where(eq(connections.id, empty))).toHaveLength(0);
		expect(await db.select().from(connections).where(eq(connections.id, archived))).toHaveLength(1);
	});

	it('never claims targets on disconnected connections', async () => {
		const now = new Date();
		const dead = await addConnection(userId, { status: 'disconnected', credentialsEncrypted: '' });
		const deadDraft = await addDraft(userId);
		const deadTarget = await addTarget(deadDraft, dead, {
			scheduledFor: new Date(now.getTime() - 60_000)
		});

		const live = await addConnection(userId);
		const liveDraft = await addDraft(userId);
		const liveTarget = await addTarget(liveDraft, live, {
			scheduledFor: new Date(now.getTime() - 60_000)
		});

		const due = await claimDueTargets(db, now);
		const ids = due.map((t) => t.id);
		expect(ids).toContain(liveTarget);
		expect(ids).not.toContain(deadTarget);

		// The queue hides the same orphaned row instead of rendering a card
		// whose actions can only fail against the dead account.
		const queue = (await queueGET({
			locals: { db, user: sessionUser(userId).user }
		} as never)) as Response;
		const body = (await queue.json()) as { targets: Array<{ id: string }> };
		const queuedIds = body.targets.map((t) => t.id);
		expect(queuedIds).toContain(liveTarget);
		expect(queuedIds).not.toContain(deadTarget);
	});

	it('does not delete a claim checkpoint that raced in after the snapshot', async () => {
		const conn = await addConnection(userId);
		const draft = await addDraft(userId, 'scheduled');
		const target = await addTarget(draft, conn);
		// Interleaving: the route snapshots the targets (not in flight), then a
		// claim lands — publishing + its attempt row with a resume checkpoint —
		// before the route's first delete of any kind.
		let landed = false;
		const claimLands = async () => {
			if (landed) return;
			landed = true;
			await db
				.update(publishTargets)
				.set({ status: 'publishing', attemptCount: 1, updatedAt: new Date() })
				.where(eq(publishTargets.id, target));
			await db.insert(publishAttempts).values({
				id: newId(),
				publishTargetId: target,
				startedAt: new Date(),
				success: false,
				responseSummary: JSON.stringify({ segmentIds: ['seg-1'], checkpoint: true })
			});
		};
		const realDelete = db.delete.bind(db);
		(db as { delete: unknown }).delete = (table: unknown) => {
			const builder = (realDelete as (t: unknown) => { where: (c: never) => Promise<unknown> })(
				table
			);
			return { where: (cond: never) => claimLands().then(() => builder.where(cond)) };
		};
		try {
			const res = await disconnect(conn);
			// The claim owns the row: the disconnect must refuse and leave the
			// live claim's attempt checkpoint in place for the resume.
			expect(res.status).toBe(409);
			expect(
				await db.select().from(publishAttempts).where(eq(publishAttempts.publishTargetId, target))
			).toHaveLength(1);
		} finally {
			(db as { delete: unknown }).delete = realDelete;
		}
	});

	it('clears stale publishing rows instead of blocking', async () => {
		const conn = await addConnection(userId);
		const draft = await addDraft(userId);
		await addTarget(draft, conn, {
			status: 'publishing',
			scheduledFor: null,
			updatedAt: new Date(Date.now() - 16 * 60_000)
		});

		const res = await disconnect(conn);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, removed: 1, archived: 0 });
		const [d] = await db.select().from(drafts).where(eq(drafts.id, draft));
		expect(d.status).toBe('draft');
	});

	it('refreshes many stranded drafts within the D1 statement budget', async () => {
		const conn = await addConnection(userId);
		const otherConn = await addConnection(userId, { platform: 'bluesky' });
		const stranded: string[] = [];
		// 95 drafts crosses the 90-id chunk boundary, proving the sweep
		// chunks without one query per draft.
		for (let i = 0; i < 95; i++) {
			const d = await addDraft(userId);
			await addTarget(d, conn);
			stranded.push(d);
		}
		// Mixed outcomes in the same sweep: published sibling, scheduled sibling.
		const keptDraft = await addDraft(userId, 'partial');
		await addTarget(keptDraft, conn);
		await addTarget(keptDraft, otherConn, { status: 'published', remotePostId: 'remote-keep' });
		const schedDraft = await addDraft(userId, 'scheduled');
		await addTarget(schedDraft, conn);
		await addTarget(schedDraft, otherConn, { status: 'scheduled' });

		reset();
		const res = await disconnect(conn);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, removed: 97, archived: 0 });
		// 1 connection read, 1 target read, 2 attempt-delete chunks, 1 target
		// delete, 2 bulk status updates, 1 survivor check, 1 row delete — not
		// one refresh query per stranded draft.
		expect(count()).toBeLessThanOrEqual(12);

		for (const id of stranded) {
			const [d] = await db.select().from(drafts).where(eq(drafts.id, id));
			expect(d.status).toBe('draft');
		}
		const [kept] = await db.select().from(drafts).where(eq(drafts.id, keptDraft));
		expect(kept.status).toBe('published');
		const [sched] = await db.select().from(drafts).where(eq(drafts.id, schedDraft));
		expect(sched.status).toBe('scheduled');
	});

	it('does not depend on foreign_keys enforcement', async () => {
		const client = createClient({ url: ':memory:' });
		const dir = join(here, '../drizzle');
		for (const name of readdirSync(dir)
			.filter((n) => n.endsWith('.sql'))
			.sort()) {
			await client.executeMultiple(readFileSync(join(dir, name), 'utf8'));
		}
		await client.execute('PRAGMA foreign_keys = OFF');
		const offDb = drizzle(client, { schema }) as unknown as AppDb;
		const pragma = await client.execute('PRAGMA foreign_keys');
		expect((pragma.rows[0] as unknown as { foreign_keys: number }).foreign_keys).toBe(0);

		const now = new Date();
		const owner = newId();
		await offDb.insert(users).values({
			id: owner,
			email: `fk-off-${owner}@localhost`,
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
		const conn = newId();
		await offDb.insert(connections).values({
			id: conn,
			userId: owner,
			platform: 'mastodon',
			handle: 'fk-off@example.social',
			credentialsEncrypted: 'enc',
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
		const pubDraft = newId();
		const schedDraft = newId();
		for (const id of [pubDraft, schedDraft]) {
			await offDb.insert(drafts).values({
				id,
				userId: owner,
				baseBody: 'fk off fixture',
				status: 'draft',
				createdAt: now,
				updatedAt: now
			});
		}
		const pubTarget = newId();
		const schedTarget = newId();
		const attemptId = newId();
		await offDb.insert(publishTargets).values([
			{
				id: pubTarget,
				draftId: pubDraft,
				connectionId: conn,
				status: 'published',
				remotePostId: 'remote-fk-off',
				attemptCount: 1,
				createdAt: now,
				updatedAt: now
			},
			{
				id: schedTarget,
				draftId: schedDraft,
				connectionId: conn,
				status: 'scheduled',
				scheduledFor: new Date(now.getTime() + 60_000),
				attemptCount: 0,
				createdAt: now,
				updatedAt: now
			}
		]);
		await offDb.insert(publishAttempts).values({
			id: attemptId,
			publishTargetId: schedTarget,
			startedAt: now,
			success: false
		});

		const res = (await disconnectDELETE({
			params: { id: conn },
			locals: {
				db: offDb,
				user: {
					id: owner,
					email: `fk-off-${owner}@localhost`,
					timezone: 'UTC',
					totpEnabled: true,
					mfaVerified: true
				},
				authMethod: 'session'
			}
		} as never)) as Response;
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, removed: 1, archived: 1 });

		const [row] = await offDb.select().from(connections).where(eq(connections.id, conn));
		expect(row.status).toBe('disconnected');
		expect(
			await offDb.select().from(publishTargets).where(eq(publishTargets.id, pubTarget))
		).toHaveLength(1);
		expect(
			await offDb.select().from(publishTargets).where(eq(publishTargets.id, schedTarget))
		).toHaveLength(0);
		expect(
			await offDb.select().from(publishAttempts).where(eq(publishAttempts.id, attemptId))
		).toHaveLength(0);
		const [d] = await offDb.select().from(drafts).where(eq(drafts.id, schedDraft));
		expect(d.status).toBe('draft');
		client.close();
	});
});

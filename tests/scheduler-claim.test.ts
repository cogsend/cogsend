import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '$lib/server/db/schema';
import { encryptJson } from '$lib/server/crypto';
import { newId, type AppDb } from '$lib/server/db/client';
import { connections, drafts, publishTargets, sessions, users } from '$lib/server/db/schema';
import { createTestDb, createTestMedia, TEST_ENV } from '$lib/server/db/test';
import { captureConsole, loggedLines } from './console-spy';
import { writeAppSetting } from '$lib/server/app-settings';
import { draftHasInFlightPublish } from '$lib/server/publish-plan';
import {
	claimDueTargets,
	consumePublishJob,
	JANITOR_INTERVAL_MS,
	JANITOR_SETTING,
	runJanitorsIfDue,
	runSchedulerTick,
	schedulerHealth,
	writeHeartbeat
} from '$lib/server/scheduler';

const here = dirname(fileURLToPath(import.meta.url));

describe('claimDueTargets stale publishing', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;
	let draftId: string;
	let connId: string;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'sched@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
		draftId = newId();
		await db.insert(drafts).values({
			id: draftId,
			userId,
			baseBody: 'tick',
			status: 'scheduled',
			createdAt: now,
			updatedAt: now
		});
		connId = newId();
		await db.insert(connections).values({
			id: connId,
			userId,
			platform: 'bluesky',
			handle: 'test.bsky.social',
			credentialsEncrypted: await encryptJson(
				{
					handle: 'test.bsky.social',
					appPassword: 'xxxx',
					did: 'did:plc:test',
					pdsHost: 'https://bsky.social'
				},
				TEST_ENV.APP_ENCRYPTION_KEY
			),
			metaJson: JSON.stringify({ did: 'did:plc:test' }),
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
	});

	afterAll(() => close());

	it('selects a due stale publishing row and tick publishes it once', async () => {
		const now = new Date();
		const targetId = newId();
		await db.insert(publishTargets).values({
			id: targetId,
			draftId,
			connectionId: connId,
			status: 'publishing',
			scheduledFor: new Date(now.getTime() - 60_000),
			attemptCount: 1,
			createdAt: now,
			updatedAt: new Date(now.getTime() - 16 * 60_000)
		});
		const due = await claimDueTargets(db, now);
		expect(due.map((t) => t.id)).toContain(targetId);

		const store = createTestMedia();
		const result = await runSchedulerTick(db, TEST_ENV, {
			store,
			fetchImpl: async (input) => {
				const url =
					typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
				if (url.includes('createSession')) {
					return Response.json({
						accessJwt: 'a',
						refreshJwt: 'r',
						did: 'did:plc:test',
						handle: 'test.bsky.social'
					});
				}
				if (url.includes('createRecord')) {
					return Response.json({ uri: 'at://did:plc:test/app.bsky.feed.post/tick', cid: 'cid' });
				}
				return new Response(`unmocked ${url}`, { status: 404 });
			}
		});
		expect(result.results.some((r) => r.id === targetId && r.status === 'published')).toBe(true);
	});

	it('bounds the batch oldest-due-first', async () => {
		const now = new Date();
		const ids: string[] = [];
		for (let i = 0; i < 60; i++) {
			// Unique (draft, connection) pairs: reuse one draft per target is
			// blocked by the unique index, so mint a draft each.
			const d = newId();
			await db.insert(drafts).values({
				id: d,
				userId,
				baseBody: `batch ${i}`,
				status: 'scheduled',
				createdAt: now,
				updatedAt: now
			});
			const id = newId();
			ids.push(id);
			await db.insert(publishTargets).values({
				id,
				draftId: d,
				connectionId: connId,
				status: 'scheduled',
				scheduledFor: new Date(now.getTime() - (60 - i) * 60_000),
				attemptCount: 0,
				createdAt: now,
				updatedAt: now
			});
		}
		const due = await claimDueTargets(db, now);
		expect(due.length).toBeLessThanOrEqual(50);
		// Oldest-due first: the earliest scheduledFor in the batch leads.
		const times = due.map((t) => new Date(t.scheduledFor as Date).getTime());
		expect(times).toEqual([...times].sort((a, b) => a - b));
		// Cleanup so later tests see a quiet queue.
		await db.delete(publishTargets).where(inArray(publishTargets.id, ids.slice(0, 100)));
	});

	it('keeps a publish-now row reachable when its inline attempt never ran', async () => {
		const now = new Date();
		const d = newId();
		await db.insert(drafts).values({
			id: d,
			userId,
			baseBody: 'publish now',
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
		const targetId = newId();
		await db.insert(publishTargets).values({
			id: targetId,
			draftId: d,
			connectionId: connId,
			status: 'pending',
			scheduledFor: null,
			attemptCount: 0,
			createdAt: now,
			updatedAt: now
		});

		const due = await claimDueTargets(db, now);
		expect(due.map((t) => t.id)).toContain(targetId);
		await db.delete(publishTargets).where(eq(publishTargets.id, targetId));
	});

	it('hands a stale publishing row to the queue instead of stranding it', async () => {
		const now = new Date();
		const d = newId();
		await db.insert(drafts).values({
			id: d,
			userId,
			baseBody: 'wedged publish',
			status: 'scheduled',
			createdAt: now,
			updatedAt: now
		});
		const targetId = newId();
		await db.insert(publishTargets).values({
			id: targetId,
			draftId: d,
			connectionId: connId,
			status: 'publishing',
			scheduledFor: null,
			attemptCount: 1,
			createdAt: now,
			// Past the stale window: the consumer that claimed it is gone.
			updatedAt: new Date(now.getTime() - 16 * 60_000)
		});
		const sent: Array<{ targetId: string }> = [];
		const tick = await runSchedulerTick(db, TEST_ENV, {
			store: createTestMedia(),
			queue: {
				send: async (body) => {
					sent.push(body);
				}
			}
		});
		expect(sent.some((s) => s.targetId === targetId)).toBe(true);
		expect(tick.results.some((r) => r.id === targetId && r.status === 'queued')).toBe(true);
		const [row] = await db.select().from(publishTargets).where(eq(publishTargets.id, targetId));
		expect(row.jobId).toBeTruthy();
		// Handing it over has to leave it claimable: the consumer's own claim
		// only matches a row that still looks stale, so tagging it in place
		// (which refreshes updatedAt) queued it forever and kept the draft
		// locked as "publishing in progress".
		expect(row.status).not.toBe('publishing');
		const consumed = await consumePublishJob(
			db,
			TEST_ENV,
			createTestMedia(),
			targetId,
			async (input) => {
				const url =
					typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
				if (url.includes('createSession')) {
					return Response.json({
						accessJwt: 'a',
						refreshJwt: 'r',
						did: 'did:plc:test',
						handle: 'test.bsky.social'
					});
				}
				if (url.includes('createRecord')) {
					return Response.json({
						uri: 'at://did:plc:test/app.bsky.feed.post/recovered',
						cid: 'cid'
					});
				}
				return new Response(`unmocked ${url}`, { status: 404 });
			}
		);
		expect(consumed.status).toBe('published');
		// The row is done, so nothing reports the draft as being published: the
		// old tag-in-place behaviour left `publishing` + `jobId` behind forever,
		// which locked the draft, its media, disconnect and retry behind a 409.
		const after = await db.select().from(publishTargets).where(eq(publishTargets.draftId, d));
		expect(draftHasInFlightPublish(after)).toBe(false);
		await db.delete(publishTargets).where(eq(publishTargets.id, targetId));
	});

	it('queue handoff does not trap the consumer claim', async () => {
		const now = new Date();
		const qDraft = newId();
		await db.insert(drafts).values({
			id: qDraft,
			userId,
			baseBody: 'queued tick',
			status: 'scheduled',
			createdAt: now,
			updatedAt: now
		});
		const targetId = newId();
		await db.insert(publishTargets).values({
			id: targetId,
			draftId: qDraft,
			connectionId: connId,
			status: 'scheduled',
			scheduledFor: new Date(now.getTime() - 60_000),
			attemptCount: 0,
			createdAt: now,
			updatedAt: now
		});
		const sent: Array<{ targetId: string }> = [];
		const store = createTestMedia();
		const tick = await runSchedulerTick(db, TEST_ENV, {
			store,
			queue: {
				send: async (body) => {
					sent.push(body);
				}
			}
		});
		expect(tick.results.some((r) => r.id === targetId && r.status === 'queued')).toBe(true);
		expect(sent).toEqual([{ targetId }]);
		const consumed = await consumePublishJob(db, TEST_ENV, store, targetId, async (input) => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			if (url.includes('createSession')) {
				return Response.json({
					accessJwt: 'a',
					refreshJwt: 'r',
					did: 'did:plc:test',
					handle: 'test.bsky.social'
				});
			}
			if (url.includes('createRecord')) {
				return Response.json({ uri: 'at://did:plc:test/app.bsky.feed.post/queued', cid: 'cid' });
			}
			return new Response(`unmocked ${url}`, { status: 404 });
		});
		expect(consumed.status).toBe('published');
	});

	it('a failed queue send releases the tag and propagates', async () => {
		const now = new Date();
		const qDraft = newId();
		await db.insert(drafts).values({
			id: qDraft,
			userId,
			baseBody: 'wedged tick',
			status: 'scheduled',
			createdAt: now,
			updatedAt: now
		});
		const targetId = newId();
		await db.insert(publishTargets).values({
			id: targetId,
			draftId: qDraft,
			connectionId: connId,
			status: 'scheduled',
			scheduledFor: new Date(now.getTime() - 60_000),
			attemptCount: 0,
			createdAt: now,
			updatedAt: now
		});
		const store = createTestMedia();
		await expect(
			runSchedulerTick(db, TEST_ENV, {
				store,
				queue: {
					send: async () => {
						throw new Error('queue down');
					}
				}
			})
		).rejects.toThrow('queue down');
		const [row] = await db.select().from(publishTargets).where(eq(publishTargets.id, targetId));
		expect(row?.jobId).toBeNull();
		expect(row?.status).toBe('scheduled');
		// The next tick can reclaim it immediately (no 15m wedge).
		expect(await claimDueTargets(db, new Date())).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: targetId })])
		);
		await db.delete(publishTargets).where(eq(publishTargets.id, targetId));
	});

	it('health reports stuck publishing and overdue targets', async () => {
		const now = new Date();
		const hDraft = newId();
		await db.insert(drafts).values({
			id: hDraft,
			userId,
			baseBody: 'health probe',
			status: 'scheduled',
			createdAt: now,
			updatedAt: now
		});
		await db.insert(publishTargets).values({
			id: newId(),
			draftId: hDraft,
			connectionId: connId,
			status: 'publishing',
			scheduledFor: new Date(now.getTime() - 60_000),
			attemptCount: 1,
			createdAt: now,
			updatedAt: new Date(now.getTime() - 31 * 60_000)
		});
		const oDraft = newId();
		await db.insert(drafts).values({
			id: oDraft,
			userId,
			baseBody: 'overdue probe',
			status: 'scheduled',
			createdAt: now,
			updatedAt: now
		});
		const otherConn = newId();
		await db.insert(connections).values({
			id: otherConn,
			userId,
			platform: 'mastodon',
			handle: 'health@example.social',
			credentialsEncrypted: 'enc',
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
		await db.insert(publishTargets).values({
			id: newId(),
			draftId: oDraft,
			connectionId: otherConn,
			status: 'scheduled',
			scheduledFor: new Date(now.getTime() - 60_000),
			attemptCount: 0,
			createdAt: now,
			updatedAt: now
		});
		await writeHeartbeat(db, now);
		const health = await schedulerHealth(db, now);
		expect(health.ok).toBe(true);
		expect(health.stuckPublishing).toBe(1);
		expect(health.overdue).toBeGreaterThanOrEqual(1);
	});
});

describe('queue single-flight', () => {
	let db: AppDb;
	let close: () => void;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		const userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'singleflight@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
		const draftId = newId();
		await db.insert(drafts).values({
			id: draftId,
			userId,
			baseBody: 'single flight',
			status: 'scheduled',
			createdAt: now,
			updatedAt: now
		});
		const connId = newId();
		await db.insert(connections).values({
			id: connId,
			userId,
			platform: 'bluesky',
			handle: 'test.bsky.social',
			credentialsEncrypted: 'enc',
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
		await db.insert(publishTargets).values({
			id: 'singleflight-target',
			draftId,
			connectionId: connId,
			status: 'scheduled',
			scheduledFor: new Date(now.getTime() - 60_000),
			attemptCount: 0,
			createdAt: now,
			updatedAt: now
		});
	});
	afterAll(() => close());

	it('two overlapping ticks enqueue a target only once', async () => {
		const sent: Array<{ targetId: string }> = [];
		const queue = {
			send: async (body: { targetId: string }) => {
				sent.push(body);
			}
		};
		const store = createTestMedia();
		// Actually overlapping, as the name says: the guarded code relies on a
		// conditional UPDATE, and two sequential calls would pass even if that
		// compare-and-set did nothing. Both ticks read the row before either
		// writes.
		await Promise.all([
			runSchedulerTick(db, TEST_ENV, { store, queue }),
			runSchedulerTick(db, TEST_ENV, { store, queue })
		]);
		expect(sent.filter((s) => s.targetId === 'singleflight-target')).toHaveLength(1);
	});
});

/**
 * D1's free plan allows 50 statements per invocation, and the tick spends
 * roughly a dozen per target on top of its janitor pass. The batch used to
 * throw out of the handler when it ran out, which also skipped the failure
 * digest. It now stops cleanly and leaves the rest due for the next tick.
 */
describe('scheduler statement budget', () => {
	let db: AppDb;
	let close: () => void;
	/** A real D1-shaped database that fails like an exhausted plan would. */
	async function budgetDb(failOn: RegExp) {
		const client = createClient({ url: ':memory:' });
		const dir = join(here, '../drizzle');
		for (const name of readdirSync(dir)
			.filter((n) => n.endsWith('.sql'))
			.sort()) {
			await client.executeMultiple(readFileSync(join(dir, name), 'utf8'));
		}
		const orig = client.execute.bind(client);
		client.execute = (async (...args: Parameters<typeof orig>) => {
			const first = args[0] as unknown;
			const text =
				typeof first === 'string'
					? first
					: first && typeof first === 'object' && 'sql' in first
						? String((first as { sql: unknown }).sql)
						: '';
			if (failOn.test(text)) throw new Error('D1_ERROR: too many queries per invocation');
			return orig(...args);
		}) as typeof orig;
		return { db: drizzle(client, { schema }) as unknown as AppDb, close: () => client.close() };
	}
	beforeAll(async () => {
		({ db, close } = await budgetDb(/publish_attempts/i));
		const now = new Date();
		const userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'budget@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
		const connId = newId();
		await db.insert(connections).values({
			id: connId,
			userId,
			platform: 'bluesky',
			handle: 'budget.bsky.social',
			credentialsEncrypted: 'enc',
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
		for (let i = 0; i < 3; i++) {
			const draftId = newId();
			await db.insert(drafts).values({
				id: draftId,
				userId,
				baseBody: `budget ${i}`,
				status: 'scheduled',
				createdAt: now,
				updatedAt: now
			});
			await db.insert(publishTargets).values({
				id: newId(),
				draftId,
				connectionId: connId,
				status: 'scheduled',
				scheduledFor: new Date(now.getTime() - 60_000),
				attemptCount: 0,
				createdAt: now,
				updatedAt: now
			});
		}
	});
	afterAll(() => close());
	it('reports the failure and leaves the rest of the batch due', async () => {
		const store = createTestMedia();
		const logged = captureConsole();
		// Must resolve rather than reject, and still run the digest pass.
		const tick = await runSchedulerTick(db, TEST_ENV, {
			store,
			fetchImpl: async () => new Response('unmocked', { status: 404 })
		});
		expect(tick.results.some((r) => r.status === 'error')).toBe(true);
		// The abort is logged, once, with the target that hit the budget.
		expect(
			loggedLines(logged).filter((line) => line.includes('[scheduler] publish aborted'))
		).toHaveLength(1);
		expect(tick.digest).toBeTruthy();
		// The rows the batch never reached stay claimable on the next tick.
		const due = await claimDueTargets(db, new Date());
		expect(due.length).toBeGreaterThanOrEqual(1);
	});
});

/**
 * The janitors are not urgent, and every statement a tick runs on the Workers
 * Free plan comes out of the 50 calls it publishes with, so they run hourly.
 */
describe('hourly janitors', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'janitor@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
	});
	afterAll(() => close());

	async function expiredSession() {
		const id = newId();
		const long = new Date(Date.now() - 60 * 24 * 60 * 60_000);
		await db.insert(sessions).values({
			id,
			token: newId(),
			userId,
			expiresAt: long,
			remember: true,
			mfaVerified: true,
			createdAt: long,
			lastSeenAt: long
		});
		return id;
	}
	const exists = async (id: string) =>
		(await db.select().from(sessions).where(eq(sessions.id, id))).length === 1;

	it('the tick clears expired rows, then leaves the tables alone for an hour', async () => {
		const first = await expiredSession();
		await runSchedulerTick(db, TEST_ENV, { store: createTestMedia() });
		expect(await exists(first)).toBe(false);

		const second = await expiredSession();
		await runSchedulerTick(db, TEST_ENV, { store: createTestMedia() });
		expect(await exists(second)).toBe(true);

		const later = new Date(Date.now() + JANITOR_INTERVAL_MS + 60_000);
		expect(await runJanitorsIfDue(db, later)).toBe(true);
		expect(await exists(second)).toBe(false);
		expect(await runJanitorsIfDue(db, new Date(later.getTime() + 60_000))).toBe(false);
	});

	it('does not let a marker from the future hold the janitors off', async () => {
		await writeAppSetting(db, JANITOR_SETTING, String(Date.now() + 24 * 60 * 60_000));
		const stale = await expiredSession();
		expect(await runJanitorsIfDue(db)).toBe(true);
		expect(await exists(stale)).toBe(false);
	});
});

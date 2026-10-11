import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { STALE_CLAIM_MS } from '#lib/domain/due-jobs.js';
import { encryptJson } from '#lib/server/crypto.js';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { connections, drafts, publishTargets, users } from '#lib/server/db/schema.js';
import { createTestDb, TEST_ENV } from '#lib/server/db/test.js';
import {
	classifyWinner,
	refuseInFlightOrPublished,
	ensureTargets,
	isUniqueConstraintError,
	pickTargetWinner
} from '#lib/server/publish-plan.js';
import { selectDueScheduledTargets } from '#lib/domain/due-jobs.js';

describe('pickTargetWinner', () => {
	it('prefers a remotePostId row over a newer scheduled sibling', () => {
		const now = new Date('2026-08-17T12:00:00Z');
		const published = {
			id: 'pub',
			draftId: 'd',
			connectionId: 'c',
			variantId: null,
			status: 'published',
			scheduledFor: null,
			remotePostId: 'remote-1',
			remoteUrl: 'https://example.com/1',
			errorMessage: null,
			attemptCount: 1,
			jobId: null,
			createdAt: now,
			updatedAt: new Date('2026-08-17T11:00:00Z')
		};
		const scheduled = {
			...published,
			id: 'sched',
			status: 'scheduled',
			remotePostId: null,
			remoteUrl: null,
			scheduledFor: now,
			updatedAt: new Date('2026-08-17T12:00:00Z')
		};
		expect(pickTargetWinner([scheduled, published])?.id).toBe('pub');
	});
});

describe('ensureTargets', () => {
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
			email: 'plan@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
		draftId = newId();
		await db.insert(drafts).values({
			id: draftId,
			userId,
			baseBody: 'hello',
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
		connId = newId();
		await db.insert(connections).values({
			id: connId,
			userId,
			platform: 'mastodon',
			handle: 'u@mastodon.test',
			instanceUrl: 'https://mastodon.test',
			credentialsEncrypted: await encryptJson({ accessToken: 't' }, TEST_ENV.APP_ENCRYPTION_KEY),
			metaJson: '{}',
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
	});

	afterAll(() => close());

	it('reuses a failed target instead of inserting a sibling', async () => {
		const now = new Date();
		const existing = newId();
		await db.insert(publishTargets).values({
			id: existing,
			draftId,
			connectionId: connId,
			status: 'failed',
			errorMessage: 'boom',
			attemptCount: 2,
			createdAt: now,
			updatedAt: now
		});
		const [row] = await ensureTargets(
			db,
			draftId,
			[
				{
					id: connId,
					platform: 'mastodon',
					handle: 'u@mastodon.test',
					displayName: null,
					status: 'active'
				}
			],
			'now',
			null,
			now
		);
		expect(row.reused).toBe(true);
		expect(row.target.id).toBe(existing);
		expect(row.target.status).toBe('pending');
		expect(row.target.attemptCount).toBe(2);
		const all = await db
			.select()
			.from(publishTargets)
			.where(and(eq(publishTargets.draftId, draftId), eq(publishTargets.connectionId, connId)));
		expect(all.filter((t) => t.status !== 'cancelled').map((t) => t.id)).toEqual([existing]);
	});

	it('does not insert another row when a published winner exists', async () => {
		const now = new Date();
		const draft2 = newId();
		await db.insert(drafts).values({
			id: draft2,
			userId,
			baseBody: 'already',
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
		const publishedId = newId();
		await db.insert(publishTargets).values({
			id: publishedId,
			draftId: draft2,
			connectionId: connId,
			status: 'published',
			remotePostId: 'remote-ok',
			attemptCount: 1,
			createdAt: now,
			updatedAt: new Date(now.getTime() - 60_000)
		});
		const [row] = await ensureTargets(
			db,
			draft2,
			[
				{
					id: connId,
					platform: 'mastodon',
					handle: 'u@mastodon.test',
					displayName: null,
					status: 'active'
				}
			],
			'now',
			null,
			now
		);
		expect(row.alreadyPublished).toBe(true);
		expect(row.target.id).toBe(publishedId);
		const all = await db
			.select()
			.from(publishTargets)
			.where(and(eq(publishTargets.draftId, draft2), eq(publishTargets.connectionId, connId)));
		expect(all).toHaveLength(1);
	});

	it('reports a published row without a remote id as published, not in flight', async () => {
		const now = new Date();
		const draft3 = newId();
		await db.insert(drafts).values({
			id: draft3,
			userId,
			baseBody: 'no id came back',
			status: 'published',
			createdAt: now,
			updatedAt: now
		});
		const publishedId = newId();
		await db.insert(publishTargets).values({
			id: publishedId,
			draftId: draft3,
			connectionId: connId,
			status: 'published',
			remotePostId: null,
			attemptCount: 1,
			createdAt: now,
			updatedAt: now
		});
		const [row] = await ensureTargets(
			db,
			draft3,
			[
				{
					id: connId,
					platform: 'mastodon',
					handle: 'u@mastodon.test',
					displayName: null,
					status: 'active'
				}
			],
			'now',
			null,
			now
		);
		expect(row.alreadyPublished).toBe(true);
		expect(row.inFlight).toBe(false);
		expect(row.target.status).toBe('published');
	});

	it('treats fresh publishing as in-flight and stale publishing as reusable', async () => {
		const now = new Date();
		const draft3 = newId();
		await db.insert(drafts).values({
			id: draft3,
			userId,
			baseBody: 'inflight',
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
		const freshId = newId();
		await db.insert(publishTargets).values({
			id: freshId,
			draftId: draft3,
			connectionId: connId,
			status: 'publishing',
			attemptCount: 1,
			createdAt: now,
			updatedAt: now
		});
		const fresh = await ensureTargets(
			db,
			draft3,
			[
				{
					id: connId,
					platform: 'mastodon',
					handle: 'u@mastodon.test',
					displayName: null,
					status: 'active'
				}
			],
			'now',
			null,
			now
		);
		expect(fresh[0].inFlight).toBe(true);
		expect(fresh[0].target.status).toBe('publishing');

		const draft4 = newId();
		await db.insert(drafts).values({
			id: draft4,
			userId,
			baseBody: 'stale',
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
		const staleId = newId();
		await db.insert(publishTargets).values({
			id: staleId,
			draftId: draft4,
			connectionId: connId,
			status: 'publishing',
			attemptCount: 3,
			createdAt: now,
			updatedAt: new Date(now.getTime() - STALE_CLAIM_MS - 1000)
		});
		const stale = await ensureTargets(
			db,
			draft4,
			[
				{
					id: connId,
					platform: 'mastodon',
					handle: 'u@mastodon.test',
					displayName: null,
					status: 'active'
				}
			],
			'now',
			null,
			now
		);
		expect(stale[0].inFlight).toBe(false);
		expect(stale[0].reused).toBe(true);
		expect(stale[0].target.status).toBe('pending');
		expect(stale[0].target.attemptCount).toBe(3);
	});

	it('publish-now reuses a scheduled row and clears scheduledFor', async () => {
		const now = new Date();
		const draft5 = newId();
		await db.insert(drafts).values({
			id: draft5,
			userId,
			baseBody: 'sched-then-now',
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
		const scheduledId = newId();
		const runAt = new Date(now.getTime() + 15 * 60_000);
		await db.insert(publishTargets).values({
			id: scheduledId,
			draftId: draft5,
			connectionId: connId,
			status: 'scheduled',
			scheduledFor: runAt,
			attemptCount: 0,
			createdAt: now,
			updatedAt: now
		});
		const [row] = await ensureTargets(
			db,
			draft5,
			[
				{
					id: connId,
					platform: 'mastodon',
					handle: 'u@mastodon.test',
					displayName: null,
					status: 'active'
				}
			],
			'now',
			null,
			now
		);
		expect(row.reused).toBe(true);
		expect(row.target.id).toBe(scheduledId);
		expect(row.target.status).toBe('pending');
		expect(row.target.scheduledFor).toBeNull();
		// The pending + NULL pair means "publish now": it must stay reachable
		// by the scheduler, because the inline attempt that pair is written for
		// can be cut short (evicted isolate, spent statement budget) and nothing
		// else would ever pick the row up.
		const due = selectDueScheduledTargets(
			[
				{
					id: row.target.id,
					status: row.target.status,
					scheduledFor: row.target.scheduledFor,
					remotePostId: row.target.remotePostId
				}
			],
			now
		);
		expect(due.map((t) => t.id)).toEqual([row.target.id]);
	});

	it('does not clobber a fresh publishing row on a raced update', async () => {
		const now = new Date();
		const draft6 = newId();
		await db.insert(drafts).values({
			id: draft6,
			userId,
			baseBody: 'cas',
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
		const targetId = newId();
		await db.insert(publishTargets).values({
			id: targetId,
			draftId: draft6,
			connectionId: connId,
			status: 'failed',
			errorMessage: 'old',
			attemptCount: 1,
			createdAt: now,
			updatedAt: now
		});
		await db
			.update(publishTargets)
			.set({ status: 'publishing', updatedAt: now })
			.where(eq(publishTargets.id, targetId));
		const [row] = await ensureTargets(
			db,
			draft6,
			[
				{
					id: connId,
					platform: 'mastodon',
					handle: 'u@mastodon.test',
					displayName: null,
					status: 'active'
				}
			],
			'now',
			null,
			now
		);
		expect(row.inFlight).toBe(true);
		const [latest] = await db.select().from(publishTargets).where(eq(publishTargets.id, targetId));
		expect(latest.status).toBe('publishing');
		expect(latest.errorMessage).toBe('old');
	});

	it('keeps a single row when two first-time ensures race', async () => {
		const now = new Date();
		const draft7 = newId();
		await db.insert(drafts).values({
			id: draft7,
			userId,
			baseBody: 'race',
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
		const conn = {
			id: connId,
			platform: 'mastodon' as const,
			handle: 'u@mastodon.test',
			displayName: null,
			status: 'active'
		};
		const [a, b] = await Promise.all([
			ensureTargets(db, draft7, [conn], 'now', null, now),
			ensureTargets(db, draft7, [conn], 'now', null, now)
		]);
		expect(a).toHaveLength(1);
		expect(b).toHaveLength(1);
		const all = await db
			.select()
			.from(publishTargets)
			.where(and(eq(publishTargets.draftId, draft7), eq(publishTargets.connectionId, connId)));
		expect(all).toHaveLength(1);
		expect(new Set([a[0].target.id, b[0].target.id]).size).toBe(1);
	});
});

describe('classifyWinner', () => {
	const now = new Date('2026-08-17T12:00:00Z');
	const base = {
		id: 't',
		draftId: 'd',
		connectionId: 'c',
		variantId: null,
		scheduledFor: null,
		remotePostId: null,
		remoteUrl: null,
		errorMessage: null,
		attemptCount: 0,
		jobId: null,
		createdAt: now,
		updatedAt: now
	};

	it('classifies missing, published, in-flight, and reusable', () => {
		expect(classifyWinner(null, now)).toBe('missing');
		expect(classifyWinner({ ...base, status: 'published', remotePostId: 'r' }, now)).toBe(
			'published'
		);
		expect(classifyWinner({ ...base, status: 'publishing', updatedAt: now }, now)).toBe('inFlight');
		expect(classifyWinner({ ...base, status: 'failed' }, now)).toBe('reusable');
	});

	it('calls a published row published even when the provider gave no id', () => {
		// `reusable` here is a second post on the platform: the route takes that
		// classification as "publish it".
		expect(classifyWinner({ ...base, status: 'published', remotePostId: null }, now)).toBe(
			'published'
		);
		expect(
			refuseInFlightOrPublished({ ...base, status: 'published', remotePostId: null }, now)
		).toBe('Already published');
	});
});

describe('isUniqueConstraintError', () => {
	it('reads a nested drizzle/libsql unique failure', () => {
		const cause = Object.assign(
			new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: publish_targets.draft_id'),
			{
				code: 'SQLITE_CONSTRAINT'
			}
		);
		const wrapped = new Error('Failed query: insert into publish_targets');
		wrapped.cause = cause;
		expect(isUniqueConstraintError(wrapped)).toBe(true);
		expect(isUniqueConstraintError(new Error('Target not found'))).toBe(false);
	});
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type AppDb } from '$lib/server/db/client';
import { connections, drafts, publishTargets, users } from '$lib/server/db/schema';
import { createTestDb } from '$lib/server/db/test';
import { GET as queueGET } from '../src/routes/api/queue/+server';

/**
 * SQLite sorts NULLs before values, so the queue's old `ORDER BY scheduled_for`
 * put every row with no schedule — manually published, pending, failed — ahead
 * of the posts that are actually due. With more than a window's worth of
 * history the Scheduled tab rendered empty while posts were waiting.
 */
describe('GET /api/queue ordering', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;

	const queue = () =>
		queueGET({
			locals: {
				db,
				user: {
					id: userId,
					email: 'queue-order@localhost',
					timezone: 'UTC',
					totpEnabled: true,
					mfaVerified: true
				}
			}
		} as never) as Promise<Response>;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'queue-order@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
		const connId = newId();
		await db.insert(connections).values({
			id: connId,
			userId,
			platform: 'mastodon',
			handle: 'queue@example.social',
			credentialsEncrypted: 'enc',
			status: 'active',
			createdAt: now,
			updatedAt: now
		});

		// More history rows than the 100-row window, all with a NULL schedule.
		const historyDrafts = [];
		const historyTargets = [];
		for (let i = 0; i < 105; i++) {
			const id = newId();
			historyDrafts.push({
				id,
				userId,
				baseBody: `history ${i}`,
				status: 'published',
				createdAt: now,
				updatedAt: new Date(now.getTime() - i * 60_000)
			});
			historyTargets.push({
				id: newId(),
				draftId: id,
				connectionId: connId,
				status: 'published',
				remotePostId: `remote-${i}`,
				attemptCount: 1,
				createdAt: now,
				updatedAt: new Date(now.getTime() - i * 60_000)
			});
		}
		await db.insert(drafts).values(historyDrafts);
		await db.insert(publishTargets).values(historyTargets);

		// Two posts that are actually waiting.
		const upcomingDrafts = [];
		const upcomingTargets = [];
		for (const [i, when] of [
			new Date(now.getTime() + 60_000),
			new Date(now.getTime() + 120_000)
		].entries()) {
			const id = newId();
			upcomingDrafts.push({
				id,
				userId,
				baseBody: `upcoming ${i}`,
				status: 'scheduled',
				createdAt: now,
				updatedAt: now
			});
			upcomingTargets.push({
				id: newId(),
				draftId: id,
				connectionId: connId,
				status: 'scheduled',
				scheduledFor: when,
				attemptCount: 0,
				createdAt: now,
				updatedAt: now
			});
		}
		await db.insert(drafts).values(upcomingDrafts);
		await db.insert(publishTargets).values(upcomingTargets);
	});
	afterAll(() => close());

	it('lists upcoming posts before unscheduled history', async () => {
		const res = await queue();
		expect(res.status).toBe(200);
		const body = (await res.json()) as { targets: Array<{ id: string; status: string }> };
		expect(body.targets).toHaveLength(100);
		// Both waiting posts are in the window, soonest first.
		expect(body.targets[0].status).toBe('scheduled');
		expect(body.targets[1].status).toBe('scheduled');
		expect(body.targets[2].status).toBe('published');
	});
});

/**
 * A published target keeps the `scheduledFor` it went out at, so a long
 * history of scheduled posts sorted ahead of the ones still waiting and pushed
 * them out of the window.
 */
describe('GET /api/queue with scheduled history', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;
	const now = new Date();

	const queue = () =>
		queueGET({
			locals: {
				db,
				user: {
					id: userId,
					email: 'queue-history@localhost',
					timezone: 'UTC',
					totpEnabled: true,
					mfaVerified: true
				}
			}
		} as never) as Promise<Response>;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'queue-history@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
		const connId = newId();
		await db.insert(connections).values({
			id: connId,
			userId,
			platform: 'mastodon',
			handle: 'history@example.social',
			credentialsEncrypted: 'enc',
			status: 'active',
			createdAt: now,
			updatedAt: now
		});

		const rows: Array<{
			body: string;
			status: string;
			scheduledFor: Date | null;
			updatedAt: Date;
			remotePostId?: string;
		}> = [];
		// Scheduled long ago, published at the time: each keeps its schedule.
		for (let i = 0; i < 105; i++) {
			const at = new Date(now.getTime() - (200 - i) * 60 * 60_000);
			rows.push({
				body: `history ${i}`,
				status: 'published',
				scheduledFor: at,
				updatedAt: at,
				remotePostId: `remote-${i}`
			});
		}
		rows.push({
			body: 'due now',
			status: 'pending',
			scheduledFor: null,
			updatedAt: now
		});
		rows.push({
			body: 'later',
			status: 'scheduled',
			scheduledFor: new Date(now.getTime() + 120_000),
			updatedAt: now
		});
		rows.push({
			body: 'sooner',
			status: 'scheduled',
			scheduledFor: new Date(now.getTime() + 60_000),
			updatedAt: now
		});

		for (const row of rows) {
			const draftId = newId();
			await db.insert(drafts).values({
				id: draftId,
				userId,
				baseBody: row.body,
				status: row.status === 'published' ? 'published' : 'scheduled',
				createdAt: now,
				updatedAt: row.updatedAt
			});
			await db.insert(publishTargets).values({
				id: newId(),
				draftId,
				connectionId: connId,
				status: row.status,
				scheduledFor: row.scheduledFor,
				remotePostId: row.remotePostId ?? null,
				attemptCount: row.status === 'published' ? 1 : 0,
				createdAt: now,
				updatedAt: row.updatedAt
			});
		}
	});
	afterAll(() => close());

	it('lists every waiting post first, then the newest history', async () => {
		const res = await queue();
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			targets: Array<{ status: string; draft: { baseBody: string } }>;
			hasMore: boolean;
		};
		expect(body.targets).toHaveLength(100);
		expect(body.hasMore).toBe(true);
		expect(body.targets.slice(0, 3).map((t) => t.draft.baseBody)).toEqual([
			'due now',
			'sooner',
			'later'
		]);
		// History follows newest first, so what falls off the end is the oldest.
		expect(body.targets[3].draft.baseBody).toBe('history 104');
		expect(body.targets[4].draft.baseBody).toBe('history 103');
		expect(body.targets.every((t, i) => i < 3 || t.status === 'published')).toBe(true);
	});
});

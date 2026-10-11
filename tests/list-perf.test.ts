import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	connections,
	draftMedia,
	drafts,
	draftVariants,
	publishTargets,
	users
} from '#lib/server/db/schema.js';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { createTestDb } from '#lib/server/db/test.js';
import { GET as draftsGET } from '../src/routes/api/drafts/+server';
import { GET as queueGET } from '../src/routes/api/queue/+server';
import { GET as draftGET, PATCH as draftPATCH } from '../src/routes/api/drafts/[id]/+server';

describe('list endpoint query budgets', () => {
	let db: AppDb;
	let close: () => void;
	let count: () => number;
	let reset: () => void;
	let userId: string;
	let otherId: string;
	let firstDraftId: string;
	const localsFor = (id: string) => ({
		db,
		user: { id, email: 'perf@localhost', timezone: 'UTC', totpEnabled: true, mfaVerified: true }
	});

	beforeAll(async () => {
		const ctx = await createTestDb();
		db = ctx.db;
		close = ctx.close;
		count = ctx.count;
		reset = ctx.reset;
		const now = new Date();
		userId = newId();
		otherId = newId();
		for (const [id, email] of [
			[userId, 'perf@localhost'],
			[otherId, 'other@localhost']
		]) {
			await db
				.insert(users)
				.values({ id, email, passwordHash: 'x', timezone: 'UTC', createdAt: now, updatedAt: now });
		}
		const connIds: string[] = [];
		for (const platform of ['mastodon', 'bluesky']) {
			const id = newId();
			connIds.push(id);
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
		for (let i = 0; i < 15; i++) {
			const draftId = newId();
			if (i === 0) firstDraftId = draftId;
			await db.insert(drafts).values({
				id: draftId,
				userId,
				baseBody: `draft ${i}`,
				status: 'draft',
				createdAt: now,
				updatedAt: now
			});
			await db.insert(draftVariants).values({
				id: newId(),
				draftId,
				platform: 'mastodon',
				body: `variant ${i}`,
				createdAt: now,
				updatedAt: now
			});
			for (let m = 0; m < 2; m++) {
				await db.insert(draftMedia).values({
					id: newId(),
					draftId,
					storageKey: `k-${i}-${m}`,
					mime: 'image/png',
					size: 10,
					createdAt: now
				});
			}
			for (const connId of connIds) {
				await db.insert(publishTargets).values({
					id: newId(),
					draftId,
					connectionId: connId,
					status: i % 2 ? 'scheduled' : 'pending',
					scheduledFor: new Date(now.getTime() - 60_000),
					attemptCount: 0,
					createdAt: now,
					updatedAt: now
				});
			}
		}
		// Another user's target must never leak into my queue.
		const otherDraft = newId();
		await db.insert(drafts).values({
			id: otherDraft,
			userId: otherId,
			baseBody: 'not mine',
			status: 'draft',
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
		await db.insert(publishTargets).values({
			id: newId(),
			draftId: otherDraft,
			connectionId: otherConn,
			status: 'scheduled',
			scheduledFor: new Date(now.getTime() - 60_000),
			attemptCount: 0,
			createdAt: now,
			updatedAt: now
		});
	});
	afterAll(() => close());

	it('lists drafts with full relations in a flat query budget', async () => {
		reset();
		const res = await draftsGET({ locals: localsFor(userId) } as never);
		const body = (await res.json()) as {
			drafts: Array<{ variants: unknown[]; media: unknown[]; targets: unknown[] }>;
		};
		expect(res.status).toBe(200);
		expect(body.drafts).toHaveLength(15);
		for (const d of body.drafts) {
			expect(d.variants).toHaveLength(1);
			expect(d.media).toHaveLength(2);
			expect(d.targets).toHaveLength(2);
		}
		expect(count()).toBeLessThanOrEqual(8);
	});

	it('lists only my queue targets in a flat query budget', async () => {
		reset();
		const res = await queueGET({ locals: localsFor(userId) } as never);
		const body = (await res.json()) as {
			targets: Array<{
				id: string;
				draft: {
					id: string;
					media: Array<{
						storageKey: string;
						mime: string;
						segmentIndex: number;
						sortOrder: number;
					}>;
				};
			}>;
		};
		expect(res.status).toBe(200);
		expect(body.targets).toHaveLength(30);
		// Gallery data for /posts: every queued draft carries its attachments.
		for (const t of body.targets) {
			expect(t.draft.media).toHaveLength(2);
			for (const m of t.draft.media) {
				expect(m.storageKey).toMatch(/^k-\d+-[01]$/);
				expect(m.mime).toBe('image/png');
			}
			const order = t.draft.media.map((m) => `${m.segmentIndex}:${m.sortOrder}`);
			expect([...order].sort()).toEqual(order);
		}
		// 3-statement batch (targets + connections + drafts) + 1 media read.
		expect(count()).toBeLessThanOrEqual(5);
	});

	it('caps the drafts list with a hasMore flag', async () => {
		reset();
		const res = await draftsGET({
			locals: localsFor(userId),
			url: new URL('http://localhost/api/drafts?limit=5')
		} as never);
		const body = (await res.json()) as { drafts: unknown[]; hasMore: boolean };
		expect(res.status).toBe(200);
		expect(body.drafts).toHaveLength(5);
		expect(body.hasMore).toBe(true);
	});

	it('loads one draft with relations in two round trips', async () => {
		reset();
		const target = (await draftGET({
			params: { id: firstDraftId },
			locals: localsFor(userId)
		} as never)) as Response;
		expect(target.status).toBe(200);
		const body = (await target.json()) as {
			draft: {
				id: string;
				variants: unknown[];
				media: unknown[];
				targets: { connectionId: string; connection?: { id: string } }[];
			};
		};
		expect(body.draft.id).toBe(firstDraftId);
		expect(body.draft.variants).toHaveLength(1);
		expect(body.draft.media).toHaveLength(2);
		expect(body.draft.targets).toHaveLength(2);
		for (const t of body.draft.targets) expect(t.connection?.id).toBe(t.connectionId);
		// 4-statement batch + connection batch: flat regardless of target count.
		expect(count()).toBeLessThanOrEqual(12);
	});

	it('autosave PATCH acknowledges without a reload', async () => {
		reset();
		const patched = (await draftPATCH({
			params: { id: firstDraftId },
			locals: localsFor(userId),
			request: new Request('http://localhost/api/drafts/x', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ baseBody: 'patched body' })
			})
		} as never)) as Response;
		expect(patched.status).toBe(200);
		const payload = (await patched.json()) as { ok: boolean };
		expect(payload).toEqual({ ok: true });
		// Existence check + update only: no relation reload.
		expect(count()).toBeLessThanOrEqual(3);
	});
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { connections, drafts, publishTargets, users } from '#lib/server/db/schema.js';
import { createTestDb } from '#lib/server/db/test.js';
import { GET as draftsGET } from '../src/routes/api/drafts/+server';
import { GET as queueGET } from '../src/routes/api/queue/+server';

/**
 * Posts reads 100 deliveries and 200 drafts at a time. `before` walks back
 * from there and `q` searches the whole history; with neither, the answer is
 * the one API clients and the MCP server have always had.
 */
describe('paging and search on the queue and drafts lists', () => {
	let db: AppDb;
	let close: () => void;
	const userId = 'paging-user';
	const now = Date.UTC(2026, 10, 1, 12, 0, 0);
	// Three history rows share a timestamp, so the page edge has a tie to break.
	const historyTimes = Array.from({ length: 12 }, (_, i) => now - (i < 3 ? 0 : i) * 60_000);

	type Target = { id: string; status: string; draft: { baseBody: string } };
	type QueueBody = { targets: Target[]; hasMore: boolean; next: string | null };
	type DraftsBody = {
		drafts: { id: string; baseBody: string }[];
		hasMore: boolean;
		next: string | null;
	};

	const locals = () => ({
		db,
		user: {
			id: userId,
			email: 'paging@localhost',
			timezone: 'UTC',
			totpEnabled: true,
			mfaVerified: true
		}
	});
	const queue = async (query = '') => {
		const res = (await queueGET({
			locals: locals(),
			url: new URL(`http://localhost/api/queue${query}`)
		} as never)) as Response;
		return { status: res.status, body: (await res.json()) as QueueBody };
	};
	const draftList = async (query = '') => {
		const res = (await draftsGET({
			locals: locals(),
			url: new URL(`http://localhost/api/drafts${query}`)
		} as never)) as Response;
		return { status: res.status, body: (await res.json()) as DraftsBody };
	};

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const stamp = { createdAt: new Date(now), updatedAt: new Date(now) };
		await db.insert(users).values({
			id: userId,
			email: 'paging@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			...stamp
		});
		await db.insert(connections).values({
			id: 'paging-conn',
			userId,
			platform: 'mastodon',
			handle: 'paging@example.social',
			credentialsEncrypted: 'enc',
			status: 'active',
			...stamp
		});
		const add = async (body: string, status: string, updatedAtMs: number) => {
			const draftId = newId();
			await db.insert(drafts).values({
				id: draftId,
				userId,
				baseBody: body,
				status: status === 'scheduled' ? 'scheduled' : 'published',
				createdAt: new Date(now),
				updatedAt: new Date(updatedAtMs)
			});
			await db.insert(publishTargets).values({
				id: newId(),
				draftId,
				connectionId: 'paging-conn',
				status,
				scheduledFor: status === 'scheduled' ? new Date(now + 3_600_000) : null,
				remotePostId: status === 'published' ? `remote-${draftId}` : null,
				attemptCount: 1,
				createdAt: new Date(now),
				updatedAt: new Date(updatedAtMs)
			});
		};
		await add('Waiting to go', 'scheduled', now);
		for (const [i, at] of historyTimes.entries()) {
			await add(
				i === 10 ? 'An old post about 100% Coffee' : `history ${i}`,
				i % 4 === 3 ? 'failed' : 'published',
				at
			);
		}
	});
	afterAll(() => close());

	it('answers as before when no page or search is asked for', async () => {
		const { status, body } = await queue();
		expect(status).toBe(200);
		expect(body.hasMore).toBe(false);
		expect(body.next).toBeNull();
		expect(body.targets).toHaveLength(13);
		expect(body.targets[0].draft.baseBody).toBe('Waiting to go');
	});

	it('walks the whole history a page at a time, with no row twice or missed', async () => {
		const first = await queue('?limit=3');
		expect(first.body.hasMore).toBe(true);
		expect(first.body.next).toEqual(expect.any(String));
		const seen = first.body.targets.map((t) => t.id);
		let next = first.body.next;
		let pages = 1;
		while (next) {
			const page = await queue(`?limit=3&before=${encodeURIComponent(next)}`);
			expect(page.status).toBe(200);
			// History only: what is waiting was on the first page.
			expect(page.body.targets.every((t) => ['published', 'failed'].includes(t.status))).toBe(true);
			seen.push(...page.body.targets.map((t) => t.id));
			next = page.body.next;
			pages += 1;
			expect(pages).toBeLessThan(10);
		}
		expect(seen).toHaveLength(13);
		expect(new Set(seen).size).toBe(13);
	});

	it('reaches history from a first page of nothing but waiting posts', async () => {
		const first = await queue('?limit=1');
		expect(first.body.targets.map((t) => t.status)).toEqual(['scheduled']);
		const rest = await queue(`?limit=100&before=${encodeURIComponent(first.body.next!)}`);
		expect(rest.body.targets).toHaveLength(12);
		expect(rest.body.next).toBeNull();
	});

	it('finds an old post by its words, ignoring case, with % matched as itself', async () => {
		const { body } = await queue('?q=100%25%20coffee');
		expect(body.targets.map((t) => t.draft.baseBody)).toEqual(['An old post about 100% Coffee']);
		const none = await queue('?q=%25%25');
		expect(none.body.targets).toEqual([]);
	});

	it('pages and searches drafts the same way', async () => {
		const all = await draftList('?view=summary');
		expect(all.body.drafts).toHaveLength(13);
		expect(all.body.next).toBeNull();
		const seen: string[] = [];
		let query = '?view=summary&limit=5';
		for (;;) {
			const page = await draftList(query);
			seen.push(...page.body.drafts.map((d) => d.id));
			if (!page.body.next) break;
			query = `?view=summary&limit=5&before=${encodeURIComponent(page.body.next)}`;
		}
		expect(new Set(seen).size).toBe(13);
		const found = await draftList('?q=coffee');
		expect(found.body.drafts.map((d) => d.baseBody)).toEqual(['An old post about 100% Coffee']);
	});

	it('refuses a cursor it did not mint and a search past 200 characters', async () => {
		expect((await queue('?before=yesterday')).status).toBe(400);
		expect((await draftList('?before=12:')).status).toBe(400);
		expect((await queue(`?q=${'a'.repeat(201)}`)).status).toBe(400);
	});
});

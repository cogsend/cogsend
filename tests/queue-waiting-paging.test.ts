import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { connections, drafts, publishTargets, users } from '#lib/server/db/schema.js';
import { createTestDb } from '#lib/server/db/test.js';
import { GET as queueGET } from '../src/routes/api/queue/+server';

/**
 * More posts waiting than fit on a page: `next` walks on through them in
 * their own order (soonest first), then into history, and a post whose
 * accounts fall on both sides of a page edge is named with its full count.
 */
describe('paging through the waiting posts', () => {
	let db: AppDb;
	let close: () => void;
	const userId = 'waiting-user';
	const now = Date.UTC(2026, 10, 1, 12, 0, 0);
	const hour = 3_600_000;
	type Target = { id: string; status: string; draft: { id: string } };
	type QueueBody = {
		targets: Target[];
		hasMore: boolean;
		next: string | null;
		waitingTotals?: Record<string, number>;
	};
	type Row = { id: string; draftId: string; at: number; updatedAt: number; waiting: boolean };
	const visible: Row[] = [];
	const draftOf: Record<string, string> = {};

	const queue = async (query = '') => {
		const res = (await queueGET({
			locals: {
				db,
				user: {
					id: userId,
					email: 'waiting@localhost',
					timezone: 'UTC',
					totpEnabled: true,
					mfaVerified: true
				}
			},
			url: new URL(`http://localhost/api/queue${query}`)
		} as never)) as Response;
		return { status: res.status, body: (await res.json()) as QueueBody };
	};

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const stamp = { createdAt: new Date(now), updatedAt: new Date(now) };
		await db.insert(users).values({
			id: userId,
			email: 'waiting@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			...stamp
		});
		for (const [id, status] of [
			['a', 'active'],
			['b', 'active'],
			['c', 'active'],
			['gone', 'disconnected']
		]) {
			await db.insert(connections).values({
				id,
				userId,
				platform: 'mastodon',
				credentialsEncrypted: 'enc',
				status,
				...stamp
			});
		}
		const post = async (
			name: string,
			rows: [conn: string, at: number | null, status?: string][]
		) => {
			const draftId = newId();
			draftOf[name] = draftId;
			await db
				.insert(drafts)
				.values({ id: draftId, userId, baseBody: name, status: 'scheduled', ...stamp });
			for (const [conn, at, status = 'scheduled'] of rows) {
				const id = newId();
				const waiting = !['published', 'failed'].includes(status);
				const updatedAt = waiting ? now : at!;
				await db.insert(publishTargets).values({
					id,
					draftId,
					connectionId: conn,
					status,
					scheduledFor: waiting && at !== null ? new Date(at) : null,
					remotePostId: status === 'published' ? `remote-${id}` : null,
					attemptCount: 0,
					createdAt: new Date(now),
					updatedAt: new Date(updatedAt)
				});
				if (conn !== 'gone')
					visible.push({ id, draftId, at: waiting ? (at ?? -1) : 0, updatedAt, waiting });
			}
		};
		await post('now', [['a', null, 'pending']]);
		// Same time and the same updatedAt on three accounts: only the id orders them.
		await post('three accounts', [
			['a', now + hour],
			['b', now + hour],
			['c', now + hour],
			['gone', now + hour]
		]);
		await post('same hour', [['a', now + hour]]);
		await post('two times', [
			['a', now + 2 * hour],
			['b', now + 5 * hour]
		]);
		await post('later pair', [
			['a', now + 3 * hour],
			['b', now + 3 * hour]
		]);
		await post('on a disconnected account', [['gone', now + hour]]);
		for (let i = 1; i <= 4; i++) await post(`history ${i}`, [['a', now - i * hour, 'published']]);
	});
	afterAll(() => close());

	const expectedOrder = () =>
		[...visible]
			.sort(
				(x, y) =>
					Number(y.waiting) - Number(x.waiting) ||
					(x.waiting ? x.at - y.at : 0) ||
					y.updatedAt - x.updatedAt ||
					(x.id < y.id ? 1 : x.id > y.id ? -1 : 0)
			)
			.map((r) => r.id);

	it('lists everything in one answer in the same order a page at a time reads it', async () => {
		const whole = await queue('?limit=500');
		expect(whole.body.next).toBeNull();
		expect(whole.body.waitingTotals).toBeUndefined();
		expect(whole.body.targets.map((t) => t.id)).toEqual(expectedOrder());

		for (const size of [1, 2, 3, 4]) {
			const seen: string[] = [];
			let query = `?limit=${size}`;
			for (let pages = 0; ; pages++) {
				expect(pages).toBeLessThan(20);
				const page = await queue(query);
				expect(page.status).toBe(200);
				seen.push(...page.body.targets.map((t) => t.id));
				if (!page.body.next) break;
				query = `?limit=${size}&before=${encodeURIComponent(page.body.next)}`;
			}
			expect(seen).toEqual(expectedOrder());
		}
	});

	it('names each post whose accounts a page edge splits, with all of its waiting count', async () => {
		const order = expectedOrder();
		const byId = new Map(visible.map((r) => [r.id, r]));
		const waitingOf = (draftId: string) =>
			visible.filter((r) => r.waiting && r.draftId === draftId).length;
		let splitSeen = 0;
		const flagged = new Set<string>();
		for (let size = 1; size < order.length + 3; size++) {
			const { body } = await queue(`?limit=${size}`);
			const split: Record<string, number> = {};
			// The page is cut among the waiting rows: a row on a disconnected
			// account takes a place on it unseen, so read the page that came back.
			if (body.next?.startsWith('u:')) {
				const onPage = body.targets.map((t) => byId.get(t.id)!);
				for (const row of onPage) {
					if (!row.waiting) continue;
					const total = waitingOf(row.draftId);
					if (onPage.filter((r) => r.draftId === row.draftId).length < total)
						split[row.draftId] = total;
				}
			}
			expect(body.waitingTotals ?? {}).toEqual(split);
			splitSeen += Object.keys(split).length;
			for (const id of Object.keys(split)) flagged.add(id);
		}
		// The seed is meant to split posts; a seed that never does tests nothing.
		expect(splitSeen).toBeGreaterThan(3);
		// Its accounts are hours apart, so the pages that hold one but not the other name it.
		expect(flagged.has(draftOf['two times'])).toBe(true);
		expect(flagged.has(draftOf['three accounts'])).toBe(true);
	});

	it('leaves out a disconnected account in the list and in the counts', async () => {
		const { body } = await queue('?limit=500');
		expect(body.targets.some((t) => t.draft.id === draftOf['on a disconnected account'])).toBe(
			false
		);
	});

	it('refuses a waiting cursor it did not mint', async () => {
		for (const bad of ['u:soon:1:x', 'u:-1:5:', 'u::5:x', 'u:1:2', 'u:1.5:2:x']) {
			expect((await queue(`?before=${encodeURIComponent(bad)}`)).status).toBe(400);
		}
	});
});

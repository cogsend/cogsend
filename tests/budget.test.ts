import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createClient } from '@libsql/client';
import {
	countingD1,
	countingFetch,
	countingMediaStore,
	FREE_PLAN_SUBREQUESTS,
	parseSubrequestLimit,
	rawBinding,
	SubrequestBudget
} from '$lib/server/budget';
import { encryptJson } from '$lib/server/crypto';
import { newId, type AppDb } from '$lib/server/db/client';
import { ensureSchemaOnce } from '$lib/server/db/init-sql';
import { connections, drafts, publishTargets, users } from '$lib/server/db/schema';
import { createTestDb, createTestMedia, TEST_ENV } from '$lib/server/db/test';
import { publishCallEstimate, publishTarget } from '$lib/server/publish';
import { runSchedulerTick } from '$lib/server/scheduler';
import type { FetchLike } from '$lib/server/providers/types';

describe('parseSubrequestLimit', () => {
	it('defaults to the Free plan and accepts a positive integer as text or number', () => {
		expect(parseSubrequestLimit(undefined)).toBe(FREE_PLAN_SUBREQUESTS);
		expect(parseSubrequestLimit('')).toBe(FREE_PLAN_SUBREQUESTS);
		expect(parseSubrequestLimit('10000')).toBe(10_000);
		expect(parseSubrequestLimit(' 1000 ')).toBe(1000);
		expect(parseSubrequestLimit(10000)).toBe(10_000);
		for (const bad of ['0', '-5', '12.5', 'lots', null]) {
			expect(parseSubrequestLimit(bad)).toBe(FREE_PLAN_SUBREQUESTS);
		}
	});
});

describe('counting wrappers', () => {
	it('counts D1 statements while the real binding keeps its private state', async () => {
		// The Workers binding keeps its state in private fields, which only
		// resolve when a method runs with the real object as `this`.
		class FakeD1 {
			#calls: string[] = [];
			prepare(sql: string) {
				this.#calls.push(sql);
				return { first: async () => null };
			}
			async exec(sql: string) {
				this.#calls.push(sql);
			}
			async batch(list: unknown[]) {
				return list.map(() => ({ results: [] }));
			}
			get seen() {
				return this.#calls.length;
			}
		}
		const raw = new FakeD1();
		const budget = new SubrequestBudget(50);
		const d1 = countingD1(raw as unknown as D1Database, budget);
		d1.prepare('SELECT 1');
		d1.prepare('SELECT 2');
		await d1.exec('PRAGMA x');
		await d1.batch([]);
		expect(budget.used).toBe(3);
		expect(budget.remaining).toBe(47);
		expect(raw.seen).toBe(3);
		expect(rawBinding(d1)).toBe(raw);
		expect(rawBinding(raw)).toBe(raw);
	});

	it('runs the schema check once per binding, whichever wrapper a request brings', async () => {
		const client = createClient({ url: ':memory:' });
		let prepares = 0;
		const binding = {
			exec: (sql: string) => client.executeMultiple(sql),
			prepare: (sql: string) => {
				prepares += 1;
				const stmt = (args: unknown[] = []) => ({
					run: () => client.execute({ sql, args: args as never }),
					all: async () => ({
						results: (await client.execute({ sql, args: args as never })).rows
					}),
					first: async () => (await client.execute({ sql, args: args as never })).rows[0] ?? null,
					bind: (...next: unknown[]) => stmt(next)
				});
				return stmt();
			}
		} as unknown as D1Database;
		const first = new SubrequestBudget(1000);
		await ensureSchemaOnce(countingD1(binding, first));
		expect(first.used).toBeGreaterThan(0);
		const before = prepares;
		const second = new SubrequestBudget(1000);
		await ensureSchemaOnce(countingD1(binding, second));
		expect(prepares).toBe(before);
		expect(second.used).toBe(0);
		client.close();
	});

	it('counts storage and fetch calls', async () => {
		const budget = new SubrequestBudget(50);
		const store = countingMediaStore(createTestMedia(), budget);
		await store.put('k', new Uint8Array([1]), 'image/png');
		await store.get('k');
		await store.size?.('k');
		await store.getRange?.('k', 0, 0);
		await store.deleteMany?.(['k']);
		expect(budget.used).toBe(5);
		const streamed = countingMediaStore({ ...createTestMedia(), open: async () => null }, budget);
		await streamed.open?.('k');
		expect(budget.used).toBe(6);
		const fetched = countingFetch(async () => new Response('ok'), budget);
		await fetched('https://example.test');
		expect(budget.used).toBe(7);
	});
});

describe('publishCallEstimate', () => {
	const image = { mime: 'image/png', size: 1000, storageKey: 'k' };
	it('grows with segments and attachments', () => {
		const one = publishCallEstimate('mastodon', { text: 'hi' });
		const withImages = publishCallEstimate('mastodon', { text: 'hi', media: [image, image] });
		const thread = publishCallEstimate('mastodon', {
			text: 'a',
			thread: [{ text: 'a' }, { text: 'b' }, { text: 'c' }]
		});
		expect(withImages).toBeGreaterThan(one);
		expect(thread).toBeGreaterThan(one);
	});

	it('counts no storage reads where the platform is sent URLs', () => {
		const withImages = { text: 'hi', media: [image, image] };
		expect(publishCallEstimate('zernio', withImages)).toBe(
			publishCallEstimate('zernio', { text: 'hi' })
		);
		// Mastodon is sent the bytes: each image is a read on top of its upload.
		expect(publishCallEstimate('mastodon', withImages)).toBe(
			publishCallEstimate('mastodon', { text: 'hi' }) + 2 * (1 + 3)
		);
	});

	it('counts X media uploads by their chunks', () => {
		const small = publishCallEstimate('x', { text: 'hi', media: [image] });
		const large = publishCallEstimate('x', {
			text: 'hi',
			media: [{ ...image, mime: 'image/gif', size: 12_000_000 }]
		});
		expect(large).toBeGreaterThan(small);
	});
});

describe('publishing within a request budget', () => {
	let db: AppDb;
	let close: () => void;
	const store = createTestMedia();
	let userId: string;
	let connId: string;
	let posted: string[];

	const mastodon: FetchLike = async (input, init) => {
		const url = typeof input === 'string' ? input : input.toString();
		if (url.endsWith('/api/v1/statuses')) {
			const body = JSON.parse(String(init?.body ?? '{}')) as { status: string };
			posted.push(body.status);
			return Response.json({ id: `s${posted.length}`, url: `https://m.test/@me/${posted.length}` });
		}
		return new Response('unmocked', { status: 404 });
	};

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'budget@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
		connId = newId();
		await db.insert(connections).values({
			id: connId,
			userId,
			platform: 'mastodon',
			handle: 'me@m.test',
			instanceUrl: 'https://m.test',
			credentialsEncrypted: await encryptJson(
				{ accessToken: 'token', instanceUrl: 'https://m.test' },
				TEST_ENV.APP_ENCRYPTION_KEY
			),
			metaJson: JSON.stringify({ maxCharacters: 500 }),
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
	});
	afterAll(() => close());

	async function dueTarget(body: string, minutesAgo: number) {
		const now = new Date();
		const draftId = newId();
		await db.insert(drafts).values({
			id: draftId,
			userId,
			baseBody: body,
			status: 'scheduled',
			createdAt: now,
			updatedAt: now
		});
		const id = newId();
		await db.insert(publishTargets).values({
			id,
			draftId,
			connectionId: connId,
			status: 'scheduled',
			scheduledFor: new Date(now.getTime() - minutesAgo * 60_000),
			attemptCount: 0,
			createdAt: now,
			updatedAt: now
		});
		return id;
	}

	async function row(id: string) {
		const [r] = await db.select().from(publishTargets).where(eq(publishTargets.id, id));
		return r;
	}

	it('leaves a later target untouched when it might not fit, and runs the first regardless', async () => {
		posted = [];
		const id = await dueTarget('later one', 1);
		const spent = new SubrequestBudget(50);
		spent.count(49);
		const deferred = await publishTarget(db, TEST_ENV, store, id, {
			fetchImpl: mastodon,
			budget: spent
		});
		expect(deferred).toMatchObject({ deferred: true, skipped: true });
		const untouched = await row(id);
		expect(untouched.status).toBe('scheduled');
		expect(untouched.attemptCount).toBe(0);
		expect(posted).toEqual([]);

		const first = await publishTarget(db, TEST_ENV, store, id, {
			fetchImpl: mastodon,
			budget: spent,
			mustTry: true
		});
		expect(first.status).toBe('published');
		expect(posted).toEqual(['later one']);
	});

	it('the tick publishes what fits and leaves the rest due, in order', async () => {
		posted = [];
		const a = await dueTarget('first due', 30);
		const b = await dueTarget('second due', 20);
		const c = await dueTarget('third due', 10);
		// The test database is not a counted D1 binding, so stand in for a
		// request that has already spent most of the Free plan's 50.
		const tight = new SubrequestBudget(50);
		tight.count(40);
		const result = await runSchedulerTick(db, TEST_ENV, {
			store,
			fetchImpl: mastodon as typeof fetch,
			budget: tight
		});
		expect(posted[0]).toBe('first due');
		expect(result.deferred).toBe(1);
		expect(result.processed).toBe(posted.length);
		expect((await row(a)).status).toBe('published');
		const left = [await row(b), await row(c)].filter((r) => r.status !== 'published');
		expect(left.length).toBeGreaterThan(0);
		for (const r of left) {
			expect(r.status).toBe('scheduled');
			expect(r.attemptCount).toBe(0);
		}

		// The next tick, with a fresh budget, finishes the backlog.
		const next = await runSchedulerTick(db, TEST_ENV, {
			store,
			fetchImpl: mastodon as typeof fetch,
			budget: new SubrequestBudget(10_000)
		});
		expect(next.deferred).toBe(0);
		expect((await row(b)).status).toBe('published');
		expect((await row(c)).status).toBe('published');
		expect(posted).toEqual(['first due', 'second due', 'third due']);
	});

	it('without a budget the tick works through everything, as before', async () => {
		posted = [];
		const ids = [await dueTarget('one', 3), await dueTarget('two', 2)];
		const result = await runSchedulerTick(db, TEST_ENV, {
			store,
			fetchImpl: mastodon as typeof fetch
		});
		expect(result.deferred).toBe(0);
		for (const id of ids) expect((await row(id)).status).toBe('published');
	});
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connections, drafts, publishTargets, users } from '#lib/server/db/schema.js';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { createTestDb, TEST_ENV } from '#lib/server/db/test.js';
import { loadOwnedDraft } from '#lib/server/draft-record.js';
import { load as accountsLoad } from '../src/routes/accounts/+page.server';
import { load as composeLoad } from '../src/routes/compose/+page.server';

const USER = {
	id: 'u1',
	email: 'owner@localhost',
	timezone: 'UTC',
	totpEnabled: true,
	mfaVerified: true
};

const localsFor = (db: AppDb) => ({
	db,
	env: TEST_ENV,
	authMethod: 'session' as const,
	user: USER
});

/** The pieces these tests assert on; the loads return more than that. */
type AccountsResult = { connections: unknown[]; loadFailed: boolean; appUrl: string };
type ComposeResult = {
	connections: unknown[];
	draft: { id: string } | null;
	displayName: string | null;
};

/** Every read fails: builders chain, then reject when awaited or batched. */
function brokenDb(): AppDb {
	const chain: Record<string, unknown> = {
		then(_resolve: unknown, reject: (err: Error) => void) {
			reject(new Error('D1 unavailable'));
		}
	};
	for (const method of ['from', 'where', 'orderBy', 'innerJoin', 'groupBy', 'limit']) {
		chain[method] = () => chain;
	}
	return {
		select: () => chain,
		batch: () => {
			throw new Error('D1 unavailable');
		}
	} as unknown as AppDb;
}

/** Fail only batches that touch `table`, so the other read still lands. */
function tableFailingDb(db: AppDb, table: string): AppDb {
	return new Proxy(db as object, {
		get(target, prop, receiver) {
			if (prop === 'batch') {
				return async (queries: Array<{ toSQL(): { sql: string } }>) => {
					if (queries.some((query) => query.toSQL().sql.includes(table))) {
						throw new Error(`D1 unavailable: ${table}`);
					}
					const capable = target as unknown as {
						batch: (q: unknown[]) => Promise<unknown[]>;
					};
					return capable.batch(queries);
				};
			}
			const value = Reflect.get(target, prop, receiver);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	}) as AppDb;
}

describe('page loads survive a database failure', () => {
	let db: AppDb;
	let close: () => void;
	let connectionId: string;
	let draftId: string;

	beforeAll(async () => {
		const harness = await createTestDb();
		db = harness.db;
		close = harness.close;
		const now = new Date();
		await db.insert(users).values({
			id: USER.id,
			email: USER.email,
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
		connectionId = newId();
		await db.insert(connections).values({
			id: connectionId,
			userId: USER.id,
			platform: 'bluesky',
			credentialsEncrypted: 'x',
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
		draftId = newId();
		await db.insert(drafts).values({
			id: draftId,
			userId: USER.id,
			baseBody: 'stored',
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
	});

	afterAll(() => close());

	it('accounts falls back to its retry state instead of throwing', async () => {
		const result = (await accountsLoad({
			locals: localsFor(brokenDb()),
			url: new URL('http://localhost/accounts')
		} as never)) as AccountsResult;
		expect(result).toMatchObject({
			connections: [],
			loadFailed: true,
			appUrl: TEST_ENV.APP_URL
		});
	});

	it('accounts reports a healthy read as not failed', async () => {
		const result = (await accountsLoad({
			locals: localsFor(db),
			url: new URL('http://localhost/accounts')
		} as never)) as AccountsResult;
		expect(result).toMatchObject({ loadFailed: false });
		expect(result.connections).toHaveLength(1);
	});

	it('compose keeps the account list when only the draft read fails', async () => {
		const result = (await composeLoad({
			locals: localsFor(tableFailingDb(db, 'draft_variants')),
			url: new URL(`http://localhost/compose?id=${draftId}`)
		} as never)) as ComposeResult;
		expect(result.connections).toHaveLength(1);
		expect(result.draft).toBeNull();
	});

	it('compose keeps the draft when only the account list fails', async () => {
		const result = (await composeLoad({
			locals: localsFor(tableFailingDb(db, 'users')),
			url: new URL(`http://localhost/compose?id=${draftId}`)
		} as never)) as ComposeResult;
		expect(result.connections).toEqual([]);
		expect(result.draft?.id).toBe(draftId);
	});

	it('compose answers with empty defaults when every read fails', async () => {
		const result = (await composeLoad({
			locals: localsFor(brokenDb()),
			url: new URL(`http://localhost/compose?id=${draftId}`)
		} as never)) as ComposeResult;
		expect(result).toMatchObject({ connections: [], draft: null });
		expect(result.displayName).toBeNull();
	});
});

describe('loadOwnedDraft keeps its id lists inside the D1 cap', () => {
	it('chunks the connection lookup past 100 targets', async () => {
		const harness = await createTestDb();
		try {
			const now = new Date();
			const userId = 'chunk-user';
			await harness.db.insert(users).values({
				id: userId,
				email: 'chunk@localhost',
				passwordHash: 'x',
				timezone: 'UTC',
				createdAt: now,
				updatedAt: now
			});
			const draftId = newId();
			await harness.db.insert(drafts).values({
				id: draftId,
				userId,
				baseBody: 'chunked',
				status: 'draft',
				createdAt: now,
				updatedAt: now
			});
			const connectionRows = Array.from({ length: 101 }, () => ({
				id: newId(),
				userId,
				platform: 'bluesky',
				credentialsEncrypted: 'x',
				status: 'active',
				createdAt: now,
				updatedAt: now
			}));
			await harness.db.insert(connections).values(connectionRows);
			await harness.db.insert(publishTargets).values(
				connectionRows.map((connection) => ({
					id: newId(),
					draftId,
					connectionId: connection.id,
					status: 'scheduled',
					attemptCount: 0,
					createdAt: now,
					updatedAt: now
				}))
			);
			// Seeding is not what is under test.
			harness.reset();
			const draft = await loadOwnedDraft(harness.db, draftId, userId);
			expect(draft?.targets).toHaveLength(101);
			// The lower bound keeps the probe honest: a counter that read 0
			// would pass the cap without ever seeing the 100-id chunk.
			expect(harness.maxParams()).toBeGreaterThan(50);
			expect(harness.maxParams()).toBeLessThanOrEqual(100);
		} finally {
			harness.close();
		}
	});
});

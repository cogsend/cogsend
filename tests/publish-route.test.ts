import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { captureConsole, loggedLines } from './console-spy';
import { encryptJson } from '#lib/server/crypto.js';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { connections, drafts, publishTargets, users } from '#lib/server/db/schema.js';
import { createTestDb, createTestMedia, TEST_ENV } from '#lib/server/db/test.js';
import { POST as publishPOST } from '../src/routes/api/drafts/[id]/publish/+server';

describe('POST /api/drafts/[id]/publish guard', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;
	let draftId: string;
	let connDone: string;
	let connStale: string;
	const media = createTestMedia();

	const localsFor = () => ({
		db,
		env: TEST_ENV,
		media,
		user: {
			id: userId,
			email: 'guard@localhost',
			timezone: 'UTC',
			totpEnabled: true,
			mfaVerified: true
		}
	});

	function post(connectionIds: string[]) {
		return publishPOST({
			params: { id: draftId },
			request: new Request('http://localhost/api/drafts/x/publish', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ connectionIds })
			}),
			locals: localsFor()
		} as never) as Promise<Response>;
	}

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'guard@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
		draftId = newId();
		await db.insert(drafts).values({
			id: draftId,
			userId,
			baseBody: 'guard probe',
			status: 'partial',
			createdAt: now,
			updatedAt: now
		});
		connDone = newId();
		await db.insert(connections).values({
			id: connDone,
			userId,
			platform: 'mastodon',
			handle: 'done@mastodon.test',
			instanceUrl: 'https://mastodon.test',
			credentialsEncrypted: await encryptJson(
				{ accessToken: 'token', instanceUrl: 'https://mastodon.test' },
				TEST_ENV.APP_ENCRYPTION_KEY
			),
			metaJson: JSON.stringify({ maxCharacters: 500 }),
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
		connStale = newId();
		await db.insert(connections).values({
			id: connStale,
			userId,
			platform: 'x',
			handle: '@stale',
			credentialsEncrypted: await encryptJson(
				{ accessToken: 'dead', expiresAt: Date.now() - 60_000 },
				TEST_ENV.APP_ENCRYPTION_KEY
			),
			metaJson: JSON.stringify({ maxCharacters: 280 }),
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
		await db.insert(publishTargets).values([
			{
				id: newId(),
				draftId,
				connectionId: connDone,
				status: 'published',
				remotePostId: 'posted-1',
				remoteUrl: 'https://mastodon.test/@u/1',
				attemptCount: 1,
				createdAt: now,
				updatedAt: now
			},
			{
				id: newId(),
				draftId,
				connectionId: connStale,
				status: 'failed',
				errorMessage: 'boom',
				attemptCount: 1,
				createdAt: now,
				updatedAt: now
			}
		]);
	});

	afterAll(() => close());

	it('lets a partial re-draft through: published skips, failed retries', async () => {
		const res = await post([connDone, connStale]);
		expect(res.status).toBe(200);
		const body = await res.json();
		const rows = body.results as Array<{ connectionId: string; status: string; error?: string }>;
		const byConn = new Map(rows.map((r) => [r.connectionId, r]));
		expect(byConn.get(connDone)).toMatchObject({ status: 'published', skipped: true });
		const staleResult = byConn.get(connStale);
		expect(staleResult).toMatchObject({ status: 'failed' });
		expect(String(staleResult?.error)).toMatch(/reconnect/);
		const [stale] = await db
			.select()
			.from(publishTargets)
			.where(eq(publishTargets.connectionId, connStale));
		expect(stale?.attemptCount).toBe(1);
	});

	it('stops the batch on an infrastructure failure and reports what published', async () => {
		const logged = captureConsole();
		// Two connections publishing in one request; the database fails after the
		// first post is out. D1's per-invocation budget is the real cause on
		// Workers Free, and the next target would fail identically — so the
		// answer is the partial result, not a 500 that hides the post that went
		// out and makes the caller think nothing did.
		const now = new Date();
		const batchDraft = newId();
		await db.insert(drafts).values({
			id: batchDraft,
			userId,
			baseBody: 'batch probe',
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
		const connSecond = newId();
		await db.insert(connections).values({
			id: connSecond,
			userId,
			platform: 'mastodon',
			handle: 'second@mastodon.test',
			instanceUrl: 'https://mastodon.test',
			credentialsEncrypted: await encryptJson(
				{ accessToken: 'token', instanceUrl: 'https://mastodon.test' },
				TEST_ENV.APP_ENCRYPTION_KEY
			),
			metaJson: JSON.stringify({ maxCharacters: 500 }),
			status: 'active',
			createdAt: now,
			updatedAt: now
		});

		// The first refreshDraftStatus (which runs after a publish succeeds) is
		// where this fake database dies — i.e. after the first post is out.
		let refreshes = 0;
		const failingDb = new Proxy(db as unknown as object, {
			get(target, prop) {
				// `this` has to stay the real database: drizzle's query builder
				// reads its session off `this`, and proxying it changes behaviour.
				if (prop !== 'run') return Reflect.get(target, prop, target);
				return (...args: unknown[]) => {
					const sql = JSON.stringify(args[0] ?? '');
					if (sql.includes('UPDATE drafts SET status')) {
						refreshes += 1;
						if (refreshes > 1) throw new Error('D1_ERROR: too many statements');
					}
					return (db as unknown as { run: (...a: unknown[]) => unknown }).run(...args);
				};
			}
		}) as unknown as AppDb;

		const res = (await publishPOST({
			params: { id: batchDraft },
			request: new Request('http://localhost/api/drafts/x/publish', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ connectionIds: [connDone, connSecond] })
			}),
			locals: { ...localsFor(), db: failingDb }
		} as never)) as Response;
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			results: Array<{ connectionId: string; status: string }>;
			stopped?: boolean;
			stoppedError?: string;
		};
		expect(body.stopped).toBe(true);
		expect(body.stoppedError).toBeTruthy();
		// Exactly one destination is accounted for — which one depends on the
		// order the targets come back in — and the other was not attempted, so
		// it is still sitting there for a retry.
		expect(body.results).toHaveLength(1);
		const rows = await db
			.select()
			.from(publishTargets)
			.where(eq(publishTargets.draftId, batchDraft));
		expect(rows).toHaveLength(2);
		// Nothing is left wedged mid-publish, and every target is either done or
		// still due — which is what makes a retry safe after a stopped batch.
		expect(rows.some((r) => r.status === 'publishing')).toBe(false);
		expect(rows.every((r) => ['published', 'scheduled', 'pending'].includes(r.status))).toBe(true);
		// The reason the batch stopped is in the log, for the operator.
		expect(loggedLines(logged).join('\n')).toContain('[publish] aborted');
	});

	it('returns 409 while a requested connection is publishing', async () => {
		const now = new Date();
		const liveDraft = newId();
		await db.insert(drafts).values({
			id: liveDraft,
			userId,
			baseBody: 'live probe',
			status: 'scheduled',
			createdAt: now,
			updatedAt: now
		});
		await db.insert(publishTargets).values({
			id: newId(),
			draftId: liveDraft,
			connectionId: connDone,
			status: 'publishing',
			attemptCount: 1,
			createdAt: now,
			updatedAt: now
		});
		const res = (await publishPOST({
			params: { id: liveDraft },
			request: new Request('http://localhost/api/drafts/x/publish', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ connectionIds: [connDone] })
			}),
			locals: localsFor()
		} as never)) as Response;
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ error: 'Already publishing' });
	});
});

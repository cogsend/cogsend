import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { newId, type AppDb } from '$lib/server/db/client';
import { connections, drafts, publishTargets, users } from '$lib/server/db/schema';
import { encryptJson } from '$lib/server/crypto';
import { createTestDb, createTestMedia, TEST_ENV } from '$lib/server/db/test';
import { writeHeartbeat } from '$lib/server/scheduler';
import { POST as tickPOST } from '../src/routes/api/internal/tick/+server';
import { GET as healthGET } from '../src/routes/api/health/+server';
import { GET as schedulerHealthGET } from '../src/routes/api/scheduler/health/+server';

/**
 * The three endpoints a self-hoster wires up: the tick a cron calls, the health
 * probe, and the scheduler status the dashboard reads. The tick is the whole
 * reason posts get published, and it had no test of its own.
 */
describe('scheduler routes', () => {
	let db: AppDb;
	let close: () => void;
	let accountId: string;
	let draftId: string;
	let targetId: string;

	const env = { ...TEST_ENV, SCHEDULER_SECRET: 'scheduler-secret-at-least-32-chars' };
	const sessionUser = {
		id: '',
		email: 'scheduler@localhost',
		timezone: 'UTC',
		totpEnabled: true,
		mfaVerified: true
	};

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		const userId = newId();
		sessionUser.id = userId;
		await db.insert(users).values({
			id: userId,
			email: 'scheduler@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
		accountId = newId();
		await db.insert(connections).values({
			id: accountId,
			userId,
			platform: 'bluesky',
			handle: 'tick.bsky.social',
			credentialsEncrypted: await encryptJson(
				{
					handle: 'tick.bsky.social',
					appPassword: 'xxxx',
					did: 'did:plc:tick',
					pdsHost: 'https://bsky.social'
				},
				TEST_ENV.APP_ENCRYPTION_KEY
			),
			metaJson: JSON.stringify({ did: 'did:plc:tick' }),
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
		draftId = newId();
		await db.insert(drafts).values({
			id: draftId,
			userId,
			baseBody: 'due now',
			status: 'scheduled',
			createdAt: now,
			updatedAt: now
		});
		targetId = newId();
		await db.insert(publishTargets).values({
			id: targetId,
			draftId,
			connectionId: accountId,
			status: 'scheduled',
			scheduledFor: new Date(now.getTime() - 60_000),
			attemptCount: 0,
			createdAt: now,
			updatedAt: now
		});
	});
	afterAll(() => close());

	const tick = (authorization?: string) =>
		tickPOST({
			request: new Request('http://localhost/api/internal/tick', {
				method: 'POST',
				headers: authorization ? { Authorization: authorization } : {}
			}),
			locals: { db, env, media: createTestMedia(), queue: null },
			platform: undefined
		} as never) as Promise<Response>;

	it('refuses a tick without the scheduler secret', async () => {
		const missing = await tick();
		expect(missing.status).toBe(401);
		const wrong = await tick('Bearer not-the-secret');
		expect(wrong.status).toBe(401);
	});

	it('runs the due targets and reports what it did', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: unknown) => {
				const url = String(input);
				if (url.includes('createSession')) {
					return Response.json({
						accessJwt: 'a',
						refreshJwt: 'r',
						did: 'did:plc:tick',
						handle: 'tick.bsky.social'
					});
				}
				if (url.includes('createRecord')) {
					return Response.json({ uri: 'at://did:plc:tick/app.bsky.feed.post/1', cid: 'c' });
				}
				return new Response('unmocked', { status: 404 });
			})
		);
		const res = await tick(`Bearer ${env.SCHEDULER_SECRET}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			processed: number;
			results: Array<{ id: string; status: string }>;
		};
		expect(body.processed).toBeGreaterThan(0);
		expect(body.results.some((r) => r.id === targetId && r.status === 'published')).toBe(true);
		vi.unstubAllGlobals();

		const [row] = await db.select().from(publishTargets).where(eq(publishTargets.id, targetId));
		expect(row.status).toBe('published');
		expect(row.remoteUrl ?? row.remotePostId).toBeTruthy();
	});

	it('answers the health probe without authentication', async () => {
		const res = (await healthGET({ locals: { db } } as never)) as Response;
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; account: Record<string, unknown> };
		expect(body.ok).toBe(true);
		// Whether 2FA is enrolled is not for anonymous callers to learn.
		expect(body.account).toEqual({ created: true });
	});

	it('reports scheduler status to a session, and refuses an anonymous call', async () => {
		// Its own heartbeat: without one the endpoint reports "no heartbeat yet",
		// which made this test depend on the tick test above running first.
		await writeHeartbeat(db);
		const ok = (await schedulerHealthGET({
			locals: { db, user: sessionUser, authMethod: 'session' }
		} as never)) as Response;
		expect(ok.status).toBe(200);
		const body = (await ok.json()) as {
			ok: boolean;
			message: string;
			overdue: number;
			neverTicked: boolean;
			lastTickAt: string | null;
		};
		expect(body.ok).toBe(true);
		// The heartbeat was just written, so this is the "ticks are arriving"
		// wording; the idle/delayed wordings are covered in scheduler-status.test.ts.
		expect(body.message).toBe('Scheduled publishing is on time');
		expect(body.neverTicked).toBe(false);
		expect(body.lastTickAt).not.toBe(null);

		const anon = (await schedulerHealthGET({
			locals: { db, user: null }
		} as never)) as Response;
		expect(anon.status).toBe(401);
	});
});

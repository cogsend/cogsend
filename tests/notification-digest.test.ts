import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { createTestDb, createTestMedia, TEST_ENV } from '#lib/server/db/test.js';
import { captureConsole, loggedLines } from './console-spy';
import {
	connections,
	drafts,
	notificationState,
	publishTargets,
	users
} from '#lib/server/db/schema.js';
import { DIGEST_ID, maybeSendFailureDigest, runSchedulerTick } from '#lib/server/scheduler.js';

function captureFetch(status = 200) {
	const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
	const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) });
		return new Response('{}', { status });
	}) as typeof fetch;
	return { calls, impl };
}

describe('failure digest', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;
	let draftId: string;
	let connectionId: string;
	const env = { ...TEST_ENV, RESEND_API_KEY: 're_test', NOTIFY_EMAIL: 'me@example.com' };
	let now = new Date('2026-01-01T08:00:00Z');

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'digest@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
		draftId = newId();
		await db.insert(drafts).values({
			id: draftId,
			userId,
			baseBody: 'digest fixture body',
			status: 'failed',
			createdAt: now,
			updatedAt: now
		});
		connectionId = newId();
		await db.insert(connections).values({
			id: connectionId,
			userId,
			platform: 'mastodon',
			handle: 'me@example.social',
			credentialsEncrypted: 'enc',
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
	});
	afterAll(() => close());

	async function addFailed(updatedAt: Date) {
		// Each failure needs its own draft: one target per (draft, connection).
		const id = newId();
		await db.insert(drafts).values({
			id,
			userId,
			baseBody: 'digest fixture body',
			status: 'failed',
			createdAt: updatedAt,
			updatedAt
		});
		await db.insert(publishTargets).values({
			id: newId(),
			draftId: id,
			connectionId,
			status: 'failed',
			errorMessage: 'Boom',
			attemptCount: 3,
			createdAt: updatedAt,
			updatedAt
		});
	}

	it('no-ops when the provider is not configured', async () => {
		const { calls, impl } = captureFetch();
		const result = await maybeSendFailureDigest(db, TEST_ENV, { now, fetchImpl: impl });
		expect(result).toMatchObject({ sent: false, reason: 'not configured' });
		expect(calls).toHaveLength(0);
	});

	it('claims the window even when the provider fails', async () => {
		await addFailed(now);
		const { calls, impl } = captureFetch(500);
		const failed = await maybeSendFailureDigest(db, env, { now, fetchImpl: impl });
		expect(failed).toMatchObject({ sent: false, failedCount: 1, reason: 'provider 500' });
		expect(calls).toHaveLength(1);

		// The window is claimed: no retry storm on the next tick.
		const again = await maybeSendFailureDigest(db, env, { now, fetchImpl: impl });
		expect(again).toMatchObject({ sent: false, reason: 'throttled' });
		expect(calls).toHaveLength(1);
		const [state] = await db
			.select()
			.from(notificationState)
			.where(eq(notificationState.id, DIGEST_ID));
		expect(state.lastFailureDigestAt?.getTime()).toBe(now.getTime());
	});

	it('sends the digest for failures newer than the last send', async () => {
		now = new Date(now.getTime() + 25 * 60 * 60_000);
		await addFailed(now);
		const { calls, impl } = captureFetch(200);
		const result = await maybeSendFailureDigest(db, env, { now, fetchImpl: impl });
		expect(result).toMatchObject({ sent: true, failedCount: 1 });
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe('https://api.resend.com/emails');
		expect(calls[0].body.to).toEqual(['me@example.com']);
		expect(String(calls[0].body.subject)).toMatch(/1 post failed/);
		const text = String(calls[0].body.text);
		expect(text).toContain('Mastodon');
		expect(text).toContain('Boom');
		expect(text).toContain('/posts?tab=failed');

		// Same window: throttled.
		const throttled = await maybeSendFailureDigest(db, env, { now, fetchImpl: impl });
		expect(throttled).toMatchObject({ sent: false, reason: 'throttled' });
		expect(calls).toHaveLength(1);
	});

	it('ignores retrying and already-reported failures', async () => {
		now = new Date(now.getTime() + 25 * 60 * 60_000);
		// A transient failure parked back on the schedule must not alert.
		await db.insert(publishTargets).values({
			id: newId(),
			draftId,
			connectionId,
			status: 'scheduled',
			errorMessage: 'rate limited',
			scheduledFor: new Date(now.getTime() + 60_000),
			attemptCount: 1,
			createdAt: now,
			updatedAt: now
		});
		const { calls, impl } = captureFetch(200);
		const none = await maybeSendFailureDigest(db, env, { now, fetchImpl: impl });
		expect(none).toMatchObject({ sent: false, reason: 'none' });
		expect(calls).toHaveLength(0);

		await addFailed(now);
		const result = await maybeSendFailureDigest(db, env, { now, fetchImpl: impl });
		expect(result).toMatchObject({ sent: true, failedCount: 1 });
		expect(calls).toHaveLength(1);
	});

	it('escapes draft text and errors in the HTML part', async () => {
		now = new Date(now.getTime() + 25 * 60 * 60_000);
		const id = newId();
		await db.insert(drafts).values({
			id,
			userId,
			baseBody: '<img src=x onerror=alert(1)>',
			status: 'failed',
			createdAt: now,
			updatedAt: now
		});
		await db.insert(publishTargets).values({
			id: newId(),
			draftId: id,
			connectionId,
			status: 'failed',
			errorMessage: '<script>bad()</script>',
			attemptCount: 1,
			createdAt: now,
			updatedAt: now
		});
		const { calls, impl } = captureFetch(200);
		const result = await maybeSendFailureDigest(db, env, { now, fetchImpl: impl });
		expect(result).toMatchObject({ sent: true, failedCount: 1 });
		const html = String(calls[0].body.html);
		expect(html).not.toContain('<img');
		expect(html).not.toContain('<script>');
		expect(html).toContain('&lt;img');
		expect(html).toContain('&lt;script&gt;');
	});

	it('a digest error never fails the tick', async () => {
		// Simulates env configured before the 0014 migration landed.
		const ctx = await createTestDb();
		await ctx.db.run(sql`DROP TABLE notification_state`);
		const logged = captureConsole();
		const result = await runSchedulerTick(ctx.db, env, { store: createTestMedia() });
		expect(result.processed).toBe(0);
		expect(result.digest.reason).toBe('error');
		expect(loggedLines(logged).join('\n')).toContain('[scheduler] failure digest failed');
		ctx.close();
	});
});

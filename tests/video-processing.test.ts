import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { encryptJson } from '#lib/server/crypto.js';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { connections, draftMedia, drafts, publishTargets, users } from '#lib/server/db/schema.js';
import { createTestDb, createTestMedia, TEST_ENV } from '#lib/server/db/test.js';
import {
	isRetryableError,
	publishTarget,
	VIDEO_PROCESSING_DEADLINE_MS
} from '#lib/server/publish.js';
import { mastodonProvider } from '#lib/server/providers/mastodon.js';
import { retryDelivery } from '#lib/server/api/operations.js';
import { SubrequestBudget } from '#lib/server/budget.js';
import { consumePublishJob } from '#lib/server/scheduler.js';
import {
	processingError,
	PROCESSING_MARK,
	PublishPartialError,
	resumedVideoState,
	type PlatformProvider,
	type PublishResume
} from '#lib/server/providers/types.js';
import { buildMp4 } from './mp4-fixture';

type PublishOpts = NonNullable<Parameters<PlatformProvider['publish']>[4]>;
type Step = (content: Parameters<PlatformProvider['publish']>[0], opts: PublishOpts) => unknown;

describe('a video the platform is still processing', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;
	let connId: string;
	const store = createTestMedia();
	const seen: (PublishResume | undefined)[] = [];
	let steps: Step[] = [];

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'video@localhost',
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
			handle: '@me@example.social',
			credentialsEncrypted: await encryptJson(
				{ accessToken: 'tok', instanceUrl: 'https://example.social' },
				TEST_ENV.APP_ENCRYPTION_KEY
			),
			metaJson: '{}',
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
		vi.spyOn(mastodonProvider, 'validate').mockReturnValue([]);
		vi.spyOn(mastodonProvider, 'publish').mockImplementation(
			async (content, _creds, _meta, _fetch, opts) => {
				seen.push(opts?.resume);
				const step = steps.shift();
				if (!step) throw new Error('no step left');
				return (await step(content, opts ?? {})) as never;
			}
		);
	});
	afterEach(() => {
		seen.length = 0;
		steps = [];
	});
	afterAll(() => {
		vi.restoreAllMocks();
		close();
	});

	async function videoPost(body = 'clip') {
		const now = new Date();
		const draftId = newId();
		await db.insert(drafts).values({
			id: draftId,
			userId,
			baseBody: body,
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
		const storageKey = `${newId()}.mp4`;
		const bytes = buildMp4();
		await store.put(storageKey, bytes, 'video/mp4');
		await db.insert(draftMedia).values({
			id: newId(),
			draftId,
			storageKey,
			mime: 'video/mp4',
			size: bytes.length,
			width: 1280,
			height: 720,
			sortOrder: 0,
			segmentIndex: 0,
			createdAt: now
		});
		const targetId = newId();
		await db.insert(publishTargets).values({
			id: targetId,
			draftId,
			connectionId: connId,
			status: 'pending',
			attemptCount: 0,
			createdAt: now,
			updatedAt: now
		});
		return { targetId, storageKey };
	}

	const row = async (id: string) =>
		(await db.select().from(publishTargets).where(eq(publishTargets.id, id)))[0];
	const run = (id: string, at: number) =>
		publishTarget(db, TEST_ENV, store, id, { now: new Date(at) });
	const retry = (id: string) => retryDelivery({ db, env: TEST_ENV, media: store }, userId, id);
	const park =
		(storageKey: string, state: Record<string, unknown>, segment = 0): Step =>
		() => {
			throw processingError('Mastodon', { segment, storageKey, state });
		};
	const done: Step = () => ({ remotePostId: 'p1', remoteUrl: 'https://example.social/@me/1' });

	it('parks the target, then resumes it from where the platform left off', async () => {
		const { targetId, storageKey } = await videoPost();
		const t0 = Date.now();
		steps = [park(storageKey, { mediaId: 'm1' }), done];

		const first = await run(targetId, t0);
		expect(first.status).toBe('scheduled');
		expect(first.error).toContain(PROCESSING_MARK);
		const parked = await row(targetId);
		expect(parked.status).toBe('scheduled');
		expect(parked.attemptCount).toBe(0);
		expect(parked.scheduledFor!.getTime()).toBe(t0 + 30_000);

		// Not due yet: the claim refuses it.
		expect((await run(targetId, t0 + 10_000)).skipped).toBe(true);

		const second = await run(targetId, t0 + 31_000);
		expect(second.status).toBe('published');
		expect(seen[0]).toBeUndefined();
		expect(seen[1]?.pending).toMatchObject({ segment: 0, storageKey, state: { mediaId: 'm1' } });
		expect(seen[1]?.segmentIds).toEqual([]);
		expect(resumedVideoState(seen[1], 0, storageKey)).toEqual({ mediaId: 'm1' });
		expect(resumedVideoState(seen[1], 0, 'another.mp4')).toBeNull();
	});

	it('waits far longer than five attempts without using them up', async () => {
		const { targetId, storageKey } = await videoPost();
		let at = Date.now();
		for (let i = 0; i < 12; i++) {
			steps = [park(storageKey, { n: i })];
			expect((await run(targetId, at)).status).toBe('scheduled');
			at += 60_000;
		}
		expect(seen.at(-1)?.pending?.state).toEqual({ n: 10 });

		// All five attempts are still there once the video is ready.
		const flaky: Step = () => {
			throw new Error('Mastodon returned 503');
		};
		for (let i = 0; i < 4; i++) {
			steps = [flaky];
			expect((await run(targetId, at)).status).toBe('scheduled');
			at = (await row(targetId)).scheduledFor!.getTime() + 1_000;
		}
		steps = [flaky];
		expect((await run(targetId, at)).status).toBe('failed');
	});

	it('does not let a run whose claim went stale write after a newer run parked', async () => {
		const { targetId, storageKey } = await videoPost();
		const t0 = Date.now();
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		steps = [
			async () => {
				await held;
				return done(undefined as never, {});
			},
			park(storageKey, { mediaId: 'm1' })
		];
		const stale = run(targetId, t0);
		await vi.waitFor(() => expect(seen.length).toBe(1));
		// Long after the first run's lease lapsed, a second claims and parks.
		expect((await run(targetId, t0 + 60 * 60_000)).status).toBe('scheduled');
		release();
		await stale;
		const after = await row(targetId);
		expect(after.status).toBe('scheduled');
		expect(after.remotePostId).toBeNull();
	});

	it('gives up after the deadline, and Retry starts the video again', async () => {
		const { targetId, storageKey } = await videoPost();
		const t0 = Date.now();
		steps = [park(storageKey, { n: 1 }), park(storageKey, { n: 2 })];
		await run(targetId, t0);
		const late = await run(targetId, t0 + VIDEO_PROCESSING_DEADLINE_MS + 60_000);
		expect(late.status).toBe('failed');
		expect(late.error).toBe('Mastodon took too long to process the video — Retry starts it again');
		expect(isRetryableError(late.error!)).toBe(false);

		steps = [done];
		expect((await retry(targetId)).status).toBe('published');
		expect(seen.at(-1)).toBeUndefined();
	});

	it('restarts the clock when a different video is parked', async () => {
		const { targetId, storageKey } = await videoPost();
		const t0 = Date.now();
		const nearlyDue = t0 + VIDEO_PROCESSING_DEADLINE_MS - 60_000;
		steps = [
			park(storageKey, { n: 1 }),
			park('swapped.mp4', { n: 2 }),
			park('swapped.mp4', { n: 3 })
		];
		await run(targetId, t0);
		await run(targetId, nearlyDue);
		const later = await run(targetId, nearlyDue + 30 * 60_000);
		expect(later.status).toBe('scheduled');
		expect(seen.at(-1)?.pending?.startedAt).toBe(nearlyDue);
	});

	it('drops the pending video when the publish then fails for good', async () => {
		const { targetId, storageKey } = await videoPost();
		const t0 = Date.now();
		steps = [
			park(storageKey, { mediaId: 'm1' }),
			() => {
				throw new Error('Mastodon takes videos up to 99 MB — this one is 120 MB');
			},
			done
		];
		await run(targetId, t0);
		expect((await run(targetId, t0 + 31_000)).status).toBe('failed');
		expect((await retry(targetId)).status).toBe('published');
		expect(seen[1]?.pending?.state).toEqual({ mediaId: 'm1' });
		expect(seen[2]).toBeUndefined();
	});

	it('keeps the pending video across a passing network failure', async () => {
		const { targetId, storageKey } = await videoPost();
		const t0 = Date.now();
		steps = [
			park(storageKey, { mediaId: 'm1' }),
			() => {
				throw new Error('fetch failed: connection reset');
			},
			done
		];
		await run(targetId, t0);
		expect((await run(targetId, t0 + 31_000)).status).toBe('scheduled');
		const retryAt = (await row(targetId)).scheduledFor!.getTime();
		expect((await run(targetId, retryAt)).status).toBe('published');
		expect(seen[2]?.pending?.state).toEqual({ mediaId: 'm1' });
	});

	it('resumes a thread after the posted segments when a later video parks', async () => {
		const { targetId, storageKey } = await videoPost('first\n---\nsecond');
		const t0 = Date.now();
		steps = [
			async (_content, opts) => {
				await opts.checkpoint?.({ segmentIds: ['s0'] });
				throw new PublishPartialError(`Mastodon ${PROCESSING_MARK}`, {
					segmentIds: ['s0'],
					cause: processingError('Mastodon', { segment: 1, storageKey, state: { mediaId: 'm2' } })
				});
			},
			done
		];
		expect((await run(targetId, t0)).status).toBe('scheduled');
		expect((await run(targetId, t0 + 31_000)).status).toBe('published');
		expect(seen[1]).toMatchObject({
			segmentIds: ['s0'],
			pending: { segment: 1, storageKey, state: { mediaId: 'm2' } }
		});
	});

	it('hands providers a streaming reader and the calls left', async () => {
		const { targetId, storageKey } = await videoPost();
		steps = [
			async (content, opts) => {
				expect(content.media?.[0].bytes).toBeUndefined();
				const size = await opts.mediaReader!.size(storageKey);
				const head = await opts.mediaReader!.getRange(storageKey, 0, 7);
				expect(size).toBe(buildMp4().length);
				expect(new TextDecoder().decode(head!.slice(4, 8))).toBe('ftyp');
				expect(opts.callsLeft!()).toBe(Infinity);
				return done(content, opts);
			}
		];
		expect((await run(targetId, Date.now())).status).toBe('published');
	});

	it('counts the calls left on a manual retry and a queued job, so a long upload can park', async () => {
		const seenLeft: number[] = [];
		const record: Step = (content, opts) => {
			seenLeft.push(opts.callsLeft!());
			return done(content, opts);
		};

		const retried = await videoPost();
		steps = [record];
		const budget = new SubrequestBudget(50);
		const result = await retryDelivery(
			{ db, env: TEST_ENV, media: store, budget },
			userId,
			retried.targetId
		);
		expect(result.status).toBe('published');

		const queued = await videoPost();
		steps = [record];
		const consumed = await consumePublishJob(
			db,
			TEST_ENV,
			store,
			queued.targetId,
			undefined,
			new SubrequestBudget(50)
		);
		expect(consumed.status).toBe('published');

		expect(seenLeft).toHaveLength(2);
		for (const left of seenLeft) expect(left).toBeLessThanOrEqual(50);
	});
});

describe('which video failures retry on their own', () => {
	it('waits on processing and stops on a file the platform will never take', () => {
		expect(isRetryableError(`Threads ${PROCESSING_MARK} — it publishes on its own`)).toBe(true);
		for (const message of [
			'X takes videos up to 2:20 — this one is 3:20. Accounts with X Premium can post longer ones.',
			'X takes videos between 1:3 and 3:1 — this one is 400×1400',
			'X needs H.264 video — this one is HEVC',
			'Threads needs at least 23 frames a second — this one is 15',
			'LinkedIn needs a video of at least 3 seconds',
			"Threads needs the video's index at the start of the file — attach it again"
		]) {
			expect(isRetryableError(message), message).toBe(false);
		}
	});
});

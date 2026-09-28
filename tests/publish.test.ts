import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { decryptJson, encryptJson } from '$lib/server/crypto';
import { newId } from '$lib/server/db/client';
import {
	connections,
	draftMedia,
	drafts,
	publishAttempts,
	publishTargets,
	users
} from '$lib/server/db/schema';
import { LEASE_REFRESH_MS } from '$lib/domain/due-jobs';
import { createTestDb, createTestMedia, TEST_ENV } from '$lib/server/db/test';
import {
	MAX_PUBLISH_ATTEMPTS,
	buildNormalizedPost,
	isRetryableError,
	publishTarget,
	refreshDraftStatus,
	statusAfterFailedPublish
} from '$lib/server/publish';
import type { AppDb } from '$lib/server/db/client';
import { captureConsole, loggedLines } from './console-spy';
import type { FetchLike } from '$lib/server/providers/types';

function mockFetch(
	handlers: Record<string, (req: Request) => Response | Promise<Response>>
): FetchLike {
	return async (input, init) => {
		const url =
			typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		for (const [key, handler] of Object.entries(handlers)) {
			if (url.includes(key)) return handler(new Request(url, init));
		}
		return new Response(`unmocked ${url}`, { status: 404 });
	};
}

describe('publishTarget integration', () => {
	let db: AppDb;
	let close: () => void;
	const store = createTestMedia();
	let userId: string;
	let draftId: string;
	let connBsky: string;
	let connMasto: string;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'test-publish@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
		draftId = newId();
		await db.insert(drafts).values({
			id: draftId,
			userId,
			baseBody: 'Hello from tests',
			title: 'Test draft',
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
		connBsky = newId();
		await db.insert(connections).values({
			id: connBsky,
			userId,
			platform: 'bluesky',
			handle: 'test.bsky.social',
			credentialsEncrypted: await encryptJson(
				{
					handle: 'test.bsky.social',
					appPassword: 'xxxx',
					did: 'did:plc:test',
					pdsHost: 'https://bsky.social'
				},
				TEST_ENV.APP_ENCRYPTION_KEY
			),
			metaJson: JSON.stringify({ did: 'did:plc:test' }),
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
		connMasto = newId();
		await db.insert(connections).values({
			id: connMasto,
			userId,
			platform: 'mastodon',
			handle: 'user@mastodon.test',
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
	});

	afterAll(() => close());

	async function extraDraft(body = 'Hello from tests') {
		const id = newId();
		const now = new Date();
		await db.insert(drafts).values({
			id,
			userId,
			baseBody: body,
			title: 'Test draft',
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
		return id;
	}

	it('sends the same idempotency key on a retry, so the platform can deduplicate', async () => {
		// A lost response on a successful post is the one duplicate the pipeline
		// cannot see: the target is retried, and without a key the platform has no
		// way to know it is the same post. Mastodon deduplicates on this header
		// for an hour; Bluesky takes a caller-chosen record key.
		const targetId = newId();
		const now = new Date();
		const idemDraft = await extraDraft('idempotent probe');
		await db.insert(publishTargets).values({
			id: targetId,
			draftId: idemDraft,
			connectionId: connMasto,
			status: 'pending',
			attemptCount: 0,
			createdAt: now,
			updatedAt: now
		});

		const keys: Array<string | null> = [];
		const session = () =>
			mockFetch({
				'/api/v1/statuses': (req: Request) => {
					keys.push(req.headers.get('Idempotency-Key'));
					return Response.json({ id: 'status-1', url: 'https://mastodon.test/@u/1' });
				}
			});

		// First attempt: the provider call "loses" its response.
		const first = await publishTarget(db, TEST_ENV, store, targetId, {
			now,
			fetchImpl: async (input, init) => {
				const url = typeof input === 'string' ? input : input.toString();
				if (url.includes('/api/v1/statuses')) {
					keys.push(new Request(url, init).headers.get('Idempotency-Key'));
					throw Object.assign(new Error('Provider request timed out'), { status: 504 });
				}
				return new Response('unmocked', { status: 404 });
			}
		});
		expect(first.status).toBe('scheduled'); // retryable
		// Second attempt, past the retry backoff: the platform deduplicates and
		// returns the original status.
		await publishTarget(db, TEST_ENV, store, targetId, {
			now: new Date(Date.now() + 60 * 60_000),
			fetchImpl: session()
		});

		expect(keys).toHaveLength(2);
		expect(keys[0]).toBe(`${targetId}:0`);
		expect(keys[1]).toBe(keys[0]);
	});

	it('keeps the claim warm while a slow provider call is in flight', async () => {
		// A single large upload can outlive STALE_CLAIM_MS. Providers only
		// checkpoint after a segment lands, so nothing else touches the row
		// while the bytes are moving — and an overlapping tick would reclaim it
		// and post again. The claim has to be renewed from inside the call.
		const targetId = newId();
		const now = new Date();
		const slowDraft = await extraDraft('slow upload');
		await db.insert(publishTargets).values({
			id: targetId,
			draftId: slowDraft,
			connectionId: connBsky,
			status: 'pending',
			attemptCount: 0,
			createdAt: now,
			updatedAt: now
		});

		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered = false;
		const fetchImpl = mockFetch({
			'com.atproto.server.createSession': () =>
				Response.json({
					accessJwt: 'a',
					refreshJwt: 'r',
					did: 'did:plc:test',
					handle: 'test.bsky.social'
				}),
			'com.atproto.repo.createRecord': async () => {
				entered = true;
				await gate;
				return Response.json({ uri: 'at://did:plc:test/app.bsky.feed.post/slow', cid: 'cid' });
			}
		});

		// Only the clock and the interval are faked: the database work is real,
		// and the polling below uses real timers.
		vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
		try {
			const started = Date.now();
			const publishing = publishTarget(db, TEST_ENV, store, targetId, {
				now: new Date(started),
				fetchImpl
			});
			while (!entered) await new Promise((r) => setTimeout(r, 5));
			const claimed = await db.select().from(publishTargets).where(eq(publishTargets.id, targetId));
			expect(claimed[0]?.updatedAt.getTime()).toBe(started);

			// Time passes with the upload still running: the heartbeat fires.
			vi.advanceTimersByTime(LEASE_REFRESH_MS + 1_000);
			let renewed = claimed[0]!.updatedAt.getTime();
			for (let i = 0; i < 50 && renewed === started; i++) {
				await new Promise((r) => setTimeout(r, 5));
				const [row] = await db.select().from(publishTargets).where(eq(publishTargets.id, targetId));
				renewed = row!.updatedAt.getTime();
			}
			expect(renewed).toBeGreaterThan(started);

			release();
			await publishing;
		} finally {
			vi.useRealTimers();
		}
	});

	it('treats a published row as published even without an id', async () => {
		// The id is not the signal — status is. A provider that answered 200
		// without one (or a response we could not parse) still published the
		// post, and reposting it because the id is missing would be far worse
		// than a row without a permalink.
		const targetId = newId();
		const now = new Date();
		const publishedDraft = await extraDraft('published elsewhere');
		await db.insert(publishTargets).values({
			id: targetId,
			draftId: publishedDraft,
			connectionId: connBsky,
			status: 'published',
			remotePostId: null,
			remoteUrl: null,
			attemptCount: 1,
			createdAt: now,
			updatedAt: now
		});
		let called = false;
		const result = await publishTarget(db, TEST_ENV, store, targetId, {
			fetchImpl: async () => {
				called = true;
				return new Response('should not be called', { status: 500 });
			}
		});
		expect(result).toMatchObject({ status: 'published', skipped: true });
		expect(result.remotePostId).toBeUndefined();
		expect(called).toBe(false);
	});

	it('records a post the provider accepted without an id', async () => {
		// A 200 whose body has no uri/cid: the post is out, so the row is
		// published and carries no id rather than being marked failed (which
		// would post it again on the next attempt).
		const logged = captureConsole();
		const targetId = newId();
		const now = new Date();
		const idlessDraft = await extraDraft('accepted without an id');
		await db.insert(publishTargets).values({
			id: targetId,
			draftId: idlessDraft,
			connectionId: connBsky,
			status: 'pending',
			attemptCount: 0,
			createdAt: now,
			updatedAt: now
		});
		const result = await publishTarget(db, TEST_ENV, store, targetId, {
			fetchImpl: mockFetch({
				'com.atproto.server.createSession': () =>
					Response.json({
						accessJwt: 'a',
						refreshJwt: 'r',
						did: 'did:plc:test',
						handle: 'test.bsky.social'
					}),
				'com.atproto.repo.createRecord': () => Response.json({})
			})
		});
		expect(result.status).toBe('published');
		expect(result.remotePostId).toBeUndefined();
		// Recorded, and the missing id is logged for the operator.
		expect(loggedLines(logged).join('\n')).toContain(
			'[bluesky] createRecord answered without a record uri/cid'
		);
		const [row] = await db.select().from(publishTargets).where(eq(publishTargets.id, targetId));
		expect(row?.status).toBe('published');
		expect(row?.remotePostId).toBeNull();
	});

	it('publishes to bluesky with mocked HTTP', async () => {
		const targetId = newId();
		const now = new Date();
		await db.insert(publishTargets).values({
			id: targetId,
			draftId,
			connectionId: connBsky,
			status: 'pending',
			attemptCount: 0,
			createdAt: now,
			updatedAt: now
		});
		const result = await publishTarget(db, TEST_ENV, store, targetId, {
			fetchImpl: mockFetch({
				'com.atproto.server.createSession': () =>
					Response.json({
						accessJwt: 'a',
						refreshJwt: 'r',
						did: 'did:plc:test',
						handle: 'test.bsky.social'
					}),
				'com.atproto.repo.createRecord': () =>
					Response.json({ uri: 'at://did:plc:test/app.bsky.feed.post/testid', cid: 'cid' })
			})
		});
		expect(result.status).toBe('published');
		expect(result.remotePostId).toContain('testid');
		const [row] = await db.select().from(publishTargets).where(eq(publishTargets.id, targetId));
		expect(row?.remotePostId).toBeTruthy();
		expect(row?.status).toBe('published');
	});

	it('is idempotent when remote id already exists', async () => {
		const targetId = newId();
		const now = new Date();
		const ownDraft = await extraDraft('already posted');
		await db.insert(publishTargets).values({
			id: targetId,
			draftId: ownDraft,
			connectionId: connBsky,
			status: 'published',
			remotePostId: 'at://already/posted',
			attemptCount: 0,
			createdAt: now,
			updatedAt: now
		});
		let called = false;
		const result = await publishTarget(db, TEST_ENV, store, targetId, {
			fetchImpl: async () => {
				called = true;
				return new Response('should not call', { status: 500 });
			}
		});
		expect(result.skipped).toBe(true);
		expect(result.remotePostId).toBe('at://already/posted');
		expect(called).toBe(false);
	});

	it('resumes from a crash checkpoint instead of re-publishing', async () => {
		// What a Worker abort mid-publish leaves behind: the target still
		// claimed and an attempt whose progress callback recorded the segment
		// that did go live. The stale-claim reclaim must resume, not repost.
		const now = new Date();
		const targetId = newId();
		const ownDraft = await extraDraft('checkpoint probe');
		await db.insert(publishTargets).values({
			id: targetId,
			draftId: ownDraft,
			connectionId: connMasto,
			status: 'publishing',
			attemptCount: 1,
			createdAt: now,
			updatedAt: new Date(now.getTime() - 20 * 60_000)
		});
		await db.insert(publishAttempts).values({
			id: newId(),
			publishTargetId: targetId,
			startedAt: new Date(now.getTime() - 20 * 60_000),
			success: false,
			responseSummary: JSON.stringify({
				segmentIds: ['111'],
				remoteUrl: 'https://mastodon.test/@u/111',
				checkpoint: true
			})
		});
		let called = false;
		const result = await publishTarget(db, TEST_ENV, store, targetId, {
			fetchImpl: async () => {
				called = true;
				return new Response('should not publish again', { status: 500 });
			}
		});
		expect(called).toBe(false);
		expect(result.status).toBe('published');
		expect(result.remotePostId).toBe('111');
		const [row] = await db.select().from(publishTargets).where(eq(publishTargets.id, targetId));
		expect(row?.status).toBe('published');
		expect(row?.remoteUrl).toBe('https://mastodon.test/@u/111');
	});

	it('handles multi-destination partial success', async () => {
		const now = new Date();
		const t1 = newId();
		const t2 = newId();
		const ownDraft = await extraDraft('partial');
		await db.insert(publishTargets).values([
			{
				id: t1,
				draftId: ownDraft,
				connectionId: connBsky,
				status: 'pending',
				attemptCount: 0,
				createdAt: now,
				updatedAt: now
			},
			{
				id: t2,
				draftId: ownDraft,
				connectionId: connMasto,
				status: 'pending',
				attemptCount: 0,
				createdAt: now,
				updatedAt: now
			}
		]);
		const r1 = await publishTarget(db, TEST_ENV, store, t1, {
			fetchImpl: mockFetch({
				'com.atproto.server.createSession': () =>
					Response.json({
						accessJwt: 'a',
						refreshJwt: 'r',
						did: 'did:plc:test',
						handle: 'test.bsky.social'
					}),
				'com.atproto.repo.createRecord': () =>
					Response.json({ uri: 'at://did:plc:test/app.bsky.feed.post/partial', cid: 'c' })
			})
		});
		const r2 = await publishTarget(db, TEST_ENV, store, t2, {
			fetchImpl: mockFetch({
				'/api/v1/statuses': () => new Response('fail', { status: 500 })
			})
		});
		expect(r1.status).toBe('published');
		// A 500 is retryable: the target is rescheduled for automatic retry
		// rather than parked as failed.
		expect(r2.status).toBe('scheduled');
		const [failedRow] = await db.select().from(publishTargets).where(eq(publishTargets.id, t2));
		expect(failedRow?.status).toBe('scheduled');
		expect(failedRow?.scheduledFor?.getTime() ?? 0).toBeGreaterThan(Date.now() + 30_000);
		await refreshDraftStatus(db, ownDraft);
		const [draft] = await db.select().from(drafts).where(eq(drafts.id, ownDraft));
		expect(['partial', 'published', 'failed']).toContain(draft?.status);
	});

	it('retryable failures stay claimable, terminal ones park', () => {
		// Scheduled posts keep retrying, and a manual publish that fails
		// retryably is rescheduled too — the scheduler finishes it without the
		// user clicking Retry.
		expect(statusAfterFailedPublish({ retryable: true, scheduledFor: null })).toBe('scheduled');
		expect(
			statusAfterFailedPublish({
				retryable: true,
				scheduledFor: new Date('2026-08-17T11:00:00Z')
			})
		).toBe('scheduled');
		// Auth/content/policy failures never auto-retry.
		expect(statusAfterFailedPublish({ retryable: false, scheduledFor: null })).toBe('failed');
		expect(statusAfterFailedPublish({ retryable: false })).toBe('failed');
	});

	it('does not claim a scheduled row that was moved into the future', async () => {
		const targetId = newId();
		const now = new Date();
		const ownDraft = await extraDraft('future');
		await db.insert(publishTargets).values({
			id: targetId,
			draftId: ownDraft,
			connectionId: connBsky,
			status: 'scheduled',
			scheduledFor: new Date(now.getTime() + 60 * 60_000),
			attemptCount: 0,
			createdAt: now,
			updatedAt: now
		});
		let called = false;
		const result = await publishTarget(db, TEST_ENV, store, targetId, {
			now,
			fetchImpl: async () => {
				called = true;
				return new Response('no', { status: 500 });
			}
		});
		expect(called).toBe(false);
		expect(result.skipped).toBe(true);
		expect(result.status).toBe('scheduled');
	});

	it('isRetryableError classifies validation vs network', () => {
		expect(isRetryableError('312 graphemes — over by 12')).toBe(false);
		expect(isRetryableError('Segment needs text or media')).toBe(false);
		expect(isRetryableError('fetch failed')).toBe(true);
		expect(isRetryableError('Provider request timed out')).toBe(true);
		expect(isRetryableError('Mastodon status create failed (500)')).toBe(true);
		expect(isRetryableError('401 Unauthorized')).toBe(false);
		expect(isRetryableError('Target not found')).toBe(false);
		expect(isRetryableError('Target cancelled')).toBe(false);
		expect(isRetryableError('Already scheduled — cancel')).toBe(false);
		expect(isRetryableError('Bluesky allows max 1MB per image')).toBe(false);
		expect(isRetryableError('Bluesky allows max 2MB per image')).toBe(false);
		expect(isRetryableError('X allows max 15MB per GIF')).toBe(false);
		expect(isRetryableError('Text exceeds 3000 UTF-8 bytes (3100)')).toBe(false);
		expect(isRetryableError('Mastodon allows max 16MB per image')).toBe(false);
	});

	it('claims so two concurrent publishes only post once', async () => {
		const targetId = newId();
		const now = new Date();
		const ownDraft = await extraDraft('once');
		await db.insert(publishTargets).values({
			id: targetId,
			draftId: ownDraft,
			connectionId: connBsky,
			status: 'pending',
			attemptCount: 0,
			createdAt: now,
			updatedAt: now
		});
		let creates = 0;
		const fetchImpl = mockFetch({
			'com.atproto.server.createSession': () =>
				Response.json({
					accessJwt: 'a',
					refreshJwt: 'r',
					did: 'did:plc:test',
					handle: 'test.bsky.social'
				}),
			'com.atproto.repo.createRecord': async () => {
				creates += 1;
				await new Promise((r) => setTimeout(r, 80));
				return Response.json({ uri: 'at://did:plc:test/app.bsky.feed.post/once', cid: 'cid' });
			}
		});
		const [a, b] = await Promise.all([
			publishTarget(db, TEST_ENV, store, targetId, { fetchImpl }),
			publishTarget(db, TEST_ENV, store, targetId, { fetchImpl })
		]);
		const published = [a, b].filter((r) => r.status === 'published');
		const skipped = [a, b].filter((r) => r.skipped);
		expect(creates).toBe(1);
		expect(published.length).toBe(1);
		expect(skipped.length).toBeGreaterThanOrEqual(1);
	});

	it('gives up after MAX_PUBLISH_ATTEMPTS instead of rescheduling forever', async () => {
		const targetId = newId();
		const now = new Date();
		const ownDraft = await extraDraft('give up');
		await db.insert(publishTargets).values({
			id: targetId,
			draftId: ownDraft,
			connectionId: connMasto,
			status: 'scheduled',
			scheduledFor: new Date(now.getTime() - 60_000),
			attemptCount: MAX_PUBLISH_ATTEMPTS - 1,
			createdAt: now,
			updatedAt: now
		});
		const result = await publishTarget(db, TEST_ENV, store, targetId, {
			now,
			fetchImpl: mockFetch({
				'/api/v1/statuses': () => new Response('rate limited', { status: 429 })
			})
		});
		expect(result.status).toBe('failed');
		const [row] = await db.select().from(publishTargets).where(eq(publishTargets.id, targetId));
		expect(row?.status).toBe('failed');
		expect(row?.jobId).toBeNull();
	});

	it('reclaims stale publishing and publishes once', async () => {
		const targetId = newId();
		const now = new Date();
		const ownDraft = await extraDraft('reclaim');
		await db.insert(publishTargets).values({
			id: targetId,
			draftId: ownDraft,
			connectionId: connBsky,
			status: 'publishing',
			attemptCount: 1,
			createdAt: now,
			updatedAt: new Date(now.getTime() - 16 * 60_000)
		});
		const result = await publishTarget(db, TEST_ENV, store, targetId, {
			now,
			fetchImpl: mockFetch({
				'com.atproto.server.createSession': () =>
					Response.json({
						accessJwt: 'a',
						refreshJwt: 'r',
						did: 'did:plc:test',
						handle: 'test.bsky.social'
					}),
				'com.atproto.repo.createRecord': () =>
					Response.json({ uri: 'at://did:plc:test/app.bsky.feed.post/reclaimed', cid: 'cid' })
			})
		});
		expect(result.status).toBe('published');
		expect(result.remotePostId).toContain('reclaimed');
	});

	it('fences a late success write after a newer claim', async () => {
		const targetId = newId();
		const now = new Date();
		const ownDraft = await extraDraft('fence');
		await db.insert(publishTargets).values({
			id: targetId,
			draftId: ownDraft,
			connectionId: connBsky,
			status: 'pending',
			attemptCount: 0,
			createdAt: now,
			updatedAt: now
		});
		let firstEntered = false;
		let releaseFirst: () => void = () => {};
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let creates = 0;
		const slowFetch = mockFetch({
			'com.atproto.server.createSession': () =>
				Response.json({
					accessJwt: 'a',
					refreshJwt: 'r',
					did: 'did:plc:test',
					handle: 'test.bsky.social'
				}),
			'com.atproto.repo.createRecord': async () => {
				creates += 1;
				firstEntered = true;
				await firstGate;
				return Response.json({ uri: 'at://did:plc:test/app.bsky.feed.post/late', cid: 'cid' });
			}
		});
		const first = publishTarget(db, TEST_ENV, store, targetId, { now, fetchImpl: slowFetch });
		while (!firstEntered) await new Promise((r) => setTimeout(r, 10));
		await db
			.update(publishTargets)
			.set({ updatedAt: new Date(now.getTime() - 16 * 60_000) })
			.where(eq(publishTargets.id, targetId));
		const second = await publishTarget(db, TEST_ENV, store, targetId, {
			now,
			fetchImpl: mockFetch({
				'com.atproto.server.createSession': () =>
					Response.json({
						accessJwt: 'a',
						refreshJwt: 'r',
						did: 'did:plc:test',
						handle: 'test.bsky.social'
					}),
				'com.atproto.repo.createRecord': () => {
					creates += 1;
					return Response.json({ uri: 'at://did:plc:test/app.bsky.feed.post/winner', cid: 'cid' });
				}
			})
		});
		expect(second.status).toBe('published');
		releaseFirst();
		const late = await first;
		expect(late.status).toBe('preempted');
		expect(late.skipped).toBe(true);
		const [row] = await db.select().from(publishTargets).where(eq(publishTargets.id, targetId));
		expect(row?.remotePostId).toContain('winner');
		expect(creates).toBe(2);
	});

	describe('refreshDraftStatus', () => {
		async function statusAfter(
			statuses: Array<{ conn: string; status: string }>,
			body = 'status probe'
		) {
			const id = await extraDraft(body);
			const now = new Date();
			if (statuses.length) {
				await db.insert(publishTargets).values(
					statuses.map((s, i) => ({
						id: newId(),
						draftId: id,
						connectionId: s.conn,
						status: s.status,
						remotePostId: s.status === 'published' ? `remote-${id}-${i}` : null,
						attemptCount: 0,
						createdAt: now,
						updatedAt: now
					}))
				);
			}
			await refreshDraftStatus(db, id);
			const [row] = await db.select().from(drafts).where(eq(drafts.id, id));
			return row?.status;
		}

		it('no targets -> draft', async () => {
			expect(await statusAfter([])).toBe('draft');
		});

		it('all cancelled -> draft', async () => {
			expect(
				await statusAfter([
					{ conn: connBsky, status: 'cancelled' },
					{ conn: connMasto, status: 'cancelled' }
				])
			).toBe('draft');
		});

		it('pending or publishing only -> scheduled', async () => {
			expect(await statusAfter([{ conn: connBsky, status: 'pending' }])).toBe('scheduled');
			expect(await statusAfter([{ conn: connBsky, status: 'publishing' }])).toBe('scheduled');
		});

		it('all active published -> published', async () => {
			expect(await statusAfter([{ conn: connBsky, status: 'published' }])).toBe('published');
			expect(
				await statusAfter([
					{ conn: connBsky, status: 'published' },
					{ conn: connMasto, status: 'cancelled' }
				])
			).toBe('published');
		});

		it('all active failed -> failed', async () => {
			expect(await statusAfter([{ conn: connBsky, status: 'failed' }])).toBe('failed');
			expect(
				await statusAfter([
					{ conn: connBsky, status: 'failed' },
					{ conn: connMasto, status: 'cancelled' }
				])
			).toBe('failed');
		});

		it('mixed published with failed or pending -> partial', async () => {
			expect(
				await statusAfter([
					{ conn: connBsky, status: 'published' },
					{ conn: connMasto, status: 'failed' }
				])
			).toBe('partial');
			expect(
				await statusAfter([
					{ conn: connBsky, status: 'published' },
					{ conn: connMasto, status: 'pending' }
				])
			).toBe('partial');
			expect(
				await statusAfter([
					{ conn: connBsky, status: 'published' },
					{ conn: connMasto, status: 'publishing' }
				])
			).toBe('partial');
		});

		it('failed mixed with a queued sibling -> partial', async () => {
			expect(
				await statusAfter([
					{ conn: connBsky, status: 'failed' },
					{ conn: connMasto, status: 'pending' }
				])
			).toBe('partial');
		});
	});
});

describe('buildNormalizedPost per-segment media', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		userId = newId();
		const now = new Date();
		await db.insert(users).values({
			id: userId,
			email: 'test-media-norm@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
	});

	afterAll(() => close());

	it('maps media by original segmentIndex including image-only middle card', async () => {
		const now = new Date();
		const draftId = newId();
		await db.insert(drafts).values({
			id: draftId,
			userId,
			baseBody: 'first text\n---\n\n---\nthird text',
			title: 'media index test',
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
		const key0 = `test-seg0-${Date.now()}.png`;
		const key1 = `test-seg1-${Date.now()}.png`;
		const key2 = `test-seg2-${Date.now()}.png`;
		await db.insert(draftMedia).values([
			{
				id: newId(),
				draftId,
				storageKey: key0,
				mime: 'image/png',
				size: 80,
				segmentIndex: 0,
				sortOrder: 0,
				createdAt: now
			},
			{
				id: newId(),
				draftId,
				storageKey: key1,
				mime: 'image/png',
				size: 80,
				segmentIndex: 1,
				sortOrder: 0,
				altText: 'middle-only',
				createdAt: now
			},
			{
				id: newId(),
				draftId,
				storageKey: key2,
				mime: 'image/png',
				size: 80,
				segmentIndex: 2,
				sortOrder: 0,
				createdAt: now
			}
		]);
		const post = await buildNormalizedPost(db, draftId, 'bluesky');
		expect(post.thread).toBeDefined();
		expect(post.thread!.length).toBe(3);
		expect(post.thread![0].text).toBe('first text');
		expect(post.thread![0].media?.[0].storageKey).toBe(key0);
		expect(post.thread![1].text).toBe('');
		expect(post.thread![1].media?.[0].storageKey).toBe(key1);
		expect(post.thread![1].media?.[0].alt).toBe('middle-only');
		expect(post.thread![2].text).toBe('third text');
		expect(post.thread![2].media?.[0].storageKey).toBe(key2);
		expect(post.thread![2].media?.[0].storageKey).not.toBe(key1);
	});

	it('single image-only segment publishes as media without thread', async () => {
		const now = new Date();
		const draftId = newId();
		const key = `test-only-${Date.now()}.png`;
		await db.insert(drafts).values({
			id: draftId,
			userId,
			baseBody: '',
			title: 'image only',
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
		await db.insert(draftMedia).values({
			id: newId(),
			draftId,
			storageKey: key,
			mime: 'image/png',
			size: 80,
			segmentIndex: 0,
			sortOrder: 0,
			createdAt: now
		});
		const post = await buildNormalizedPost(db, draftId, 'mastodon');
		expect(post.thread).toBeUndefined();
		expect(post.text).toBe('');
		expect(post.media?.length).toBe(1);
		expect(post.media![0].storageKey).toBe(key);
	});
});

describe('retry backoff', () => {
	it('backs off past-due scheduled failures instead of immediate retry', async () => {
		const { db, close } = await createTestDb();
		try {
			const now = new Date();
			const userId = newId();
			await db.insert(users).values({
				id: userId,
				email: 'backoff@localhost',
				passwordHash: 'x',
				timezone: 'UTC',
				createdAt: now,
				updatedAt: now
			});
			const dId = newId();
			await db.insert(drafts).values({
				id: dId,
				userId,
				baseBody: 'backoff probe',
				status: 'scheduled',
				createdAt: now,
				updatedAt: now
			});
			const cId = newId();
			await db.insert(connections).values({
				id: cId,
				userId,
				platform: 'bluesky',
				handle: 'test.bsky.social',
				credentialsEncrypted: await encryptJson(
					{
						handle: 'test.bsky.social',
						appPassword: 'xxxx',
						did: 'did:plc:test',
						pdsHost: 'https://bsky.social'
					},
					TEST_ENV.APP_ENCRYPTION_KEY
				),
				metaJson: JSON.stringify({ did: 'did:plc:test' }),
				status: 'active',
				createdAt: now,
				updatedAt: now
			});
			const targetId = newId();
			await db.insert(publishTargets).values({
				id: targetId,
				draftId: dId,
				connectionId: cId,
				status: 'scheduled',
				scheduledFor: new Date(now.getTime() - 60_000),
				attemptCount: 0,
				createdAt: now,
				updatedAt: now
			});
			const fetchImpl = (async (input: unknown) => {
				const url =
					typeof input === 'string'
						? input
						: input instanceof URL
							? input.toString()
							: (input as Request).url;
				if (url.includes('createSession')) {
					return Response.json({
						accessJwt: 'a',
						refreshJwt: 'r',
						did: 'did:plc:test',
						handle: 'test.bsky.social'
					});
				}
				return new Response('rate limited', { status: 429 });
			}) as FetchLike;
			const before = Date.now();
			const result = await publishTarget(db, TEST_ENV, createTestMedia(), targetId, {
				fetchImpl,
				now: new Date(before)
			});
			// Retryable: reported as scheduled so the UI shows "retrying".
			expect(result.status).toBe('scheduled');
			const rows = await db.select().from(publishTargets).where(eq(publishTargets.id, targetId));
			// Retryable + past-due stays scheduled with backoff, not failed.
			expect(rows[0].status).toBe('scheduled');
			const retryAt = rows[0].scheduledFor?.getTime() ?? 0;
			expect(retryAt).toBeGreaterThan(before + 30_000);
			expect(retryAt).toBeLessThanOrEqual(before + 90_000);
		} finally {
			close();
		}
	});

	it('reschedules a manual publish failure instead of parking it', async () => {
		const { db, close } = await createTestDb();
		try {
			const now = new Date();
			const userId = newId();
			await db.insert(users).values({
				id: userId,
				email: 'manual-backoff@localhost',
				passwordHash: 'x',
				timezone: 'UTC',
				createdAt: now,
				updatedAt: now
			});
			const draftId = newId();
			await db.insert(drafts).values({
				id: draftId,
				userId,
				baseBody: 'manual backoff',
				status: 'draft',
				createdAt: now,
				updatedAt: now
			});
			const connId = newId();
			await db.insert(connections).values({
				id: connId,
				userId,
				platform: 'mastodon',
				handle: 'me@masto.test',
				instanceUrl: 'https://masto.test',
				credentialsEncrypted: await encryptJson(
					{ accessToken: 't', instanceUrl: 'https://masto.test' },
					TEST_ENV.APP_ENCRYPTION_KEY
				),
				metaJson: JSON.stringify({ maxCharacters: 500 }),
				status: 'active',
				createdAt: now,
				updatedAt: now
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
			const before = Date.now();
			const result = await publishTarget(db, TEST_ENV, createTestMedia(), targetId, {
				fetchImpl: mockFetch({
					'/api/v1/statuses': () => new Response('rate limited', { status: 429 })
				}),
				now: new Date(before)
			});
			expect(result.status).toBe('scheduled');
			const [row] = await db.select().from(publishTargets).where(eq(publishTargets.id, targetId));
			expect(row.status).toBe('scheduled');
			expect(row.errorMessage).toMatch(/429/);
			const retryAt = row.scheduledFor?.getTime() ?? 0;
			expect(retryAt).toBeGreaterThan(before + 30_000);
			expect(retryAt).toBeLessThanOrEqual(before + 90_000);
			// The draft is claimably scheduled, not terminally failed.
			const [draft] = await db.select().from(drafts).where(eq(drafts.id, draftId));
			expect(draft.status).toBe('scheduled');
		} finally {
			close();
		}
	});

	it('reports the row status when another claim preempted the failure', async () => {
		const { db, close } = await createTestDb();
		try {
			const now = new Date();
			const userId = newId();
			await db.insert(users).values({
				id: userId,
				email: 'preempt@localhost',
				passwordHash: 'x',
				timezone: 'UTC',
				createdAt: now,
				updatedAt: now
			});
			const draftId = newId();
			await db.insert(drafts).values({
				id: draftId,
				userId,
				baseBody: 'preempted',
				status: 'draft',
				createdAt: now,
				updatedAt: now
			});
			const connId = newId();
			await db.insert(connections).values({
				id: connId,
				userId,
				platform: 'mastodon',
				handle: 'me@masto.test',
				instanceUrl: 'https://masto.test',
				credentialsEncrypted: await encryptJson(
					{ accessToken: 't', instanceUrl: 'https://masto.test' },
					TEST_ENV.APP_ENCRYPTION_KEY
				),
				metaJson: JSON.stringify({ maxCharacters: 500 }),
				status: 'active',
				createdAt: now,
				updatedAt: now
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
			// While this attempt is failing, another claim publishes the row.
			// markFailed's conditional UPDATE then matches nothing; the result
			// must report `published`, not a local `scheduled`.
			const fetchImpl: FetchLike = async (input) => {
				const url =
					typeof input === 'string'
						? input
						: input instanceof URL
							? input.toString()
							: (input as Request).url;
				if (url.includes('/api/v1/statuses')) {
					await db
						.update(publishTargets)
						.set({
							status: 'published',
							remotePostId: 'other-post',
							attemptCount: 2,
							updatedAt: new Date()
						})
						.where(eq(publishTargets.id, targetId));
					return new Response('rate limited', { status: 429 });
				}
				return new Response('unexpected', { status: 500 });
			};
			const result = await publishTarget(db, TEST_ENV, createTestMedia(), targetId, {
				fetchImpl,
				now
			});
			expect(result.status).toBe('published');
		} finally {
			close();
		}
	});
});

describe('publish auth classification', () => {
	let db: AppDb;
	let close: () => void;
	const store = createTestMedia();
	let userId: string;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'test-authz@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
	});

	afterAll(() => close());

	async function mastoConn() {
		const now = new Date();
		const id = newId();
		await db.insert(connections).values({
			id,
			userId,
			platform: 'mastodon',
			handle: 'user@mastodon.test',
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
		return id;
	}

	async function pendingTarget(connectionId: string, body = 'authz probe') {
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
		const targetId = newId();
		await db.insert(publishTargets).values({
			id: targetId,
			draftId,
			connectionId,
			status: 'pending',
			attemptCount: 0,
			createdAt: now,
			updatedAt: now
		});
		return targetId;
	}

	it('a 403 policy refusal fails without expiring the connection', async () => {
		const conn = await mastoConn();
		const targetId = await pendingTarget(conn);
		const result = await publishTarget(db, TEST_ENV, store, targetId, {
			fetchImpl: mockFetch({
				'/api/v1/statuses': () => new Response('policy refusal', { status: 403 })
			})
		});
		expect(result.status).toBe('failed');
		expect(result.error).toMatch(/403/);
		const [row] = await db.select().from(connections).where(eq(connections.id, conn));
		expect(row?.status).toBe('active');
		const [target] = await db.select().from(publishTargets).where(eq(publishTargets.id, targetId));
		expect(target?.status).toBe('failed');
	});

	it('a 401 still expires the connection', async () => {
		const conn = await mastoConn();
		const targetId = await pendingTarget(conn);
		const result = await publishTarget(db, TEST_ENV, store, targetId, {
			fetchImpl: mockFetch({
				'/api/v1/statuses': () => new Response('revoked', { status: 401 })
			})
		});
		expect(result.status).toBe('failed');
		const [row] = await db.select().from(connections).where(eq(connections.id, conn));
		expect(row?.status).toBe('expired');
	});

	it('stale x credentials fail fast without burning an attempt', async () => {
		const now = new Date();
		const conn = newId();
		await db.insert(connections).values({
			id: conn,
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
		const targetId = await pendingTarget(conn, 'stale token probe');
		let fetched = false;
		const failIfCalled: FetchLike = async () => {
			fetched = true;
			return new Response('unreached', { status: 500 });
		};
		const result = await publishTarget(db, TEST_ENV, store, targetId, {
			fetchImpl: failIfCalled
		});
		expect(result.status).toBe('failed');
		expect(result.error).toMatch(/reconnect/);
		expect(fetched).toBe(false);
		const [target] = await db.select().from(publishTargets).where(eq(publishTargets.id, targetId));
		expect(target?.attemptCount).toBe(0);
		const [row] = await db.select().from(connections).where(eq(connections.id, conn));
		expect(row?.status).toBe('expired');
	});

	it('a Threads 400-permission failure expires the connection and stores the full body', async () => {
		const now = new Date();
		const conn = newId();
		await db.insert(connections).values({
			id: conn,
			userId,
			platform: 'threads',
			handle: '@someone',
			credentialsEncrypted: await encryptJson(
				{
					accessToken: 'tok',
					threadsUserId: '123',
					threadsUsername: 'someone',
					expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000
				},
				TEST_ENV.APP_ENCRYPTION_KEY
			),
			metaJson: JSON.stringify({ maxCharacters: 500 }),
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
		const targetId = await pendingTarget(conn, 'hello threads');
		const fullBody = JSON.stringify({
			error: {
				message:
					"Unsupported post request. Object with ID '123' does not exist, cannot be loaded due to missing permissions, or does not support this operation. Padding to push the envelope past the user-facing slice.",
				type: 'OAuthException',
				code: 200,
				error_subcode: 1234567,
				trace_id: 'TRACE-12345'
			}
		});
		expect(fullBody.length).toBeGreaterThan(300);
		const result = await publishTarget(db, TEST_ENV, store, targetId, {
			fetchImpl: mockFetch({
				'/threads': () => new Response(fullBody, { status: 400 })
			})
		});
		expect(result.status).toBe('failed');
		expect(result.error).toMatch(/missing permissions/);
		const [row] = await db.select().from(connections).where(eq(connections.id, conn));
		expect(row?.status).toBe('expired');
		const [target] = await db.select().from(publishTargets).where(eq(publishTargets.id, targetId));
		expect(target?.status).toBe('failed');
		expect(target?.errorMessage).not.toContain('TRACE-12345');
		const attempts = await db
			.select()
			.from(publishAttempts)
			.where(eq(publishAttempts.publishTargetId, targetId));
		expect(attempts).toHaveLength(1);
		const summary = JSON.parse(attempts[0]?.responseSummary ?? '{}') as {
			errorDetail?: string;
		};
		expect(summary.errorDetail).toBe(fullBody);
	});

	it('heals a stale Threads user id from /me, persists it, and un-expires the account', async () => {
		const now = new Date();
		const conn = newId();
		await db.insert(connections).values({
			id: conn,
			userId,
			platform: 'threads',
			handle: '@testuser',
			credentialsEncrypted: await encryptJson(
				{
					accessToken: 'tok',
					threadsUserId: '12345678901234560',
					threadsUsername: 'testuser',
					expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000
				},
				TEST_ENV.APP_ENCRYPTION_KEY
			),
			metaJson: JSON.stringify({ threadsUserId: '12345678901234560', maxCharacters: 500 }),
			status: 'expired',
			createdAt: now,
			updatedAt: now
		});
		const targetId = await pendingTarget(conn, 'heal me');
		const result = await publishTarget(db, TEST_ENV, store, targetId, {
			fetchImpl: mockFetch({
				'/me?fields=': () => Response.json({ id: '999', username: 'testuser' }),
				debug_token: () =>
					Response.json({
						data: {
							is_valid: true,
							user_id: '999',
							scopes: ['threads_basic', 'threads_content_publish']
						}
					}),
				'/threads_publish': () => Response.json({ id: 'media-9' }),
				'/threads': () => Response.json({ id: 'c-9' })
			})
		});
		expect(result.status).toBe('published');
		expect(result.remotePostId).toBe('media-9');
		const [row] = await db.select().from(connections).where(eq(connections.id, conn));
		// The healed row is active again (no manual reconnect needed)…
		expect(row?.status).toBe('active');
		// …and the correction is persisted, so the next publish needs no healing.
		const creds = await decryptJson<{ threadsUserId?: string }>(
			row!.credentialsEncrypted,
			TEST_ENV.APP_ENCRYPTION_KEY
		);
		expect(creds.threadsUserId).toBe('999');
	});

	describe('through Zernio', () => {
		async function zernioConnection(overrides: Record<string, unknown> = {}) {
			const id = newId();
			const now = new Date();
			await db.insert(connections).values({
				id,
				userId,
				platform: 'x',
				handle: 'acme',
				credentialsEncrypted: await encryptJson(
					{ zernioApiKey: 'zk_1', zernioAccountId: 'acc-1' },
					TEST_ENV.APP_ENCRYPTION_KEY
				),
				metaJson: JSON.stringify({ provider: 'zernio', zernioAccountId: 'acc-1' }),
				status: 'active',
				createdAt: now,
				updatedAt: now,
				...overrides
			});
			return id;
		}

		const target = (connectionId: string) => pendingTarget(connectionId, `zernio ${newId()}`);

		const publishedPost = (postId: string) =>
			Response.json({
				post: {
					_id: postId,
					platforms: [
						{
							platform: 'twitter',
							accountId: 'acc-1',
							status: 'published',
							platformPostId: '555',
							platformPostUrl: 'https://x.com/acme/status/555'
						}
					]
				}
			});

		it('publishes and records the platform permalink', async () => {
			const conn = await zernioConnection();
			const targetId = await target(conn);
			const seen: Request[] = [];
			const fetchImpl = mockFetch({
				'/v1/posts/post-a': () => publishedPost('post-a'),
				'/v1/posts': (req) => {
					seen.push(req);
					return Response.json({ post: { _id: 'post-a', platforms: [] } });
				}
			});
			// The real poll interval is 3 s; the provider is memoised, so the
			// test drives the default and expects the first poll to settle it.
			const result = await publishTarget(db, TEST_ENV, store, targetId, { fetchImpl });
			expect(result.status).toBe('published');
			const row = (
				await db.select().from(publishTargets).where(eq(publishTargets.id, targetId))
			)[0];
			expect(row.remotePostId).toBe('555');
			expect(row.remoteUrl).toBe('https://x.com/acme/status/555');
			expect(seen[0].headers.get('authorization')).toBe('Bearer zk_1');
			expect(seen[0].headers.get('x-request-id')).toBe(`${targetId}-0`);
		});

		it('expires the connection when Zernio reports the token dead', async () => {
			const conn = await zernioConnection();
			const targetId = await target(conn);
			const fetchImpl = mockFetch({
				'/v1/posts/post-b': () =>
					Response.json({
						post: {
							_id: 'post-b',
							platforms: [
								{
									platform: 'twitter',
									accountId: 'acc-1',
									status: 'failed',
									errorCategory: 'auth_expired',
									errorMessage: 'Reconnect the account'
								}
							]
						}
					}),
				'/v1/posts': () => Response.json({ post: { _id: 'post-b', platforms: [] } })
			});
			const result = await publishTarget(db, TEST_ENV, store, targetId, { fetchImpl });
			expect(result.status).toBe('failed');
			expect(result.error).toContain('Reconnect the account');
			const row = (await db.select().from(connections).where(eq(connections.id, conn)))[0];
			expect(row.status).toBe('expired');
		});

		it('a poll that errors after the create keeps the post, so the retry polls instead of posting twice', async () => {
			// Found live: a Threads thread outlived the poll window, one status read
			// timed out, and the retry created a second post that Zernio refused as
			// a duplicate, while the first one went live.
			const conn = await zernioConnection();
			const targetId = await target(conn);
			const creates: Request[] = [];
			const create = (req: Request) => {
				creates.push(req);
				return Response.json({ post: { _id: 'post-slow', platforms: [] } });
			};
			const timeout: FetchLike = async (input, init) => {
				const url = String(input instanceof Request ? input.url : input);
				if (url.includes('/v1/posts/post-slow')) {
					throw Object.assign(new Error('Provider request timed out'), { status: 504 });
				}
				return mockFetch({ '/v1/posts': create })(input, init);
			};
			const first = await publishTarget(db, TEST_ENV, store, targetId, { fetchImpl: timeout });
			expect(first.status).toBe('scheduled');
			expect(creates).toHaveLength(1);

			const second = await publishTarget(db, TEST_ENV, store, targetId, {
				fetchImpl: mockFetch({
					'/v1/posts/post-slow': () => publishedPost('post-slow'),
					'/v1/posts': create
				}),
				now: new Date(Date.now() + 5 * 60_000)
			});
			expect(second.status).toBe('published');
			expect(creates).toHaveLength(1);
		});

		it('a resume that finds Zernio failed lets the next attempt create a fresh post', async () => {
			const conn = await zernioConnection();
			const targetId = await target(conn);
			// What a poll timeout leaves behind: an attempt whose checkpoint names
			// the Zernio post, so the next attempt resumes by polling it.
			await db.insert(publishAttempts).values({
				id: newId(),
				publishTargetId: targetId,
				startedAt: new Date(Date.now() - 60_000),
				finishedAt: new Date(Date.now() - 30_000),
				success: false,
				error: 'Zernio is still publishing this post',
				responseSummary: JSON.stringify({ segmentIds: ['post-dead'], remoteUrl: null })
			});
			const creates: Request[] = [];
			const dead = mockFetch({
				'/v1/posts/post-dead': () =>
					Response.json({
						post: {
							_id: 'post-dead',
							platforms: [
								{
									platform: 'twitter',
									accountId: 'acc-1',
									status: 'failed',
									errorCategory: 'platform_error',
									errorMessage: 'X is down'
								}
							]
						}
					}),
				'/v1/posts': (req) => {
					creates.push(req);
					return Response.json({ post: { _id: 'post-fresh', platforms: [] } });
				}
			});
			const first = await publishTarget(db, TEST_ENV, store, targetId, { fetchImpl: dead });
			expect(first.status).toBe('scheduled');
			expect(first.error).toContain('X is down');
			expect(creates).toHaveLength(0);

			const fresh = mockFetch({
				'/v1/posts/post-fresh': () => publishedPost('post-fresh'),
				'/v1/posts/post-dead': () => new Response('must not poll the dead post', { status: 500 }),
				'/v1/posts': (req) => {
					creates.push(req);
					return Response.json({ post: { _id: 'post-fresh', platforms: [] } });
				}
			});
			const second = await publishTarget(db, TEST_ENV, store, targetId, {
				fetchImpl: fresh,
				now: new Date(Date.now() + 5 * 60_000)
			});
			expect(second.status).toBe('published');
			expect(creates).toHaveLength(1);
		});

		it('a rejected key never publishes and expires the connection', async () => {
			const conn = await zernioConnection();
			const targetId = await target(conn);
			const fetchImpl = mockFetch({
				'/v1/posts': () => Response.json({ error: 'Invalid API key' }, { status: 401 })
			});
			const result = await publishTarget(db, TEST_ENV, store, targetId, { fetchImpl });
			expect(result.status).toBe('failed');
			const row = (await db.select().from(connections).where(eq(connections.id, conn)))[0];
			expect(row.status).toBe('expired');
		});
	});
});

describe('posts a platform may have taken, URL-only media and stored links', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;
	const store = createTestMedia();
	const noAnswer = () => {
		throw Object.assign(new Error('Provider request timed out'), { status: 504 });
	};

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'unconfirmed@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
	});
	afterAll(() => close());

	async function connection(platform: string, creds: Record<string, unknown>) {
		const id = newId();
		const now = new Date();
		await db.insert(connections).values({
			id,
			userId,
			platform,
			handle: `@${platform}-user`,
			instanceUrl: platform === 'mastodon' ? 'https://mastodon.test' : null,
			credentialsEncrypted: await encryptJson(creds, TEST_ENV.APP_ENCRYPTION_KEY),
			metaJson: JSON.stringify({ maxCharacters: 500 }),
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
		return id;
	}

	async function pending(connectionId: string, body: string, image = false) {
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
		if (image) {
			await db.insert(draftMedia).values({
				id: newId(),
				draftId,
				storageKey: `${Date.now()}-0123456789abcdef.png`,
				mime: 'image/png',
				size: 80,
				segmentIndex: 0,
				sortOrder: 0,
				createdAt: now
			});
		}
		const id = newId();
		await db.insert(publishTargets).values({
			id,
			draftId,
			connectionId,
			status: 'pending',
			attemptCount: 0,
			createdAt: now,
			updatedAt: now
		});
		return id;
	}

	const row = async (id: string) =>
		(await db.select().from(publishTargets).where(eq(publishTargets.id, id)))[0];

	const xCreds = {
		accessToken: 'tok',
		refreshToken: 'refresh',
		clientId: 'client',
		expiresAt: Date.now() + 2 * 60 * 60_000,
		xUserId: '42',
		xUsername: 'someone'
	};
	const threadsCreds = {
		accessToken: 'tok',
		threadsUserId: '777',
		threadsUsername: 'someone',
		expiresAt: Date.now() + 30 * 24 * 60 * 60_000
	};
	const threadsApi = (publish: () => Response) =>
		mockFetch({
			'/me?fields=': () => Response.json({ id: '777', username: 'someone' }),
			debug_token: () =>
				Response.json({
					data: {
						is_valid: true,
						user_id: '777',
						scopes: ['threads_basic', 'threads_content_publish']
					}
				}),
			'/threads_publish': publish,
			'/threads': () => Response.json({ id: 'container-1' })
		});

	it('an X post that gets no answer fails for good and says it may be live', async () => {
		const conn = await connection('x', xCreds);
		const id = await pending(conn, 'hello from a slow network');
		const result = await publishTarget(db, TEST_ENV, store, id, {
			fetchImpl: mockFetch({ '/2/tweets': noAnswer })
		});
		expect(result.status).toBe('failed');
		const target = await row(id);
		expect(target.status).toBe('failed');
		expect(target.errorMessage).toMatch(/may have been published/);
		expect(target.errorMessage).toMatch(/Check X before you retry/);
		const [account] = await db.select().from(connections).where(eq(connections.id, conn));
		expect(account.status).toBe('active');
	});

	it('a thread that loses the answer for its second X post keeps the first and stops', async () => {
		const conn = await connection('x', xCreds);
		const id = await pending(conn, 'first post\n---\nsecond post');
		let calls = 0;
		const result = await publishTarget(db, TEST_ENV, store, id, {
			fetchImpl: mockFetch({
				'/2/tweets': () => {
					calls += 1;
					if (calls === 1) return Response.json({ data: { id: '100' } }, { status: 201 });
					return noAnswer();
				}
			})
		});
		expect(result.status).toBe('failed');
		const attempts = await db
			.select()
			.from(publishAttempts)
			.where(eq(publishAttempts.publishTargetId, id));
		const summary = JSON.parse(attempts[0]?.responseSummary ?? '{}') as { segmentIds?: string[] };
		expect(summary.segmentIds).toEqual(['100']);
	});

	it('an X post accepted without an id is published, not posted again', async () => {
		const conn = await connection('x', xCreds);
		const id = await pending(conn, 'posted, id lost');
		const result = await publishTarget(db, TEST_ENV, store, id, {
			fetchImpl: mockFetch({ '/2/tweets': () => new Response('not json', { status: 201 }) })
		});
		expect(result.status).toBe('published');
		expect((await row(id)).status).toBe('published');
	});

	it('a Threads publish that gets no answer fails for good', async () => {
		const conn = await connection('threads', threadsCreds);
		const id = await pending(conn, 'hello threads');
		const result = await publishTarget(db, TEST_ENV, store, id, {
			fetchImpl: threadsApi(noAnswer)
		});
		expect(result.status).toBe('failed');
		expect((await row(id)).errorMessage).toMatch(/Threads did not confirm the post/);
	});

	it('publishes a Threads image without reading its bytes from storage', async () => {
		const conn = await connection('threads', threadsCreds);
		const id = await pending(conn, 'with a picture', true);
		const urlOnly = {
			...createTestMedia(),
			get: async () => {
				throw new Error('Threads is sent a URL, never the bytes');
			}
		};
		const result = await publishTarget(db, TEST_ENV, urlOnly, id, {
			fetchImpl: threadsApi(() => Response.json({ id: 'media-1' }))
		});
		expect(result.status).toBe('published');
		expect(result.remotePostId).toBe('media-1');
	});

	it('stores no link when a platform answers with a script URL', async () => {
		const conn = await connection('mastodon', {
			accessToken: 'tok',
			instanceUrl: 'https://mastodon.test'
		});
		const id = await pending(conn, 'hello mastodon');
		const result = await publishTarget(db, TEST_ENV, store, id, {
			fetchImpl: mockFetch({
				'/api/v1/statuses': () => Response.json({ id: 's1', url: 'javascript:alert(1)' })
			})
		});
		expect(result.status).toBe('published');
		const target = await row(id);
		expect(target.remotePostId).toBe('s1');
		expect(target.remoteUrl).toBeNull();
	});

	it('never retries an unconfirmed post on a timer', () => {
		expect(
			isRetryableError(
				'LinkedIn did not confirm the post in time, so it may have been published. Check LinkedIn before you retry.'
			)
		).toBe(false);
		expect(isRetryableError('Provider request timed out')).toBe(true);
	});
});

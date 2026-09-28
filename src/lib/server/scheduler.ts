import {
	and,
	asc,
	count,
	desc,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	lte,
	lt,
	ne,
	notExists,
	or
} from 'drizzle-orm';
import { STALE_CLAIM_MS, selectDueScheduledTargets } from '$lib/domain/due-jobs';
import { draftExcerpt } from '$lib/domain/excerpt';
import { humanizeError } from '$lib/domain/human-error';
import { displayHandle, platformName } from '$lib/domain/platforms';
import { batchQueries, first, newId, type AppDb } from './db/client';
import {
	connections,
	drafts,
	notificationState,
	oauthPending,
	publishTargets,
	schedulerHeartbeats
} from './db/schema';
import type { AppEnv } from './env';
import type { MediaStore } from './media';
import { PUBLISH_RESERVE_CALLS, publishTarget } from './publish';
import type { SubrequestBudget } from './budget';
import { purgeExpiredMfaChallenges } from './totp';
import { purgeExpiredSessions } from './auth';
import { readAppSetting, writeAppSetting } from './app-settings';

export const HEARTBEAT_ID = 'default';
/** GitHub cron is often delayed 15–75 minutes. This is display-only. */
// GitHub throttles the every-minute tick to ~1 run per 2h, so a 2h threshold
// flaps red all day. 6h only fires on a genuinely dead scheduler.
export const HEARTBEAT_STALE_MS = 6 * 60 * 60_000;

export type QueueLike = {
	send(body: { targetId: string }): Promise<unknown>;
};

/** One statement: every tick pays for it out of the same budget it publishes with. */
export async function writeHeartbeat(db: AppDb, at = new Date()) {
	await db
		.insert(schedulerHeartbeats)
		.values({ id: HEARTBEAT_ID, lastOkAt: at })
		.onConflictDoUpdate({ target: schedulerHeartbeats.id, set: { lastOkAt: at } });
}

export interface SchedulerHealth {
	ok: boolean;
	error?: string;
	/** Posts wedged in publishing past the resume window: need a look. */
	stuckPublishing: number;
	/** Due but unprocessed targets (normal when the cron is delayed). */
	overdue: number;
	/** When the scheduler last ran, or null when it has never run. */
	lastTickAt: Date | null;
}

export async function schedulerHealth(db: AppDb, now = new Date()): Promise<SchedulerHealth> {
	const [rows, stuckRows, overdueRows] = (await batchQueries(db, [
		db.select().from(schedulerHeartbeats).where(eq(schedulerHeartbeats.id, HEARTBEAT_ID)),
		db
			.select({ n: count() })
			.from(publishTargets)
			.where(
				and(
					eq(publishTargets.status, 'publishing'),
					isNull(publishTargets.remotePostId),
					lt(publishTargets.updatedAt, new Date(now.getTime() - 2 * STALE_CLAIM_MS))
				)
			),
		db
			.select({ n: count() })
			.from(publishTargets)
			.where(
				and(
					isNull(publishTargets.remotePostId),
					inArray(publishTargets.status, ['scheduled', 'pending']),
					lte(publishTargets.scheduledFor, now)
				)
			)
	])) as [{ lastOkAt: Date }[], { n: unknown }[], { n: unknown }[]];
	const asCount = (value: unknown) => {
		const n = typeof value === 'bigint' ? Number(value) : Number(value);
		return Number.isFinite(n) ? n : 0;
	};
	const stuckPublishing = asCount(stuckRows[0]?.n);
	const overdue = asCount(overdueRows[0]?.n);
	const row = rows[0];
	// `lastTickAt` stays null until the first tick ever. That difference matters
	// to the UI: a fresh instance whose cron was never attached has nothing to
	// wait for, while a long-silent one has a trigger or a pinger to look at.
	if (!row)
		return { ok: false, error: 'No heartbeat yet', lastTickAt: null, stuckPublishing, overdue };
	const age = now.getTime() - row.lastOkAt.getTime();
	if (age > HEARTBEAT_STALE_MS) {
		return {
			ok: false,
			error: `Last tick ${Math.round(age / 1000)}s ago`,
			lastTickAt: row.lastOkAt,
			stuckPublishing,
			overdue
		};
	}
	return { ok: true as const, lastTickAt: row.lastOkAt, stuckPublishing, overdue };
}

export async function expireOauthPending(db: AppDb, now = new Date()) {
	await db.delete(oauthPending).where(lt(oauthPending.expiresAt, now));
}

/**
 * Disconnect leaves a tombstone connection behind only while it still anchors
 * published history. Once the last archived target is gone (its draft was
 * deleted, or it never had published targets), the row is dead weight — drop
 * it so tombstones cannot accumulate.
 */
export async function purgeDisconnectedConnections(db: AppDb) {
	await db
		.delete(connections)
		.where(
			and(
				eq(connections.status, 'disconnected'),
				notExists(
					db
						.select({ id: publishTargets.id })
						.from(publishTargets)
						.where(eq(publishTargets.connectionId, connections.id))
				)
			)
		);
}

/**
 * Due-target scan, bounded: oldest-due first with a LIMIT so one tick never
 * tries to drain an unbounded backlog inside GitHub's 5-minute timeout.
 * Leftovers stay due and run on the next tick. Kept sequential downstream:
 * D1/SQLite serializes writes, so parallel tagging would only contend.
 */
export const TICK_BATCH_LIMIT = 50;

export const DIGEST_ID = 'failure-digest';
/** One failure digest per day; the dashboard banner covers the in-between. */
export const DIGEST_INTERVAL_MS = 24 * 60 * 60_000;
export const DIGEST_MAX_ROWS = 20;

export interface FailureDigestResult {
	sent: boolean;
	failedCount: number;
	reason?: string;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * Morning-after failure digest. Runs on the normal tick; a no-op unless
 * Resend env is configured. Only reports failures newer than the last
 * digest, and claims the 24h window (conditional UPDATE) before sending so
 * overlapping tick callers cannot double-email.
 */
export async function maybeSendFailureDigest(
	db: AppDb,
	env: AppEnv,
	opts: { now?: Date; fetchImpl?: typeof fetch } = {}
): Promise<FailureDigestResult> {
	if (!env.RESEND_API_KEY || !env.NOTIFY_EMAIL) {
		return { sent: false, failedCount: 0, reason: 'not configured' };
	}
	const now = opts.now ?? new Date();
	const state = await first(
		db.select().from(notificationState).where(eq(notificationState.id, DIGEST_ID))
	);
	const last = state?.lastFailureDigestAt ?? null;
	if (last && now.getTime() - last.getTime() < DIGEST_INTERVAL_MS) {
		return { sent: false, failedCount: 0, reason: 'throttled' };
	}
	const cutoff = last ?? new Date(0);
	const failures = await db
		.select({
			targetId: publishTargets.id,
			errorMessage: publishTargets.errorMessage,
			updatedAt: publishTargets.updatedAt,
			platform: connections.platform,
			handle: connections.handle,
			draftTitle: drafts.title,
			baseBody: drafts.baseBody
		})
		.from(publishTargets)
		.innerJoin(drafts, eq(publishTargets.draftId, drafts.id))
		.leftJoin(connections, eq(publishTargets.connectionId, connections.id))
		.where(
			and(
				eq(publishTargets.status, 'failed'),
				isNull(publishTargets.remotePostId),
				gt(publishTargets.updatedAt, cutoff)
			)
		)
		.orderBy(desc(publishTargets.updatedAt))
		.limit(DIGEST_MAX_ROWS + 1);
	if (!failures.length) return { sent: false, failedCount: 0, reason: 'none' };

	if (!state) {
		await db
			.insert(notificationState)
			.values({ id: DIGEST_ID, lastFailureDigestAt: null })
			.onConflictDoNothing();
	}
	const claimed = await db
		.update(notificationState)
		.set({ lastFailureDigestAt: now })
		.where(
			and(
				eq(notificationState.id, DIGEST_ID),
				or(
					isNull(notificationState.lastFailureDigestAt),
					lte(notificationState.lastFailureDigestAt, cutoff)
				)
			)
		)
		.returning({ id: notificationState.id });
	if (!claimed.length) return { sent: false, failedCount: failures.length, reason: 'claimed' };

	const shown = failures.slice(0, DIGEST_MAX_ROWS);
	const extra = failures.length - shown.length;
	const lines = shown.map((f) => {
		const where = [f.platform ? platformName(f.platform) : 'Account', displayHandle(f.handle)]
			.filter(Boolean)
			.join(' · ');
		const body = draftExcerpt(f.baseBody || f.draftTitle || '(no text)', 90);
		return { where, body, error: humanizeError(f.errorMessage) };
	});
	const subject = `CogSend: ${failures.length} post${failures.length === 1 ? '' : 's'} failed to publish`;
	const text = [
		`${failures.length} post${failures.length === 1 ? '' : 's'} failed to publish:`,
		'',
		...lines.map((l) => `- ${l.where} — "${l.body}"\n  ${l.error}`),
		...(extra > 0 ? [`…and ${extra} more.`] : []),
		'',
		`Open Posts: ${env.APP_URL.replace(/\/$/, '')}/posts?tab=failed`
	].join('\n');
	const htmlLines = lines
		.map(
			(l) =>
				`<li><strong>${escapeHtml(l.where)}</strong><br>“${escapeHtml(l.body)}”<br><span style="color:#b91c1c">${escapeHtml(l.error)}</span></li>`
		)
		.join('');
	const html = `<p>${failures.length} post${failures.length === 1 ? '' : 's'} failed to publish:</p><ul>${htmlLines}</ul>${
		extra > 0 ? `<p>…and ${extra} more.</p>` : ''
	}<p><a href="${env.APP_URL.replace(/\/$/, '')}/posts?tab=failed">Open Posts</a></p>`;

	const send = opts.fetchImpl ?? fetch;
	try {
		const res = await send('https://api.resend.com/emails', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${env.RESEND_API_KEY}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				from: env.NOTIFY_FROM || 'CogSend <onboarding@resend.dev>',
				to: [env.NOTIFY_EMAIL],
				subject,
				text,
				html
			})
		});
		if (!res.ok) {
			// The window is claimed: a provider outage loses at most one digest
			// instead of retrying every tick. Failures stay visible in the app.
			return { sent: false, failedCount: failures.length, reason: `provider ${res.status}` };
		}
	} catch (err) {
		return {
			sent: false,
			failedCount: failures.length,
			reason: err instanceof Error ? err.message : 'send failed'
		};
	}
	return { sent: true, failedCount: failures.length };
}

/**
 * Recover rows a dead consumer left in `publishing`.
 *
 * Nothing can pick such a row up in that state: the consumer's own claim only
 * matches while the row *looks* stale, and the hand-off that queues it writes
 * the very timestamp that match depends on. Left alone, the row would keep its
 * `publishing` status and its `jobId` forever, which also makes
 * `draftHasInFlightPublish` true — the draft, its media, a disconnect and
 * Retry/Reschedule would all answer 409 with nothing actually running.
 *
 * Resetting to `pending` puts the row back into the "publish now" shape that
 * both the hand-off and the inline claim understand, and a partially published
 * thread still resumes from its attempt checkpoints.
 */
export async function recoverStalePublishing(db: AppDb, now: Date = new Date()) {
	const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
	await db
		.update(publishTargets)
		.set({ status: 'pending', scheduledFor: null, jobId: null, updatedAt: now })
		.where(
			and(
				eq(publishTargets.status, 'publishing'),
				isNull(publishTargets.remotePostId),
				lte(publishTargets.updatedAt, staleBefore)
			)
		);
}

export async function claimDueTargets(db: AppDb, now = new Date(), limit = TICK_BATCH_LIMIT) {
	const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
	const rows = await db
		.select()
		.from(publishTargets)
		.where(
			and(
				isNull(publishTargets.remotePostId),
				// Only live accounts are claimable. Targets on disconnected
				// tombstones (or rows whose connection vanished) must never
				// be attempted: publishTarget would burn attempts on an
				// account the user has already let go of.
				inArray(
					publishTargets.connectionId,
					db
						.select({ id: connections.id })
						.from(connections)
						.where(ne(connections.status, 'disconnected'))
				),
				or(
					and(
						isNotNull(publishTargets.scheduledFor),
						lte(publishTargets.scheduledFor, now),
						inArray(publishTargets.status, ['scheduled', 'pending'])
					),
					// "Publish now" rows carry no timestamp: the publish and
					// retry paths reset them to pending + NULL right before the
					// inline attempt. If that attempt never ran (evicted
					// isolate, aborted request, spent statement budget) nothing
					// else can reach the row, so treat it as due now.
					and(isNull(publishTargets.scheduledFor), eq(publishTargets.status, 'pending')),
					and(eq(publishTargets.status, 'publishing'), lte(publishTargets.updatedAt, staleBefore))
				)
			)
		)
		.orderBy(asc(publishTargets.scheduledFor))
		.limit(Math.min(500, Math.max(1, Math.floor(limit))));
	return selectDueScheduledTargets(
		rows.map((r) => ({
			id: r.id,
			status: r.status,
			scheduledFor: r.scheduledFor,
			remotePostId: r.remotePostId,
			updatedAt: r.updatedAt
		})),
		now,
		0
	);
}

/** How often the tick clears expired rows. */
export const JANITOR_INTERVAL_MS = 60 * 60_000;
/** When the janitors last finished, in `app_settings` (epoch ms). */
export const JANITOR_SETTING = 'janitor_at';

/**
 * Clear rows nothing will read again: expired connect attempts and MFA
 * challenges, expired sessions, and disconnected accounts with no history left.
 * Each table grows on its own (a challenge per sign-in attempt, a session per
 * device), but none of it is urgent, so this runs hourly rather than every
 * tick: on the Workers Free plan each statement comes out of the 50 calls the
 * tick publishes with. The marker is written after a clean run, so a janitor
 * that fails is tried again on the next tick.
 */
export async function runJanitorsIfDue(db: AppDb, now = new Date()): Promise<boolean> {
	const last = Number(await readAppSetting(db, JANITOR_SETTING));
	// A marker from the future (a skewed clock) must not hold the janitors off.
	const age = now.getTime() - last;
	if (Number.isFinite(last) && age >= 0 && age < JANITOR_INTERVAL_MS) return false;
	await expireOauthPending(db, now);
	await purgeDisconnectedConnections(db);
	await purgeExpiredMfaChallenges(db, now);
	await purgeExpiredSessions(db);
	await writeAppSetting(db, JANITOR_SETTING, String(now.getTime()));
	return true;
}

export async function runSchedulerTick(
	db: AppDb,
	env: AppEnv,
	opts: {
		store: MediaStore;
		queue?: QueueLike | null;
		fetchImpl?: typeof fetch;
		/** This request's subrequest count. Without one, the tick behaves as
		 *  before and works through every due target. */
		budget?: SubrequestBudget | null;
	}
) {
	await writeHeartbeat(db);
	await runJanitorsIfDue(db);
	// Before the scan, so a row a dead consumer left behind is queued (or
	// published inline) by this same tick instead of being scanned and skipped.
	await recoverStalePublishing(db);
	const due = await claimDueTargets(db);
	const results: Array<{ id: string; status: string }> = [];
	const budget = opts.budget ?? null;
	for (const t of due) {
		if (opts.queue) {
			// A hand-off is a write and a queue send. Once the budget cannot
			// cover one more and what the tick still has to do, the rest wait
			// for the next tick.
			if (budget && results.length > 0 && budget.remaining < 2 + PUBLISH_RESERVE_CALLS) break;
			// Hand off without pre-claiming: only tag the row. The consumer's
			// publishTarget performs the real claim (status + attempt bump),
			// so a pre-set 'publishing' can never trap it into a skip.
			// Single-flight: concurrent ticks race here; the loser (jobId
			// already set by a fresh tag) skips the send instead of
			// double-enqueueing. A crashed tag (never sent) becomes
			// re-taggable after STALE_CLAIM_MS via updatedAt.
			const now = new Date();
			const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
			const jobId = `sched-${t.id}-${newId()}`;
			const queued = await db
				.update(publishTargets)
				.set({ jobId, updatedAt: now })
				.where(
					and(
						eq(publishTargets.id, t.id),
						isNull(publishTargets.remotePostId),
						inArray(publishTargets.status, ['scheduled', 'pending']),
						or(isNull(publishTargets.jobId), lte(publishTargets.updatedAt, staleBefore))
					)
				)
				.returning({ id: publishTargets.id });
			if (!queued.length) continue;
			try {
				await opts.queue.send({ targetId: t.id });
			} catch (err) {
				// A failed send must not wedge the row behind jobId until
				// STALE_CLAIM_MS: release the tag so the next tick can
				// reclaim it immediately, then propagate for alerting.
				await db
					.update(publishTargets)
					.set({ jobId: null, updatedAt: new Date() })
					.where(and(eq(publishTargets.id, t.id), eq(publishTargets.jobId, jobId)));
				throw err;
			}
			results.push({ id: t.id, status: 'queued' });
			continue;
		}
		try {
			const result = await publishTarget(db, env, opts.store, t.id, {
				fetchImpl: opts.fetchImpl,
				budget,
				// The first one always runs: deferring it would defer it forever.
				mustTry: results.length === 0
			});
			if (result.deferred) {
				// Might not finish inside this request's budget. Still due, so
				// the next tick starts with it; later rows keep their order.
				results.push({ id: t.id, status: 'deferred' });
				break;
			}
			results.push({ id: t.id, status: result.status });
		} catch (err) {
			// Only infrastructure failures reach here: provider failures are
			// handled inside publishTarget. The usual cause on the free plan is
			// the 50-statements-per-invocation limit, and the next target would
			// fail identically — so stop the batch instead of trying every
			// remaining row. Nothing is lost: the untouched rows are still due
			// and the next tick picks them up, and the digest below still runs.
			console.error('[scheduler] publish aborted', t.id, err);
			results.push({ id: t.id, status: 'error' });
			break;
		}
	}
	// After the publish pass so failures from this tick are included. No-op
	// unless the digest env is configured.
	// Never let alerting break the publish path (e.g. env configured before
	// the 0014 migration landed): a digest error is logged, not thrown.
	let digest: FailureDigestResult = { sent: false, failedCount: 0, reason: 'error' };
	try {
		digest = await maybeSendFailureDigest(db, env, { fetchImpl: opts.fetchImpl });
	} catch (err) {
		console.error('[scheduler] failure digest failed', err);
	}
	const deferred = results.filter((r) => r.status === 'deferred').length;
	return { processed: results.length - deferred, deferred, results, digest };
}

export async function consumePublishJob(
	db: AppDb,
	env: AppEnv,
	store: MediaStore,
	targetId: string,
	fetchImpl?: typeof fetch
) {
	// A retryable failure is not thrown back to the queue. publishTarget has
	// already rescheduled the row with backoff, so an immediate redelivery could
	// never claim it — it would only spend a queue retry. The tick hands the row
	// to the queue again once it is due. Infrastructure errors still throw, and
	// the queue retries those.
	return publishTarget(db, env, store, targetId, { fetchImpl });
}

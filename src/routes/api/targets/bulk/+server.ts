import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { STALE_CLAIM_MS } from '#lib/domain/due-jobs.js';
import {
	connectionIdsOverflow,
	normalizeConnectionIds,
	runAtError
} from '#lib/domain/request-limits.js';
import { chunkIds, first } from '#lib/server/db/client.js';
import { connections, drafts, publishTargets } from '#lib/server/db/schema.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import { PUBLISH_RESERVE_CALLS, publishTarget, refreshDraftStatus } from '#lib/server/publish.js';
import { refuseInFlightOrPublished } from '#lib/server/publish-plan.js';
import { requireScope, requireUser } from '#lib/server/require.js';

type BulkOp = 'cancel' | 'retry' | 'reschedule';

export type BulkItemResult = { id: string; ok: boolean; status?: string; error?: string };

/**
 * One HTTP round trip for a multi-platform card: a 4-platform action costs a
 * single request rather than N fetches plus a list reload. Cancel/reschedule
 * apply set-based UPDATEs; retry still publishes sequentially per target,
 * because that is what the providers require. The single-id routes stay for API
 * compatibility, and mirror these semantics exactly.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		const body = await request.json().catch(() => ({}));
		const op = body.op as BulkOp;
		if (op !== 'cancel' && op !== 'retry' && op !== 'reschedule') {
			return fail('op must be cancel, retry, or reschedule', 400);
		}
		if (connectionIdsOverflow(body.ids)) return fail('Too many targets (max 10)', 400);
		const ids = normalizeConnectionIds(body.ids);
		if (!ids.length) return fail('ids required', 400);
		const now = new Date();
		let runAt: Date | null = null;
		if (op === 'reschedule') {
			const problem = runAtError(body.runAt, now);
			if (problem) return fail(problem, 400);
			runAt = new Date(body.runAt);
		}

		// Ownership: targets join drafts in-memory (same pattern as /api/queue —
		// both tables share column names so no SQL join). Unknown or foreign
		// ids report Not found without distinguishing the two.
		const found: (typeof publishTargets.$inferSelect)[] = [];
		for (const chunk of chunkIds(ids)) {
			found.push(
				...(await locals.db.select().from(publishTargets).where(inArray(publishTargets.id, chunk)))
			);
		}
		const byId = new Map(found.map((t) => [t.id, t]));
		const draftIds = [...new Set(found.map((t) => t.draftId))];
		const ownedDraftIds = new Set<string>();
		for (const chunk of chunkIds(draftIds)) {
			if (!chunk.length) break;
			const rows = await locals.db.select().from(drafts).where(inArray(drafts.id, chunk));
			for (const d of rows) if (d.userId === user.id) ownedDraftIds.add(d.id);
		}

		const results: BulkItemResult[] = [];
		const touchedDrafts = new Set<string>();
		// Retry needs connection liveness per target; batch the lookup once.
		let connById = new Map<string, { userId: string; status: string }>();
		if (op === 'retry' || op === 'reschedule') {
			const connIds = [...new Set(found.map((t) => t.connectionId))];
			const rows: { id: string; userId: string; status: string }[] = [];
			for (const chunk of chunkIds(connIds)) {
				if (!chunk.length) break;
				rows.push(
					...(await locals.db
						.select({ id: connections.id, userId: connections.userId, status: connections.status })
						.from(connections)
						.where(inArray(connections.id, chunk)))
				);
			}
			connById = new Map(rows.map((c) => [c.id, c]));
		}

		const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
		// Retries publish inline, one after another, inside this request's call
		// budget (see #lib/server/budget). Once one is left for the scheduler,
		// the rest are only reset to "publish now" and the next tick sends them.
		let retriesStarted = 0;
		let deferring = false;

		for (const id of ids) {
			const target = byId.get(id);
			if (!target || !ownedDraftIds.has(target.draftId)) {
				results.push({ id, ok: false, error: 'Not found' });
				continue;
			}
			if (op === 'cancel') {
				if (target.status === 'published' || target.remotePostId) {
					results.push({ id, ok: false, error: 'Already published' });
					continue;
				}
				if (target.status === 'cancelled') {
					results.push({ id, ok: true, status: 'cancelled' });
					continue;
				}
				const blocked = refuseInFlightOrPublished(target, now);
				if (blocked) {
					results.push({ id, ok: false, error: blocked });
					continue;
				}
				const [updated] = await locals.db
					.update(publishTargets)
					.set({ status: 'cancelled', jobId: null, scheduledFor: null, updatedAt: now })
					.where(
						and(
							eq(publishTargets.id, id),
							or(
								inArray(publishTargets.status, ['pending', 'scheduled', 'failed']),
								and(
									eq(publishTargets.status, 'publishing'),
									lte(publishTargets.updatedAt, staleBefore)
								)
							)
						)
					)
					.returning({ id: publishTargets.id });
				if (!updated) {
					const latest = await first(
						locals.db.select().from(publishTargets).where(eq(publishTargets.id, id))
					);
					if (latest?.status === 'cancelled') results.push({ id, ok: true, status: 'cancelled' });
					else if (latest?.remotePostId || latest?.status === 'published')
						results.push({ id, ok: false, error: 'Already published' });
					else results.push({ id, ok: false, error: 'Already publishing' });
					continue;
				}
				touchedDrafts.add(target.draftId);
				results.push({ id, ok: true, status: 'cancelled' });
			} else if (op === 'reschedule') {
				const blocked = refuseInFlightOrPublished(target, now);
				if (blocked) {
					results.push({ id, ok: false, error: blocked });
					continue;
				}
				if (target.status === 'cancelled') {
					results.push({ id, ok: false, error: 'Cancelled — retry instead' });
					continue;
				}
				const conn = connById.get(target.connectionId);
				if (!conn || conn.userId !== user.id) {
					results.push({ id, ok: false, error: 'Not found' });
					continue;
				}
				if (conn.status !== 'active') {
					results.push({ id, ok: false, error: 'Account needs reconnect' });
					continue;
				}
				const [updated] = await locals.db
					.update(publishTargets)
					.set({
						status: 'scheduled',
						scheduledFor: runAt,
						errorMessage: null,
						jobId: null,
						attemptCount: 0,
						updatedAt: now
					})
					.where(
						and(
							eq(publishTargets.id, id),
							isNull(publishTargets.remotePostId),
							or(
								inArray(publishTargets.status, ['pending', 'scheduled', 'failed']),
								and(
									eq(publishTargets.status, 'publishing'),
									lte(publishTargets.updatedAt, staleBefore)
								)
							)
						)
					)
					.returning({ id: publishTargets.id });
				if (!updated) {
					const latest = await first(
						locals.db.select().from(publishTargets).where(eq(publishTargets.id, id))
					);
					if (latest?.remotePostId) results.push({ id, ok: false, error: 'Already published' });
					else results.push({ id, ok: false, error: 'Already publishing' });
					continue;
				}
				touchedDrafts.add(target.draftId);
				results.push({ id, ok: true, status: 'scheduled' });
			} else {
				// retry: reset then publish inline, exactly like the single route.
				if (target.remotePostId) {
					results.push({ id, ok: true, status: 'published' });
					continue;
				}
				const blocked = refuseInFlightOrPublished(target, now);
				if (blocked) {
					results.push({ id, ok: false, error: blocked });
					continue;
				}
				const conn = connById.get(target.connectionId);
				if (!conn || conn.userId !== user.id) {
					results.push({ id, ok: false, error: 'Not found' });
					continue;
				}
				if (conn.status !== 'active') {
					results.push({ id, ok: false, error: 'Account needs reconnect' });
					continue;
				}
				if (deferring && locals.budget.remaining < 2 + PUBLISH_RESERVE_CALLS) {
					results.push({ id, ok: false, error: 'Too much at once — retry this one again' });
					continue;
				}
				const reset = await locals.db
					.update(publishTargets)
					.set({
						status: 'pending',
						scheduledFor: null,
						errorMessage: null,
						jobId: null,
						attemptCount: 0,
						updatedAt: now
					})
					.where(
						and(
							eq(publishTargets.id, id),
							isNull(publishTargets.remotePostId),
							or(
								inArray(publishTargets.status, ['pending', 'scheduled', 'failed', 'cancelled']),
								and(
									eq(publishTargets.status, 'publishing'),
									lte(publishTargets.updatedAt, staleBefore)
								)
							)
						)
					)
					.returning({ id: publishTargets.id });
				if (!reset.length) {
					const latest = await first(
						locals.db.select().from(publishTargets).where(eq(publishTargets.id, id))
					);
					if (latest?.remotePostId) results.push({ id, ok: true, status: 'published' });
					else results.push({ id, ok: false, error: 'Already publishing' });
					continue;
				}
				touchedDrafts.add(target.draftId);
				if (deferring) {
					results.push({ id, ok: true, status: 'pending' });
					continue;
				}
				// Survive a tab close mid-retry (see the publish route).
				const task = publishTarget(locals.db, locals.env, locals.media, id, {
					now,
					budget: locals.budget,
					mustTry: retriesStarted === 0
				});
				locals.waitUntil(task.then(() => undefined).catch(() => undefined));
				const outcome = await task;
				if (outcome.deferred) {
					deferring = true;
					results.push({ id, ok: true, status: 'pending' });
					continue;
				}
				retriesStarted += 1;
				if (outcome.status === 'failed') {
					results.push({ id, ok: false, error: outcome.error ?? 'Retry failed' });
				} else {
					results.push({ id, ok: true, status: outcome.status });
				}
			}
		}

		for (const draftId of touchedDrafts) {
			await refreshDraftStatus(locals.db, draftId);
		}
		const failed = results.filter((r) => !r.ok);
		return ok({ results, failed });
	} catch (err) {
		return handleError(err);
	}
};

import { and, eq, inArray, isNull, lte, ne, or } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { STALE_CLAIM_MS } from '#lib/domain/due-jobs.js';
import { chunkIds, first } from '#lib/server/db/client.js';
import { connections, publishAttempts, publishTargets } from '#lib/server/db/schema.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import { refreshDraftStatuses } from '#lib/server/publish.js';
import { draftHasInFlightPublish } from '#lib/server/publish-plan.js';
import { requireSession } from '#lib/server/require.js';

export const DELETE: RequestHandler = async ({ params, locals }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		const conn = await first(
			locals.db
				.select()
				.from(connections)
				.where(and(eq(connections.id, params.id), eq(connections.userId, user.id)))
		);
		if (!conn) return fail('Not found', 404);
		// Idempotent: a retried request or a double click sees the finished
		// state, not a 404 or a second round of deletions.
		if (conn.status === 'disconnected') return ok({ ok: true, removed: 0, archived: 0 });

		const now = new Date();
		const targets = await locals.db
			.select()
			.from(publishTargets)
			.where(eq(publishTargets.connectionId, conn.id));
		// A live claim must settle first: deleting its row mid-publish leaves
		// the remote post with no local record.
		if (draftHasInFlightPublish(targets, now)) {
			return fail('Publishing in progress — try again shortly', 409);
		}

		const removable = targets.filter((t) => !t.remotePostId);
		const archived = targets.length - removable.length;
		const affectedDraftIds = [...new Set(removable.map((t) => t.draftId))];

		// Explicit delete instead of relying on ON DELETE CASCADE: scheduled
		// work goes, published history stays, and the outcome does not depend
		// on the best-effort PRAGMA foreign_keys (see db/init-sql.ts).
		// Fresh `publishing` rows are excluded so a claim that raced in after
		// the guard survives — the re-check below turns that into a 409
		// instead of a lost remote post. A jobId row is already caught by the
		// guard; deleting it just prevents a ghost consumer from firing.
		const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
		if (removable.length) {
			await locals.db
				.delete(publishTargets)
				.where(
					and(
						eq(publishTargets.connectionId, conn.id),
						isNull(publishTargets.remotePostId),
						or(ne(publishTargets.status, 'publishing'), lte(publishTargets.updatedAt, staleBefore))
					)
				);
		}
		// Removed targets changed these drafts' target sets: recompute so a
		// draft with nothing left reappears in the Drafts tab instead of
		// lingering with a status that hides it from /posts. Bulk (one
		// statement per chunk): a disconnect can strand hundreds of drafts and
		// D1's Free plan allows only 50 queries per invocation.
		await refreshDraftStatuses(locals.db, affectedDraftIds);

		const remaining = await locals.db
			.select({ id: publishTargets.id })
			.from(publishTargets)
			.where(and(eq(publishTargets.connectionId, conn.id), isNull(publishTargets.remotePostId)));
		// Attempt history hangs off publish_targets. Delete it only for the
		// targets actually removed: a claim that raced in after the snapshot
		// kept its row, and its attempt row carries the resume checkpoint
		// (segmentIds) a partial-thread retry reads, so deleting it would make
		// the retry repost from segment 0. Explicit instead of relying on the
		// best-effort FK cascade, so orphaned attempts cannot linger forever.
		const kept = new Set(remaining.map((t) => t.id));
		for (const chunk of chunkIds(removable.map((t) => t.id).filter((id) => !kept.has(id)))) {
			await locals.db
				.delete(publishAttempts)
				.where(inArray(publishAttempts.publishTargetId, chunk));
		}
		if (remaining.length) {
			// The guard raced a real claim: keep the connection intact and let
			// the user retry once the publish settles.
			return fail('Publishing in progress — try again shortly', 409);
		}

		if (archived > 0) {
			// Credential-free tombstone: archive joins (queue, draft history)
			// keep resolving platform/handle, and reconnecting the same
			// account revives this row with its history attached.
			await locals.db
				.update(connections)
				.set({ status: 'disconnected', credentialsEncrypted: '', updatedAt: now })
				.where(eq(connections.id, conn.id));
		} else {
			// Nothing to archive: drop the row. No targets reference it.
			await locals.db.delete(connections).where(eq(connections.id, conn.id));
		}
		return ok({ ok: true, removed: removable.length, archived });
	} catch (err) {
		return handleError(err);
	}
};

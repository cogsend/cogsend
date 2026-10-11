import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import { STALE_CLAIM_MS, isFreshPublishing } from '#lib/domain/due-jobs.js';
import { newId, type AppDb } from './db/client';
import { draftVariants, publishTargets } from './db/schema';

export type ConnectionRow = {
	id: string;
	platform: string;
	handle: string | null;
	displayName: string | null;
	status: string;
};

export type PublishTargetRow = InferSelectModel<typeof publishTargets>;

export type TargetClass = 'missing' | 'published' | 'inFlight' | 'reusable';

export type EnsuredTarget = {
	target: PublishTargetRow;
	reused: boolean;
	alreadyPublished: boolean;
	inFlight: boolean;
};

const REUSABLE_STATUSES = ['pending', 'scheduled', 'failed', 'cancelled'] as const;

function timeMs(value: Date | string | number | null | undefined): number {
	if (value instanceof Date) return value.getTime();
	if (typeof value === 'number') return value;
	if (typeof value === 'string') {
		const t = new Date(value).getTime();
		return Number.isNaN(t) ? 0 : t;
	}
	return 0;
}

export function isUniqueConstraintError(err: unknown): boolean {
	const parts: string[] = [];
	let current: unknown = err;
	for (let i = 0; i < 4 && current; i++) {
		if (current instanceof Error) {
			parts.push(current.message);
			const extra = current as Error & { code?: string };
			if (extra.code) parts.push(extra.code);
			current = extra.cause;
		} else {
			parts.push(String(current));
			break;
		}
	}
	return /unique constraint failed|SQLITE_CONSTRAINT/i.test(parts.join('\n'));
}

export function pickTargetWinner(rows: PublishTargetRow[]): PublishTargetRow | null {
	if (!rows.length) return null;
	const withRemote = rows.filter((r) => r.remotePostId);
	const pool = withRemote.length ? withRemote : rows;
	return [...pool].sort((a, b) => timeMs(b.updatedAt) - timeMs(a.updatedAt))[0] ?? null;
}

export function classifyWinner(
	winner: PublishTargetRow | null,
	now: Date = new Date()
): TargetClass {
	if (!winner) return 'missing';
	// Status first: a provider that answered 200 without an id still published
	// the post, and classifying that row as reusable would publish it twice.
	if (winner.status === 'published' || winner.remotePostId) return 'published';
	if (isFreshPublishing(winner, now)) return 'inFlight';
	return 'reusable';
}

// Draft-level guard: any target with a live claim (fresh `publishing` or a
// queued jobId) means a publish is in flight right now. Mutating draft
// content underneath it corrupts sibling publishes and partial resume
// (publish re-reads live draft/variant/media rows). Callers return 409.
export function draftHasInFlightPublish(
	targets: Array<{
		status: string;
		updatedAt?: Date | string | number | null;
		remotePostId?: string | null;
		jobId?: string | null;
	}>,
	now: Date = new Date()
): boolean {
	return targets.some((t) => t.jobId || isFreshPublishing(t, now));
}

export function refuseInFlightOrPublished(
	target: {
		status: string;
		updatedAt?: Date | string | number | null;
		remotePostId?: string | null;
	},
	now: Date = new Date()
): string | null {
	if (target.status === 'published' || target.remotePostId) return 'Already published';
	if (isFreshPublishing(target, now)) return 'Already publishing';
	return null;
}

async function loadTargets(db: AppDb, draftId: string, connectionId: string) {
	return db
		.select()
		.from(publishTargets)
		.where(and(eq(publishTargets.draftId, draftId), eq(publishTargets.connectionId, connectionId)));
}

export async function classifyConnections(
	db: AppDb,
	draftId: string,
	conns: ConnectionRow[],
	now: Date = new Date()
): Promise<Array<{ connectionId: string; kind: TargetClass; target: PublishTargetRow | null }>> {
	// One read for the whole draft instead of one per connection: this runs on
	// every publish/schedule request, D1 counts statements, and the free plan
	// only allows 50 per invocation — a ten-account publish must not spend ten
	// of them before it starts publishing.
	const rows = await db.select().from(publishTargets).where(eq(publishTargets.draftId, draftId));
	const byConnection = new Map<string, PublishTargetRow[]>();
	for (const row of rows) {
		const list = byConnection.get(row.connectionId);
		if (list) list.push(row);
		else byConnection.set(row.connectionId, [row]);
	}
	return conns.map((conn) => {
		const winner = pickTargetWinner(byConnection.get(conn.id) ?? []);
		return { connectionId: conn.id, kind: classifyWinner(winner, now), target: winner };
	});
}

function reusableWhere(id: string, now: Date) {
	const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
	return and(
		eq(publishTargets.id, id),
		isNull(publishTargets.remotePostId),
		or(
			inArray(publishTargets.status, [...REUSABLE_STATUSES]),
			and(eq(publishTargets.status, 'publishing'), lte(publishTargets.updatedAt, staleBefore))
		)
	);
}

async function cancelSiblings(db: AppDb, rows: PublishTargetRow[], winnerId: string, now: Date) {
	for (const row of rows) {
		if (row.id === winnerId) continue;
		if (row.remotePostId) continue;
		// Never kill a live claim owned by another isolate. The snapshot check
		// is only a fast path: the atomic CAS below (same predicate as
		// reusableWhere) wins against a concurrent publishTarget claim that
		// lands between loadTargets and this cancel.
		if (isFreshPublishing(row, now)) continue;
		await db
			.update(publishTargets)
			.set({
				status: 'cancelled',
				scheduledFor: null,
				jobId: null,
				updatedAt: now
			})
			.where(reusableWhere(row.id, now));
	}
}

export async function ensureTargets(
	db: AppDb,
	draftId: string,
	conns: ConnectionRow[],
	mode: 'now' | 'schedule',
	runAt: Date | null,
	now: Date = new Date()
): Promise<EnsuredTarget[]> {
	const variants = await db.select().from(draftVariants).where(eq(draftVariants.draftId, draftId));
	// One read for the whole draft instead of one per connection: D1 counts
	// statements, and a ten-account publish should not spend ten of its fifty
	// before it starts.
	const allRows = await db.select().from(publishTargets).where(eq(publishTargets.draftId, draftId));
	const byConnection = new Map<string, PublishTargetRow[]>();
	for (const row of allRows) {
		const list = byConnection.get(row.connectionId);
		if (list) list.push(row);
		else byConnection.set(row.connectionId, [row]);
	}
	const out: EnsuredTarget[] = [];

	for (const conn of conns) {
		let rows = byConnection.get(conn.id) ?? [];
		let winner = pickTargetWinner(rows);
		if (winner) await cancelSiblings(db, rows, winner.id, now);

		const variant = variants.find((v) => v.platform === conn.platform);

		if (!winner) {
			try {
				const [inserted] = await db
					.insert(publishTargets)
					.values({
						id: newId(),
						draftId,
						connectionId: conn.id,
						variantId: variant?.id ?? null,
						status: mode === 'schedule' ? 'scheduled' : 'pending',
						scheduledFor: mode === 'schedule' ? runAt : null,
						attemptCount: 0,
						createdAt: now,
						updatedAt: now
					})
					.returning();
				out.push({ target: inserted, reused: false, alreadyPublished: false, inFlight: false });
				continue;
			} catch (err) {
				if (!isUniqueConstraintError(err)) throw err;
				// Another writer inserted the row between our read and this
				// insert: re-read just this connection and reuse theirs.
				rows = await loadTargets(db, draftId, conn.id);
				winner = pickTargetWinner(rows);
				if (!winner) throw err;
			}
		}

		// Status first, like classifyWinner: a platform that answered without an
		// id still published the post.
		if (winner.status === 'published' || winner.remotePostId) {
			out.push({ target: winner, reused: true, alreadyPublished: true, inFlight: false });
			continue;
		}

		if (isFreshPublishing(winner, now)) {
			out.push({ target: winner, reused: true, alreadyPublished: false, inFlight: true });
			continue;
		}

		const [updated] = await db
			.update(publishTargets)
			.set({
				status: mode === 'schedule' ? 'scheduled' : 'pending',
				scheduledFor: mode === 'schedule' ? runAt : null,
				errorMessage: null,
				// Clear orphaned queue claims so a stale jobId cannot fire a
				// ghost consumer. attemptCount is intentionally preserved here:
				// silent reuse must not mint a fresh retry budget (explicit
				// retry/reschedule routes reset it as fresh user intent).
				jobId: null,
				variantId: variant?.id ?? winner.variantId,
				updatedAt: now
			})
			.where(reusableWhere(winner.id, now))
			.returning();

		if (!updated) {
			const latest =
				(await loadTargets(db, draftId, conn.id)).find((row) => row.id === winner!.id) ?? winner;
			if (latest.status === 'published' || latest.remotePostId) {
				out.push({ target: latest, reused: true, alreadyPublished: true, inFlight: false });
				continue;
			}
			out.push({ target: latest, reused: true, alreadyPublished: false, inFlight: true });
			continue;
		}

		out.push({
			target: updated,
			reused: true,
			alreadyPublished: false,
			inFlight: false
		});
	}

	return out;
}

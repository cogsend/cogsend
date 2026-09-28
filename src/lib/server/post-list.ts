import { and, desc, eq, inArray, sql, type InferSelectModel } from 'drizzle-orm';
import { batchQueries, chunkIds, type AppDb } from './db/client';
import { connections, draftMedia, drafts, publishTargets } from './db/schema';
import { serializeMedia } from './serialize';

export const DRAFTS_LIST_LIMIT = 200;
export const DRAFTS_LIST_MAX_LIMIT = 500;
export const QUEUE_LIST_LIMIT = 100;
export const QUEUE_LIST_MAX_LIMIT = 500;

export function parseListLimit(
	raw: string | null | undefined,
	fallback: number,
	max: number
): number {
	const requested = parseInt(raw ?? '', 10);
	return Number.isFinite(requested) ? Math.min(max, Math.max(1, Math.floor(requested))) : fallback;
}

/**
 * Posts page draft rows. The public list still returns every variant; this
 * one is the card: body, status, accounts, and the few media fields the grid
 * renders. Search and thread length keep the full body.
 */
export async function loadDraftSummaries(db: AppDb, userId: string, limit = DRAFTS_LIST_LIMIT) {
	const rows = await db
		.select({
			id: drafts.id,
			title: drafts.title,
			baseBody: drafts.baseBody,
			status: drafts.status,
			updatedAt: drafts.updatedAt
		})
		.from(drafts)
		.where(eq(drafts.userId, userId))
		.orderBy(desc(drafts.updatedAt))
		.limit(limit + 1);
	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;
	const ids = page.map((d) => d.id);
	type MediaRow = {
		id: string;
		draftId: string;
		storageKey: string;
		mime: string;
		altText: string | null;
		sortOrder: number;
		segmentIndex: number;
	};
	type TargetRow = {
		draftId: string;
		status: string;
		remoteUrl: string | null;
		connectionId: string;
	};
	const allMedia: MediaRow[] = [];
	const allTargets: TargetRow[] = [];
	for (const chunk of chunkIds(ids)) {
		const [media, targets] = (await batchQueries(db, [
			db
				.select({
					id: draftMedia.id,
					draftId: draftMedia.draftId,
					storageKey: draftMedia.storageKey,
					mime: draftMedia.mime,
					altText: draftMedia.altText,
					sortOrder: draftMedia.sortOrder,
					segmentIndex: draftMedia.segmentIndex
				})
				.from(draftMedia)
				.where(inArray(draftMedia.draftId, chunk)),
			db
				.select({
					draftId: publishTargets.draftId,
					status: publishTargets.status,
					remoteUrl: publishTargets.remoteUrl,
					connectionId: publishTargets.connectionId
				})
				.from(publishTargets)
				.where(inArray(publishTargets.draftId, chunk))
		])) as [MediaRow[], TargetRow[]];
		allMedia.push(...media);
		allTargets.push(...targets);
	}
	const connIds = [...new Set(allTargets.map((t) => t.connectionId))];
	const conns: {
		id: string;
		platform: string;
		handle: string | null;
		displayName: string | null;
	}[] = [];
	for (const chunk of chunkIds(connIds)) {
		conns.push(
			...(await db
				.select({
					id: connections.id,
					platform: connections.platform,
					handle: connections.handle,
					displayName: connections.displayName
				})
				.from(connections)
				.where(inArray(connections.id, chunk)))
		);
	}
	const connById = new Map(conns.map((c) => [c.id, c]));
	const mediaByDraft = new Map<string, MediaRow[]>();
	for (const m of allMedia) {
		const list = mediaByDraft.get(m.draftId) ?? [];
		list.push(m);
		mediaByDraft.set(m.draftId, list);
	}
	const targetsByDraft = new Map<
		string,
		Array<{
			status: string;
			remoteUrl: string | null;
			connection?: {
				id: string;
				platform: string;
				handle: string | null;
				displayName: string | null;
			};
		}>
	>();
	for (const t of allTargets) {
		const list = targetsByDraft.get(t.draftId) ?? [];
		const connection = connById.get(t.connectionId);
		list.push({
			status: t.status,
			remoteUrl: t.remoteUrl,
			...(connection ? { connection } : {})
		});
		targetsByDraft.set(t.draftId, list);
	}
	return {
		drafts: page.map((d) => ({
			...d,
			media: mediaByDraft.get(d.id) ?? [],
			targets: targetsByDraft.get(d.id) ?? []
		})),
		hasMore
	};
}

/**
 * Queue list shared by `GET /api/queue` and the posts page: everything still
 * to go out first, soonest first, then history newest first.
 *
 * A published target keeps its `scheduledFor`, so ordering by that column alone
 * would put the oldest history ahead of the posts that are waiting and, past a
 * window's worth of it, push them out of the list. A NULL schedule is a
 * "publish now" row, which is due now and sorts first among the upcoming.
 */
export async function loadQueueList(db: AppDb, userId: string, limit = QUEUE_LIST_LIMIT) {
	const upcoming = sql`${publishTargets.status} in ('scheduled', 'pending', 'publishing')`;
	const targetsQuery = db
		.select()
		.from(publishTargets)
		.where(
			and(
				inArray(
					publishTargets.connectionId,
					db.select({ id: connections.id }).from(connections).where(eq(connections.userId, userId))
				),
				inArray(publishTargets.status, [
					'scheduled',
					'pending',
					'publishing',
					'failed',
					'published'
				])
			)
		)
		.orderBy(
			sql`case when ${upcoming} then 0 else 1 end`,
			sql`case when ${upcoming} then ${publishTargets.scheduledFor} end asc`,
			desc(publishTargets.updatedAt)
		)
		.limit(limit + 1);

	type TargetRow = InferSelectModel<typeof publishTargets>;
	type ConnectionRow = Pick<
		InferSelectModel<typeof connections>,
		'id' | 'platform' | 'handle' | 'displayName' | 'avatarUrl' | 'status'
	>;
	type DraftLite = { id: string; title: string | null; baseBody: string; status: string };
	type MediaRow = InferSelectModel<typeof draftMedia>;
	const [allTargetRows, allConns] = (await batchQueries(db, [
		targetsQuery,
		db
			.select({
				id: connections.id,
				platform: connections.platform,
				handle: connections.handle,
				displayName: connections.displayName,
				avatarUrl: connections.avatarUrl,
				status: connections.status
			})
			.from(connections)
			.where(eq(connections.userId, userId))
	])) as [TargetRow[], ConnectionRow[]];

	const hasMore = allTargetRows.length > limit;
	const targetRows = hasMore ? allTargetRows.slice(0, limit) : allTargetRows;
	const connById = new Map(allConns.map((c) => [c.id, c]));
	const queuedDraftIds = [...new Set(targetRows.map((t) => t.draftId))];
	const draftRows: DraftLite[] = [];
	for (const chunk of chunkIds(queuedDraftIds)) {
		draftRows.push(
			...(await db
				.select({
					id: drafts.id,
					title: drafts.title,
					baseBody: drafts.baseBody,
					status: drafts.status
				})
				.from(drafts)
				.where(and(eq(drafts.userId, userId), inArray(drafts.id, chunk))))
		);
	}
	const draftById = new Map(draftRows.map((d) => [d.id, d]));
	const ownedQueuedIds = queuedDraftIds.filter((id) => draftById.has(id));
	const mediaRows: MediaRow[] = [];
	for (const chunk of chunkIds(ownedQueuedIds)) {
		mediaRows.push(
			...(await db.select().from(draftMedia).where(inArray(draftMedia.draftId, chunk)))
		);
	}
	const mediaByDraft = new Map<string, ReturnType<typeof serializeMedia>[]>();
	for (const m of mediaRows) {
		if (!draftById.has(m.draftId)) continue;
		const list = mediaByDraft.get(m.draftId) ?? [];
		list.push(serializeMedia(m));
		mediaByDraft.set(m.draftId, list);
	}
	for (const list of mediaByDraft.values()) {
		list.sort((a, b) => (a.segmentIndex ?? 0) - (b.segmentIndex ?? 0) || a.sortOrder - b.sortOrder);
	}

	const targets = [];
	for (const t of targetRows) {
		const connection = connById.get(t.connectionId);
		const draft = draftById.get(t.draftId);
		if (!connection || !draft) continue;
		if (connection.status === 'disconnected' && !t.remotePostId) continue;
		targets.push({
			id: t.id,
			status: t.status,
			scheduledFor: t.scheduledFor,
			updatedAt: t.updatedAt,
			remoteUrl: t.remoteUrl,
			errorMessage: t.errorMessage,
			draft: {
				id: draft.id,
				title: draft.title,
				baseBody: draft.baseBody,
				status: draft.status,
				media: mediaByDraft.get(draft.id) ?? []
			},
			connection: {
				id: connection.id,
				platform: connection.platform,
				handle: connection.handle,
				displayName: connection.displayName,
				avatarUrl: connection.avatarUrl,
				status: connection.status
			}
		});
	}
	return { targets, hasMore };
}

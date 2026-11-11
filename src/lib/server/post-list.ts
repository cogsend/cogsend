import { and, desc, eq, inArray, ne, sql, type InferSelectModel, type SQL } from 'drizzle-orm';
import { batchQueries, chunkIds, parseJson, type AppDb } from './db/client';
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

export const LIST_SEARCH_MAX = 200;

/** Where the page before ended: `<updatedAt ms>:<id>` of its last row. */
export type ListCursor = { ms: number; id: string };

export function parseListCursor(raw: string | null | undefined): ListCursor | null {
	if (!raw) return null;
	const at = raw.indexOf(':');
	const ms = Number(raw.slice(0, at));
	const id = raw.slice(at + 1);
	if (at <= 0 || !Number.isSafeInteger(ms) || !id || id.length > 256) {
		throw Object.assign(new Error('Invalid cursor'), { status: 400 });
	}
	return { ms, id };
}

export function parseListSearch(raw: string | null | undefined): string | null {
	const q = raw?.trim() ?? '';
	if (!q) return null;
	if (q.length > LIST_SEARCH_MAX) {
		throw Object.assign(new Error(`Search is limited to ${LIST_SEARCH_MAX} characters`), {
			status: 400
		});
	}
	return q;
}

/**
 * Where a queue page ended among the waiting rows, in their order:
 * `u:<scheduledFor ms, or -1 for "now">:<updatedAt ms>:<id>`.
 */
export type WaitingCursor = { waiting: true; at: number; ms: number; id: string };
export type QueueCursor = ListCursor | WaitingCursor;

export function parseQueueCursor(raw: string | null | undefined): QueueCursor | null {
	if (!raw?.startsWith('u:')) return parseListCursor(raw);
	const [at, ms, ...rest] = raw.slice(2).split(':');
	const id = rest.join(':');
	const integer = (s: string | undefined) => (s && /^-?\d{1,16}$/.test(s) ? Number(s) : NaN);
	const cursor = { waiting: true as const, at: integer(at), ms: integer(ms), id };
	if (
		!Number.isSafeInteger(cursor.at) ||
		!Number.isSafeInteger(cursor.ms) ||
		!id ||
		id.length > 256
	) {
		throw Object.assign(new Error('Invalid cursor'), { status: 400 });
	}
	return cursor;
}

export type ListPageOptions = { before?: ListCursor | null; q?: string | null };
export type QueuePageOptions = { before?: QueueCursor | null; q?: string | null };

export const cursorOf = (row: { updatedAt: Date; id: string }) =>
	`${row.updatedAt.getTime()}:${row.id}`;

/**
 * Rows strictly after the cursor in newest-first order. The id breaks ties,
 * so rows that share a timestamp are neither repeated nor skipped.
 */
function olderThan(
	updatedAt: typeof drafts.updatedAt | typeof publishTargets.updatedAt,
	id: typeof drafts.id | typeof publishTargets.id,
	before: ListCursor
): SQL {
	return sql`(${updatedAt} < ${before.ms} or (${updatedAt} = ${before.ms} and ${id} < ${before.id}))`;
}

/** instr, not LIKE: nothing in the search needs escaping, and `%` matches itself. */
function bodyMatches(q: string): SQL {
	return sql`instr(lower(${drafts.baseBody}), lower(${q})) > 0`;
}

/** One user's drafts, newest first, from the cursor on and matching the search. */
export function draftPageFilter(userId: string, opts: ListPageOptions) {
	return and(
		eq(drafts.userId, userId),
		opts.before ? olderThan(drafts.updatedAt, drafts.id, opts.before) : undefined,
		opts.q ? bodyMatches(opts.q) : undefined
	);
}

/**
 * Posts page draft rows. The public list still returns every variant; this
 * one is the card: body, status, accounts, and the few media fields the grid
 * renders. Search and thread length keep the full body.
 */
export async function loadDraftSummaries(
	db: AppDb,
	userId: string,
	limit = DRAFTS_LIST_LIMIT,
	opts: ListPageOptions = {}
) {
	const rows = await db
		.select({
			id: drafts.id,
			title: drafts.title,
			baseBody: drafts.baseBody,
			status: drafts.status,
			updatedAt: drafts.updatedAt
		})
		.from(drafts)
		.where(draftPageFilter(userId, opts))
		.orderBy(desc(drafts.updatedAt), desc(drafts.id))
		.limit(limit + 1);
	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;
	const last = page.at(-1);
	const ids = page.map((d) => d.id);
	type MediaRow = {
		id: string;
		draftId: string;
		storageKey: string;
		mime: string;
		width: number | null;
		height: number | null;
		altText: string | null;
		sortOrder: number;
		segmentIndex: number;
		metaJson: string | null;
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
					width: draftMedia.width,
					height: draftMedia.height,
					altText: draftMedia.altText,
					sortOrder: draftMedia.sortOrder,
					segmentIndex: draftMedia.segmentIndex,
					metaJson: draftMedia.metaJson
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
	// `meta` as serializeMedia shapes it: a video's cover is what the grid shows.
	const mediaByDraft = new Map<
		string,
		(Omit<MediaRow, 'metaJson'> & { meta: Record<string, unknown> | null })[]
	>();
	for (const { metaJson, ...m } of allMedia) {
		const list = mediaByDraft.get(m.draftId) ?? [];
		list.push({ ...m, meta: metaJson ? parseJson<Record<string, unknown>>(metaJson, {}) : null });
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
		hasMore,
		next: hasMore && last ? cursorOf(last) : null
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
export async function loadQueueList(
	db: AppDb,
	userId: string,
	limit = QUEUE_LIST_LIMIT,
	opts: QueuePageOptions = {}
) {
	const upcoming = sql`${publishTargets.status} in ('scheduled', 'pending', 'publishing')`;
	const history = sql`${publishTargets.status} in ('failed', 'published')`;
	// A NULL schedule is "publish now", due ahead of every time.
	const waitingAt = sql`coalesce(${publishTargets.scheduledFor}, -1)`;
	const { before, q } = opts;
	// The waiting rows come first in their own order, so a cursor among them
	// carries that order's keys, and the page after it runs on into history.
	let pageFilter: SQL | undefined;
	if (!before) pageFilter = sql`(${upcoming} or ${history})`;
	else if ('waiting' in before) {
		pageFilter = sql`((${upcoming} and (${waitingAt} > ${before.at} or (${waitingAt} = ${before.at} and ${olderThan(publishTargets.updatedAt, publishTargets.id, before)}))) or ${history})`;
	} else pageFilter = and(history, olderThan(publishTargets.updatedAt, publishTargets.id, before));
	const targetsQuery = db
		.select()
		.from(publishTargets)
		.where(
			and(
				inArray(
					publishTargets.connectionId,
					db.select({ id: connections.id }).from(connections).where(eq(connections.userId, userId))
				),
				pageFilter,
				q
					? inArray(
							publishTargets.draftId,
							db
								.select({ id: drafts.id })
								.from(drafts)
								.where(and(eq(drafts.userId, userId), bodyMatches(q)))
						)
					: undefined
			)
		)
		.orderBy(
			sql`case when ${upcoming} then 0 else 1 end`,
			sql`case when ${upcoming} then ${waitingAt} end asc`,
			desc(publishTargets.updatedAt),
			desc(publishTargets.id)
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
	const last = targetRows.at(-1);
	const endsWaiting = hasMore && !!last && !['failed', 'published'].includes(last.status);
	let next: string | null = null;
	if (hasMore && last) {
		next = endsWaiting
			? `u:${last.scheduledFor?.getTime() ?? -1}:${last.updatedAt.getTime()}:${last.id}`
			: cursorOf(last);
	}
	const connById = new Map(allConns.map((c) => [c.id, c]));
	const queuedDraftIds = [...new Set(targetRows.map((t) => t.draftId))];
	// A post's accounts can fall on both sides of a page that ends among the
	// waiting rows, and acting on "the whole post" from what is loaded would
	// leave the rest scheduled. Totals for each such post let Posts tell.
	let waitingTotals: Record<string, number> | undefined;
	if (endsWaiting) {
		const onPage = new Map<string, number>();
		for (const t of targetRows) {
			if (['failed', 'published'].includes(t.status)) continue;
			// Counted as the totals below are: a disconnected account is never one.
			if (connById.get(t.connectionId)?.status === 'disconnected') continue;
			onPage.set(t.draftId, (onPage.get(t.draftId) ?? 0) + 1);
		}
		waitingTotals = {};
		// Two more bound values (the user and the status) beside the ids.
		for (const chunk of chunkIds([...onPage.keys()], 90)) {
			const counts = await db
				.select({ draftId: publishTargets.draftId, n: sql<number>`count(*)` })
				.from(publishTargets)
				.where(
					and(
						inArray(publishTargets.draftId, chunk),
						upcoming,
						inArray(
							publishTargets.connectionId,
							db
								.select({ id: connections.id })
								.from(connections)
								.where(and(eq(connections.userId, userId), ne(connections.status, 'disconnected')))
						)
					)
				)
				.groupBy(publishTargets.draftId);
			for (const { draftId, n } of counts) {
				if (Number(n) > (onPage.get(draftId) ?? 0)) waitingTotals[draftId] = Number(n);
			}
		}
	}
	const draftRows: DraftLite[] = [];
	// The user id is a bound parameter too, so a full chunk would be 101 and
	// D1 would refuse the statement: a page of 100 one-account posts.
	for (const chunk of chunkIds(queuedDraftIds, 90)) {
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
			// With updatedAt, tells Posts the row is being sent right now.
			jobId: t.jobId,
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
	return { targets, hasMore, next, ...(waitingTotals ? { waitingTotals } : {}) };
}

import { and, desc, eq, getTableColumns, inArray, sql, type InferSelectModel } from 'drizzle-orm';
import { chunkIds, first, parseJson, type AppDb } from './db/client';
import { draftMedia, drafts } from './db/schema';
import { assertSafeStorageKey } from './media';

export const LIBRARY_PAGE_LIMIT = 60;
export const LIBRARY_PAGE_MAX_LIMIT = 100;

type MediaRow = InferSelectModel<typeof draftMedia>;

export type LibraryItem = {
	storageKey: string;
	mime: string;
	size: number;
	width: number | null;
	height: number | null;
	/** From the file's newest attachment, as is everything here. */
	altText: string | null;
	meta: Record<string, unknown> | null;
	lastUsedAt: Date;
};

const lastUsed = sql<number>`max(${draftMedia.createdAt})`.mapWith(Number);

function isSafeKey(key: string): boolean {
	try {
		assertSafeStorageKey(key);
		return true;
	} catch {
		return false;
	}
}

/** `<ms>:<storageKey>`, the last file of the page before. */
export function parseLibraryCursor(raw: string | null | undefined) {
	if (!raw) return null;
	const at = raw.indexOf(':');
	const ms = Number(raw.slice(0, at));
	const key = raw.slice(at + 1);
	// Not held to a minted key's shape: a page can end on an older row's key,
	// which the list leaves out but still pages past.
	if (at <= 0 || !Number.isSafeInteger(ms) || !key || key.length > 256) {
		throw Object.assign(new Error('Invalid cursor'), { status: 400 });
	}
	return { ms, key };
}

const newer = (a: MediaRow, b: MediaRow) =>
	a.createdAt.getTime() - b.createdAt.getTime() || (a.id > b.id ? 1 : -1);

/**
 * Every file the user's posts use, once each, the most recently attached
 * first. A file shared by several posts shows its newest attachment's alt
 * text; it leaves the list with the last post that uses it.
 */
export async function listMediaLibrary(
	db: AppDb,
	userId: string,
	opts: { limit: number; before: { ms: number; key: string } | null }
): Promise<{ items: LibraryItem[]; next: string | null }> {
	const { before } = opts;
	const keyRows = await db
		.select({ storageKey: draftMedia.storageKey, lastUsed })
		.from(draftMedia)
		.innerJoin(drafts, eq(drafts.id, draftMedia.draftId))
		.where(eq(drafts.userId, userId))
		.groupBy(draftMedia.storageKey)
		.having(
			before
				? sql`${lastUsed} < ${before.ms} or (${lastUsed} = ${before.ms} and ${draftMedia.storageKey} < ${before.key})`
				: undefined
		)
		.orderBy(desc(lastUsed), desc(draftMedia.storageKey))
		.limit(opts.limit + 1);
	const page = keyRows.slice(0, opts.limit);
	const last = page.at(-1);
	const next = keyRows.length > opts.limit && last ? `${last.lastUsed}:${last.storageKey}` : null;

	// Only a key saveMediaBytes minted can be attached again or served.
	const keys = page.map((r) => r.storageKey).filter(isSafeKey);
	const newest = new Map<string, MediaRow>();
	// One bound parameter goes to the user; D1 caps a statement at 100.
	for (const chunk of chunkIds(keys, 90)) {
		const rows = await db
			.select(getTableColumns(draftMedia))
			.from(draftMedia)
			.innerJoin(drafts, eq(drafts.id, draftMedia.draftId))
			.where(and(eq(drafts.userId, userId), inArray(draftMedia.storageKey, chunk)));
		for (const row of rows) {
			const seen = newest.get(row.storageKey);
			if (!seen || newer(row, seen) > 0) newest.set(row.storageKey, row);
		}
	}
	const items = keys.flatMap((key) => {
		const row = newest.get(key);
		if (!row) return [];
		return [
			{
				storageKey: row.storageKey,
				mime: row.mime,
				size: row.size,
				width: row.width,
				height: row.height,
				altText: row.altText,
				meta: row.metaJson ? parseJson<Record<string, unknown>>(row.metaJson, {}) : null,
				lastUsedAt: row.createdAt
			}
		];
	});
	return { items, next };
}

/** The newest attachment of `storageKey` in one of the user's posts. */
export async function newestUseOf(
	db: AppDb,
	userId: string,
	storageKey: string
): Promise<MediaRow | undefined> {
	return first(
		db
			.select(getTableColumns(draftMedia))
			.from(draftMedia)
			.innerJoin(drafts, eq(drafts.id, draftMedia.draftId))
			.where(and(eq(drafts.userId, userId), eq(draftMedia.storageKey, storageKey)))
			.orderBy(desc(draftMedia.createdAt), desc(draftMedia.id))
			.limit(1)
	);
}

import { eq, inArray } from 'drizzle-orm';
import { chunkIds, type AppDb } from './db/client';
import { draftMedia, drafts, users } from './db/schema';
import { deleteMediaObjects, type MediaStore } from './media';

/** Objects removed per round trip to R2. R2 takes 1,000 keys in one call, and
 *  the row deletes that follow cost D1 statements (50 per invocation on Free),
 *  so this stays well inside both budgets. */
const MEDIA_DELETE_BATCH = 200;
/** Batches per request — 2,000 objects, which is 10 subrequests and ~30 D1
 *  statements, both well inside the free plan's limit of 50. A library larger
 *  than that is deleted over several requests rather than one that cannot
 *  finish; the rows for each batch go as it lands, so a retry resumes. */
const MAX_MEDIA_BATCHES = 10;

/**
 * Remove one user's media objects, deleting each batch's rows as it goes so
 * that a request which dies part-way leaves rows only for what is still there —
 * the next call resumes instead of walking the same list again. Returns whether
 * everything is gone.
 */
export async function deleteUserMedia(
	db: AppDb,
	media: MediaStore,
	userId: string
): Promise<{ deleted: number; done: boolean }> {
	let deleted = 0;
	for (let batch = 0; batch < MAX_MEDIA_BATCHES; batch++) {
		const files = await db
			.select({ id: draftMedia.id, storageKey: draftMedia.storageKey })
			.from(draftMedia)
			.innerJoin(drafts, eq(draftMedia.draftId, drafts.id))
			.where(eq(drafts.userId, userId))
			.limit(MEDIA_DELETE_BATCH);
		if (!files.length) return { deleted, done: true };

		await deleteMediaObjects(
			media,
			files.map((f) => f.storageKey)
		);

		// One statement per 100 ids: the ids come from a select this request
		// already paid for, and D1 caps a statement at 100 bound parameters.
		for (const chunk of chunkIds(files.map((f) => f.id))) {
			await db.delete(draftMedia).where(inArray(draftMedia.id, chunk));
		}
		deleted += files.length;
		// A short batch is the last one: there is nothing left to read.
		if (files.length < MEDIA_DELETE_BATCH) return { deleted, done: true };
	}
	return { deleted, done: false };
}

/**
 * Delete an account and everything it owns. R2 bytes go first, because the
 * cascade off `users` wipes rows (drafts, connections, schedules, shares,
 * sessions, API keys, backup codes) but not objects: a crash leaves retryable
 * rows instead of orphaned bytes. A library too large for one request is
 * deleted in installments — the account stays until the objects are gone, and
 * `done: false` tells the caller to come back.
 */
export async function deleteUserAndData(
	db: AppDb,
	media: MediaStore,
	userId: string
): Promise<{ deletedMedia: number; done: boolean }> {
	const { deleted, done } = await deleteUserMedia(db, media, userId);
	if (!done) return { deletedMedia: deleted, done: false };
	await db.delete(users).where(eq(users.id, userId));
	return { deletedMedia: deleted, done: true };
}

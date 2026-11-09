import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { newId } from '#lib/server/db/client.js';
import { draftMedia } from '#lib/server/db/schema.js';
import {
	cardRoomProblem,
	cleanAltText,
	ownDraft,
	parseSegmentIndex,
	rejectIfNotEditable
} from '#lib/server/draft-media.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import { assertSafeStorageKey } from '#lib/server/media.js';
import { newestUseOf } from '#lib/server/media-library.js';
import { requireScope, requireUser } from '#lib/server/require.js';
import { serializeMedia } from '#lib/server/serialize.js';

const NOT_FOUND = 'File not found in your posts';

/**
 * Attach a file another of the user's posts already uses. Nothing is stored
 * again: the new attachment points at the same file, with its own alt text
 * and place, and the file is deleted only with the last attachment.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		let body: Record<string, unknown>;
		try {
			body = (await request.json()) as Record<string, unknown>;
		} catch {
			return fail('Invalid JSON');
		}
		if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('Invalid JSON');
		if (typeof body.storageKey !== 'string' || !body.storageKey) {
			return fail('storageKey required');
		}
		const draft = await ownDraft(locals, params.id, user.id);
		if (!draft) return fail('Not found', 404);
		const busy = await rejectIfNotEditable(locals.db, params.id);
		if (busy) return busy;
		const source = await newestUseOf(locals.db, user.id, body.storageKey);
		if (!source) return fail(NOT_FOUND, 404);
		// Only a key saveMediaBytes minted is shared; the serving routes refuse any other.
		try {
			assertSafeStorageKey(source.storageKey);
		} catch {
			return fail(NOT_FOUND, 404);
		}
		const segmentIndex = parseSegmentIndex(body.segmentIndex);
		const video = (source.mime || '').toLowerCase().startsWith('video/');
		const problem = await cardRoomProblem(locals, draft, segmentIndex, {
			video,
			storesFile: false
		});
		if (problem) return problem;
		const stored = async () =>
			!locals.media.size || (await locals.media.size(source.storageKey)) !== null;
		if (!(await stored())) return fail('This file is no longer stored', 404);

		const siblings = await locals.db
			.select({ id: draftMedia.id })
			.from(draftMedia)
			.where(and(eq(draftMedia.draftId, params.id), eq(draftMedia.segmentIndex, segmentIndex)));
		const [media] = await locals.db
			.insert(draftMedia)
			.values({
				id: newId(),
				draftId: params.id,
				storageKey: source.storageKey,
				mime: source.mime,
				size: source.size,
				width: source.width,
				height: source.height,
				metaJson: source.metaJson,
				altText: body.altText === undefined ? source.altText : cleanAltText(body.altText),
				sortOrder: siblings.length,
				segmentIndex,
				createdAt: new Date()
			})
			.returning();
		// The last other post using the file may have been deleted while this
		// one was attaching it, taking the file along; do not keep a row that
		// points at nothing.
		if (!(await stored())) {
			await locals.db.delete(draftMedia).where(eq(draftMedia.id, media.id));
			return fail('This file was deleted while it was being attached', 409);
		}
		return ok({ media: serializeMedia(media) }, 201);
	} catch (err) {
		return handleError(err);
	}
};

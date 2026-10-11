import { and, eq, inArray, ne } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { canAttachMoreImages, MAX_IMAGES_PER_SEGMENT } from '#lib/domain/media-limits.js';
import { chunkIds, first, newId } from '#lib/server/db/client.js';
import { draftMedia, draftVariants, drafts, publishTargets } from '#lib/server/db/schema.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import { deleteMediaObjects, saveMediaBytes } from '#lib/server/media.js';
import { draftHasInFlightPublish } from '#lib/server/publish-plan.js';
import { requireScope, requireUser } from '#lib/server/require.js';

const MAX_SEGMENT_INDEX = 100;
const MAX_ALT_LENGTH = 1500;
// No per-draft or per-user cap existed: segment math alone allows
// ~400 files per draft (100 segments x 4), unbounded R2 cost and
// Worker-memory pressure at publish (bytes are buffered ~2x).
const MAX_FILES_PER_DRAFT = 32;
const MAX_FILES_PER_USER = 1000;
// A request body ceiling applied before the multipart parse: formData()
// buffers the whole body in the isolate, and the per-file caps can only run
// afterwards. Matches the platform's own request-body limit, so anything
// larger is refused with a clean 413 instead of a parse-then-OOM.
const MAX_UPLOAD_BYTES = 100_000_000;

function parseSegmentIndex(value: unknown): number {
	const n = typeof value === 'number' ? value : parseInt(String(value ?? '0'), 10);
	if (!Number.isFinite(n)) return 0;
	return Math.min(MAX_SEGMENT_INDEX, Math.max(0, Math.floor(n)));
}

function cleanAltText(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	return trimmed.slice(0, MAX_ALT_LENGTH);
}

async function rejectIfPublishing(db: App.Locals['db'], draftId: string) {
	const targets = await db.select().from(publishTargets).where(eq(publishTargets.draftId, draftId));
	if (draftHasInFlightPublish(targets)) {
		return fail('Publishing in progress — try again shortly', 409);
	}
	return null;
}
import { splitThreadSegments } from '#lib/domain/thread-segments.js';
import { serializeMedia } from '#lib/server/serialize.js';

async function ownDraft(locals: App.Locals, id: string, userId: string) {
	return first(
		locals.db
			.select()
			.from(drafts)
			.where(and(eq(drafts.id, id), eq(drafts.userId, userId)))
	);
}

/**
 * Refuse a media row on a segment the draft does not have. `resolvePublishSegments`
 * walks the same `splitThreadSegments` the composer renders, so a row parked
 * past the last card is never attached to a post — the image is silently
 * dropped at publish, with nothing to see in the editor either. Empty segments
 * count: the composer shows them, and a card with only an image publishes.
 *
 * The bound is the longest body the draft can publish, not the shared one: a
 * per-platform variant may add posts of its own, and media attached to one of
 * those is attached at publish.
 */
async function segmentProblem(
	locals: App.Locals,
	draft: { id: string; baseBody: string | null },
	segmentIndex: number
): Promise<string | null> {
	const variants = await locals.db
		.select({ body: draftVariants.body })
		.from(draftVariants)
		.where(eq(draftVariants.draftId, draft.id));
	const cards = Math.max(
		splitThreadSegments(draft.baseBody ?? '').length,
		...variants.map((v) => splitThreadSegments(v.body ?? '').length)
	);
	if (segmentIndex < cards) return null;
	return `segmentIndex ${segmentIndex} is past the last segment (${cards - 1})`;
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
	try {
		// Cheapest check first: refuse a body that cannot be legitimate before
		// any query or parse runs. formData() buffers the whole multipart body
		// in the isolate, and the per-file caps below can only run afterwards.
		const declaredBytes = Number(request.headers.get('content-length') ?? '');
		if (Number.isFinite(declaredBytes) && declaredBytes > MAX_UPLOAD_BYTES) {
			return fail('Upload too large', 413);
		}
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		const draft = await ownDraft(locals, params.id, user.id);
		if (!draft) return fail('Not found', 404);
		const busy = await rejectIfPublishing(locals.db, params.id);
		if (busy) return busy;
		const form = await request.formData();
		const segmentIndex = parseSegmentIndex(form.get('segmentIndex'));
		const problem = await segmentProblem(locals, draft, segmentIndex);
		if (problem) return fail(problem, 400);
		const existing = await locals.db
			.select()
			.from(draftMedia)
			.where(eq(draftMedia.draftId, params.id));
		const existingOnSegment = existing.filter((m) => (m.segmentIndex ?? 0) === segmentIndex).length;

		const files: File[] = [];
		for (const entry of [...form.getAll('files'), ...form.getAll('file')]) {
			if (entry instanceof File && entry.size > 0 && !files.includes(entry)) files.push(entry);
		}
		if (!files.length) return fail('file required');
		// Per-file caps, ahead of the ArrayBuffer copy below: formData() already
		// materialised the body once, and arrayBuffer() would hold a second
		// copy (~2x the bytes in Worker memory, 128MB limit vs the 95MB video
		// cap). The Content-Length guard above is what keeps the first copy
		// bounded.
		for (const f of files) {
			const isVideo = (f.type || '').toLowerCase().startsWith('video/');
			const cap = isVideo ? 95_000_000 : 16_000_000;
			if (f.size > cap) {
				return fail(isVideo ? 'Video must be 95MB or smaller' : 'Image must be 16MB or smaller');
			}
		}
		if (existing.length + files.length > MAX_FILES_PER_DRAFT) {
			return fail(`Max ${MAX_FILES_PER_DRAFT} files per draft`, 413);
		}
		const userDraftIds = await locals.db
			.select({ id: drafts.id })
			.from(drafts)
			.where(eq(drafts.userId, user.id));
		let userFiles = 0;
		for (const chunk of chunkIds(userDraftIds.map((d) => d.id))) {
			if (!chunk.length) break;
			const rows = await locals.db
				.select({ id: draftMedia.id })
				.from(draftMedia)
				.where(inArray(draftMedia.draftId, chunk));
			userFiles += rows.length;
			if (userFiles + files.length > MAX_FILES_PER_USER) break;
		}
		if (userFiles + files.length > MAX_FILES_PER_USER) {
			return fail(`Max ${MAX_FILES_PER_USER} files per account`, 413);
		}
		const remaining = MAX_IMAGES_PER_SEGMENT - existingOnSegment;
		if (remaining <= 0) return fail(`Max ${MAX_IMAGES_PER_SEGMENT} images per post`);
		if (files.length > remaining) {
			return fail(
				`Only ${remaining} more image(s) allowed on this post (max ${MAX_IMAGES_PER_SEGMENT})`
			);
		}
		const isVideoFile = (f: File) => (f.type || '').toLowerCase().startsWith('video/');
		const isVideoRow = (m: { mime: string | null }) =>
			(m.mime || '').toLowerCase().startsWith('video/');
		const newVideos = files.filter(isVideoFile).length;
		// In-progress feature (ENABLE_VIDEO_UPLOAD): without this the route would
		// happily park up to 95MB in R2 for a draft that cannot publish it.
		if (newVideos > 0 && !locals.env.videoUploadEnabled) {
			return fail('Video uploads are not enabled on this instance', 400);
		}
		const newImages = files.length - newVideos;
		const onSegment = existing.filter((m) => (m.segmentIndex ?? 0) === segmentIndex);
		const existingVideos = onSegment.filter(isVideoRow).length;
		const existingImages = onSegment.length - existingVideos;
		if (newVideos + existingVideos > 1) {
			return fail('Only one video per post, and videos cannot mix with images on LinkedIn');
		}
		// The message above promises no mixing, so enforce it here: a count of
		// one video alone would let 1 image + 1 video through to a late publish
		// failure.
		if (newVideos + existingVideos > 0 && newImages + existingImages > 0) {
			return fail('Videos cannot mix with images on the same post');
		}

		const altText = cleanAltText(form.get('altText'));
		const created = [];
		for (let i = 0; i < files.length; i++) {
			const file = files[i];
			const bytes = new Uint8Array(await file.arrayBuffer());
			const saved = await saveMediaBytes(locals.media, { bytes, mime: file.type || 'image/jpeg' });
			let media;
			try {
				[media] = await locals.db
					.insert(draftMedia)
					.values({
						id: newId(),
						draftId: params.id,
						storageKey: saved.storageKey,
						mime: saved.mime,
						size: saved.size,
						width: saved.width,
						height: saved.height,
						altText: i === 0 ? altText : null,
						sortOrder: existingOnSegment + i,
						segmentIndex,
						createdAt: new Date()
					})
					.returning();
			} catch (err) {
				// put-before-insert leaks the object when the DB write fails:
				// compensate so a failed upload never orphans R2 bytes.
				await locals.media.delete(saved.storageKey).catch(() => {});
				throw err;
			}
			created.push(serializeMedia(media));
		}
		return ok({ media: created.length === 1 ? created[0] : created, items: created }, 201);
	} catch (err) {
		return handleError(err);
	}
};

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		const draft = await ownDraft(locals, params.id, user.id);
		if (!draft) return fail('Not found', 404);
		const busy = await rejectIfPublishing(locals.db, params.id);
		if (busy) return busy;
		let body: Record<string, unknown>;
		try {
			body = (await request.json()) as Record<string, unknown>;
		} catch {
			return fail('Invalid JSON');
		}
		const mediaId = String(body.mediaId || '');
		if (!mediaId) return fail('mediaId required');
		const existing = await first(
			locals.db
				.select()
				.from(draftMedia)
				.where(and(eq(draftMedia.id, mediaId), eq(draftMedia.draftId, params.id)))
		);
		if (!existing) return fail('Media not found', 404);
		const data: { altText?: string | null; segmentIndex?: number } = {};
		if (body.altText !== undefined) data.altText = cleanAltText(body.altText);
		if (body.segmentIndex !== undefined) {
			const si = parseSegmentIndex(body.segmentIndex);
			const problem = await segmentProblem(locals, draft, si);
			if (problem) return fail(problem, 400);
			const siblings = await locals.db
				.select()
				.from(draftMedia)
				.where(
					and(
						eq(draftMedia.draftId, params.id),
						eq(draftMedia.segmentIndex, si),
						ne(draftMedia.id, mediaId)
					)
				);
			if (!canAttachMoreImages(siblings.length))
				return fail(`Max ${MAX_IMAGES_PER_SEGMENT} images per post`);
			// Moving must respect the same video invariants as upload: at most
			// one video per segment and no image/video mixing.
			const movingIsVideo = (existing.mime || '').toLowerCase().startsWith('video/');
			const sibVideos = siblings.filter((m) =>
				(m.mime || '').toLowerCase().startsWith('video/')
			).length;
			const sibImages = siblings.length - sibVideos;
			if (movingIsVideo ? sibVideos > 0 || sibImages > 0 : sibVideos > 0) {
				return fail('Videos cannot mix with images on the same post');
			}
			data.segmentIndex = si;
		}
		if (Object.keys(data).length === 0) return fail('Nothing to update');
		const [media] = await locals.db
			.update(draftMedia)
			.set(data)
			.where(eq(draftMedia.id, mediaId))
			.returning();
		return ok({ media: serializeMedia(media) });
	} catch (err) {
		return handleError(err);
	}
};

export const DELETE: RequestHandler = async ({ params, url, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		if (!(await ownDraft(locals, params.id, user.id))) return fail('Not found', 404);
		const busy = await rejectIfPublishing(locals.db, params.id);
		if (busy) return busy;
		const mediaId = url.searchParams.get('mediaId');
		if (!mediaId) return fail('mediaId required');
		const gone = await first(
			locals.db
				.select()
				.from(draftMedia)
				.where(and(eq(draftMedia.id, mediaId), eq(draftMedia.draftId, params.id)))
		);
		await locals.db
			.delete(draftMedia)
			.where(and(eq(draftMedia.id, mediaId), eq(draftMedia.draftId, params.id)));
		if (gone) await deleteMediaObjects(locals.media, [gone.storageKey]);
		return ok({ ok: true });
	} catch (err) {
		return handleError(err);
	}
};

import { and, eq, ne } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import {
	canAttachMoreImages,
	MAX_IMAGES_PER_SEGMENT,
	validateImageUpload,
	videoMixProblem
} from '#lib/domain/media-limits.js';
import { first, newId } from '#lib/server/db/client.js';
import { draftMedia } from '#lib/server/db/schema.js';
import {
	cleanAltText,
	MAX_FILES_PER_DRAFT,
	MAX_FILES_PER_USER,
	overUserFileCap,
	ownDraft,
	parseSegmentIndex,
	rejectIfNotEditable,
	segmentProblem
} from '#lib/server/draft-media.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import {
	deleteMediaObjects,
	jpegKey,
	MAX_JPEG_COPY_BYTES,
	MAX_PREVIEW_BYTES,
	previewKey,
	saveMediaBytes,
	type StoredImageMeta
} from '#lib/server/media.js';
import { requireScope, requireUser } from '#lib/server/require.js';
import { serializeMedia } from '#lib/server/serialize.js';

// A request body ceiling applied before the multipart parse: formData()
// buffers the whole body in the isolate, and the per-file caps can only run
// afterwards. Matches the platform's own request-body limit, so anything
// larger is refused with a clean 413 instead of a parse-then-OOM.
const MAX_UPLOAD_BYTES = 100_000_000;
// One file must fit in that body with its multipart framing; the uploads route
// takes videos up to MAX_VIDEO_BYTES in parts.
const MAX_FORM_VIDEO_BYTES = 95_000_000;

/**
 * Keep a JPEG the composer made of an image: a smaller one for showing it, or
 * a full-size one for Instagram. One that is missing, too large or not a JPEG
 * is dropped, and the upload never fails over it.
 */
async function saveJpegVariant(
	locals: App.Locals,
	key: string,
	file: File | null,
	maxBytes: number
): Promise<boolean> {
	if (!file || file.size > maxBytes) return false;
	const bytes = new Uint8Array(await file.arrayBuffer());
	const check = validateImageUpload({ mime: 'image/jpeg', size: bytes.length, maxBytes, bytes });
	if (!check.ok || check.mime !== 'image/jpeg') return false;
	try {
		await locals.media.put(key, bytes, 'image/jpeg');
		return true;
	} catch {
		return false;
	}
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
		const busy = await rejectIfNotEditable(locals.db, params.id);
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
		// `preview-<n>` is the composer's smaller copy of the n-th file entry,
		// `jpeg-<n>` its full-size JPEG copy of a PNG or WebP.
		const previews: Array<File | null> = [];
		const jpegs: Array<File | null> = [];
		const fileField = (name: string) => {
			const value = form.get(name);
			return value instanceof File && value.size > 0 ? value : null;
		};
		[...form.getAll('files'), ...form.getAll('file')].forEach((entry, n) => {
			if (!(entry instanceof File) || entry.size <= 0 || files.includes(entry)) return;
			files.push(entry);
			previews.push(fileField(`preview-${n}`));
			jpegs.push(fileField(`jpeg-${n}`));
		});
		if (!files.length) return fail('file required');
		// Per-file caps, ahead of the ArrayBuffer copy below: formData() already
		// materialised the body once, and arrayBuffer() would hold a second
		// copy (~2x the bytes in Worker memory, 128MB limit vs the 95MB video
		// cap). The Content-Length guard above is what keeps the first copy
		// bounded.
		for (const f of files) {
			const isVideo = (f.type || '').toLowerCase().startsWith('video/');
			const cap = isVideo ? MAX_FORM_VIDEO_BYTES : 16_000_000;
			if (f.size > cap) {
				return fail(
					isVideo
						? 'Video must be 95MB or smaller here; larger ones go up in parts (POST /api/drafts/:id/media/uploads)'
						: 'Image must be 16MB or smaller'
				);
			}
		}
		if (existing.length + files.length > MAX_FILES_PER_DRAFT) {
			return fail(`Max ${MAX_FILES_PER_DRAFT} files per draft`, 413);
		}
		if (await overUserFileCap(locals.db, user.id, files.length)) {
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
		const newImages = files.length - newVideos;
		const onSegment = existing.filter((m) => (m.segmentIndex ?? 0) === segmentIndex);
		const existingVideos = onSegment.filter(isVideoRow).length;
		const existingImages = onSegment.length - existingVideos;
		const segmentProblemText = videoMixProblem(
			newVideos + existingVideos,
			newImages + existingImages
		);
		if (segmentProblemText) return fail(segmentProblemText);

		const altText = cleanAltText(form.get('altText'));
		const created = [];
		for (let i = 0; i < files.length; i++) {
			const file = files[i];
			const bytes = new Uint8Array(await file.arrayBuffer());
			const saved = await saveMediaBytes(locals.media, { bytes, mime: file.type || 'image/jpeg' });
			const imageMeta: StoredImageMeta = {};
			if (!saved.video) {
				const v = Date.now();
				const key = saved.storageKey;
				if (await saveJpegVariant(locals, previewKey(key), previews[i], MAX_PREVIEW_BYTES)) {
					imageMeta.preview = { v };
				}
				// A JPEG original is already what Instagram takes.
				if (
					saved.mime !== 'image/jpeg' &&
					(await saveJpegVariant(locals, jpegKey(key), jpegs[i], MAX_JPEG_COPY_BYTES))
				) {
					imageMeta.jpeg = { v };
				}
			}
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
						metaJson: saved.video
							? JSON.stringify(saved.video)
							: Object.keys(imageMeta).length
								? JSON.stringify(imageMeta)
								: null,
						altText: i === 0 ? altText : null,
						sortOrder: existingOnSegment + i,
						segmentIndex,
						createdAt: new Date()
					})
					.returning();
			} catch (err) {
				// put-before-insert leaks the object when the DB write fails:
				// compensate so a failed upload never orphans R2 bytes.
				await deleteMediaObjects(locals.media, [saved.storageKey]).catch(() => {});
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
		const busy = await rejectIfNotEditable(locals.db, params.id);
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
		const busy = await rejectIfNotEditable(locals.db, params.id);
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

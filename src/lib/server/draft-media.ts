import { and, eq, inArray, ne } from 'drizzle-orm';
import { MAX_ALT_LENGTH } from '#lib/domain/alt-text.js';
import { MAX_IMAGES_PER_SEGMENT, videoMixProblem } from '#lib/domain/media-limits.js';
import { splitThreadSegments } from '#lib/domain/thread-segments.js';
import { chunkIds, first } from './db/client';
import { draftMedia, draftVariants, drafts, publishTargets } from './db/schema';
import { fail } from './http';
import { draftEditBlock } from './publish-plan';

const MAX_SEGMENT_INDEX = 100;
// No per-draft or per-user cap existed: segment math alone allows
// ~400 files per draft (100 segments x 4), unbounded R2 cost and
// Worker-memory pressure at publish (bytes are buffered ~2x).
export const MAX_FILES_PER_DRAFT = 32;
export const MAX_FILES_PER_USER = 1000;

export function parseSegmentIndex(value: unknown): number {
	const n = typeof value === 'number' ? value : parseInt(String(value ?? '0'), 10);
	if (!Number.isFinite(n)) return 0;
	return Math.min(MAX_SEGMENT_INDEX, Math.max(0, Math.floor(n)));
}

export function cleanAltText(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	return trimmed.slice(0, MAX_ALT_LENGTH);
}

export async function rejectIfNotEditable(db: App.Locals['db'], draftId: string) {
	const targets = await db.select().from(publishTargets).where(eq(publishTargets.draftId, draftId));
	const blocked = draftEditBlock(targets);
	return blocked ? fail(blocked, 409) : null;
}

/**
 * The keys no other media row points at. A copied post shares its original's
 * stored files, so a file may go only with the last row that uses it.
 */
export async function keysUsedOnlyBy(
	db: App.Locals['db'],
	keys: string[],
	leaving: { draftId: string } | { mediaId: string }
): Promise<string[]> {
	const unique = [...new Set(keys)];
	const elsewhere =
		'draftId' in leaving
			? ne(draftMedia.draftId, leaving.draftId)
			: ne(draftMedia.id, leaving.mediaId);
	const kept = new Set<string>();
	// One bound parameter goes to `elsewhere`; D1 caps a statement at 100.
	for (const chunk of chunkIds(unique, 90)) {
		const rows = await db
			.selectDistinct({ key: draftMedia.storageKey })
			.from(draftMedia)
			.where(and(inArray(draftMedia.storageKey, chunk), elsewhere));
		for (const row of rows) kept.add(row.key);
	}
	return unique.filter((key) => !kept.has(key));
}

export async function ownDraft(locals: App.Locals, id: string, userId: string) {
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
export async function segmentProblem(
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

/**
 * Whether `adding` more files would take the account past MAX_FILES_PER_USER.
 * Counts stored files, not attachments: a duplicated post shares its files.
 */
export async function overUserFileCap(
	db: App.Locals['db'],
	userId: string,
	adding: number
): Promise<boolean> {
	const userDraftIds = await db
		.select({ id: drafts.id })
		.from(drafts)
		.where(eq(drafts.userId, userId));
	const keys = new Set<string>();
	for (const chunk of chunkIds(userDraftIds.map((d) => d.id))) {
		if (!chunk.length) break;
		const rows = await db
			.selectDistinct({ storageKey: draftMedia.storageKey })
			.from(draftMedia)
			.where(inArray(draftMedia.draftId, chunk));
		for (const row of rows) keys.add(row.storageKey);
		if (keys.size + adding > MAX_FILES_PER_USER) break;
	}
	return keys.size + adding > MAX_FILES_PER_USER;
}

const isVideoRow = (m: { mime: string | null }) =>
	(m.mime || '').toLowerCase().startsWith('video/');

/**
 * Every check one more attachment on `segmentIndex` must pass: the card
 * exists, the draft has room, the account has room for a file that is stored
 * anew, and the card keeps a video on its own.
 */
export async function cardRoomProblem(
	locals: App.Locals,
	draft: { id: string; baseBody: string | null; userId: string },
	segmentIndex: number,
	adding: { video: boolean; storesFile: boolean }
): Promise<Response | null> {
	const problem = await segmentProblem(locals, draft, segmentIndex);
	if (problem) return fail(problem, 400);
	const existing = await locals.db
		.select()
		.from(draftMedia)
		.where(eq(draftMedia.draftId, draft.id));
	if (existing.length + 1 > MAX_FILES_PER_DRAFT) {
		return fail(`Max ${MAX_FILES_PER_DRAFT} files per draft`, 413);
	}
	if (adding.storesFile && (await overUserFileCap(locals.db, draft.userId, 1))) {
		return fail(`Max ${MAX_FILES_PER_USER} files per account`, 413);
	}
	const onSegment = existing.filter((m) => (m.segmentIndex ?? 0) === segmentIndex);
	if (onSegment.length >= MAX_IMAGES_PER_SEGMENT) {
		return fail(`Max ${MAX_IMAGES_PER_SEGMENT} images per post`);
	}
	const videos = onSegment.filter(isVideoRow).length;
	const images = onSegment.length - videos;
	const mix = adding.video
		? videoMixProblem(videos + 1, images)
		: videoMixProblem(videos, images + 1);
	return mix ? fail(mix) : null;
}

/**
 * Every check a new video must pass before any bytes are stored. The parts
 * route runs it when an upload starts and again when it completes, since
 * another upload may have landed in between.
 */
export function videoSlotProblem(
	locals: App.Locals,
	draft: { id: string; baseBody: string | null; userId: string },
	segmentIndex: number
): Promise<Response | null> {
	return cardRoomProblem(locals, draft, segmentIndex, { video: true, storesFile: true });
}

import {
	and,
	desc,
	eq,
	inArray,
	isNull,
	lte,
	notInArray,
	or,
	type InferSelectModel
} from 'drizzle-orm';
import {
	countGraphemes,
	mastodonWeightedLength,
	validateBlueskyText,
	validateLinkedinText,
	validateMastodonText,
	validateInstagramText,
	validateThreadsText,
	validateXText
} from '#lib/domain/validation/text.js';
import { getProvider, isPlatformId, type PlatformId } from '#lib/server/providers/index.js';
import {
	connections,
	drafts,
	draftMedia,
	draftVariants,
	publishTargets
} from '#lib/server/db/schema.js';
import { batchQueries, chunkIds, first, newId, parseJson } from '#lib/server/db/client.js';
import { serializeDraft, serializeVariant } from '#lib/server/serialize.js';
import {
	MAX_VARIANT_OPTIONS_LENGTH,
	parseDraftBody,
	parseDraftTitle,
	parseSegmentBody,
	parseThreadSegments
} from '#lib/domain/validation/draft-fields.js';
import {
	normalizeSelectedConnectionIds,
	normalizeConnectionIds,
	connectionIdsOverflow,
	runAtError
} from '#lib/domain/request-limits.js';
import {
	classifyConnections,
	ensureTargets,
	refuseInFlightOrPublished,
	draftEditBlock,
	draftHasInFlightPublish
} from '#lib/server/publish-plan.js';
import {
	buildNormalizedPost,
	INLINE_PUBLISH_MS,
	refreshDraftStatus,
	publishTarget
} from '#lib/server/publish.js';
import { humanizedCause } from '#lib/domain/human-error.js';
import type { SubrequestBudget } from '#lib/server/budget.js';
import { randomHex } from '#lib/domain/bytes.js';
import { MAX_VIDEO_BYTES, validateImageUpload } from '#lib/domain/media-limits.js';
import type { Mp4Facts } from '#lib/domain/mp4-probe.js';
import { validatePollConfig } from '#lib/domain/poll.js';
import {
	assertSafeStorageKey,
	coverKey,
	deleteMediaObjects,
	jpegKey,
	makeStoredJpegCopy,
	previewKey,
	probeStoredVideo,
	videoMetaFrom,
	type ImageResizer,
	type StoredImageMeta,
	type StoredVideoMeta
} from '#lib/server/media.js';
import { STALE_CLAIM_MS } from '#lib/domain/due-jobs.js';
import { ApiOperationError } from '#lib/server/api/operation-error.js';
import { DRAFTS_LIST_LIMIT, DRAFTS_LIST_MAX_LIMIT, loadQueueList } from '#lib/server/post-list.js';
import { listConnections as loadConnectionList } from '#lib/server/connection-list.js';
import { loadOwnedDraft } from '#lib/server/draft-record.js';

export type OperationContext = Pick<App.Locals, 'db' | 'env' | 'media'> & {
	bindings?: object;
	budget?: SubrequestBudget;
	waitUntil?: (promise: Promise<unknown>) => void;
};
function invalid(message: string, status = 400, details?: Record<string, unknown>): never {
	throw new ApiOperationError(message, status, details);
}

const MAX_VALIDATE_LENGTH = 200_000;

export function validatePost(input: {
	text?: unknown;
	platform?: unknown;
	maxCharacters?: unknown;
}) {
	const text = String(input.text || '');
	// Five validators run over this: an unbounded body is free CPU for any read-only key.
	if (text.length > MAX_VALIDATE_LENGTH)
		invalid(`text must be ${MAX_VALIDATE_LENGTH} characters or fewer`, 413);
	const platform = input.platform as PlatformId | undefined;
	const maxCharacters = input.maxCharacters as number | undefined;
	const bluesky = validateBlueskyText(text),
		mastodon = validateMastodonText(text, maxCharacters ?? 500),
		linkedin = validateLinkedinText(text),
		threads = validateThreadsText(text),
		instagram = validateInstagramText(text),
		x = validateXText(text);
	const issues =
		platform && isPlatformId(platform)
			? getProvider(platform).validate({ text }, { maxCharacters })
			: [];
	return {
		graphemes: countGraphemes(text),
		mastodonLength: mastodonWeightedLength(text),
		bluesky,
		mastodon,
		linkedin,
		threads,
		instagram,
		x,
		issues
	};
}
export async function updateDraft(
	ctx: OperationContext,
	userId: string,
	id: string,
	body: unknown
) {
	const old = await first(
		ctx.db
			.select()
			.from(drafts)
			.where(and(eq(drafts.id, id), eq(drafts.userId, userId)))
	);
	if (!old) invalid('Not found', 404);
	const liveTargets = await ctx.db
		.select()
		.from(publishTargets)
		.where(eq(publishTargets.draftId, id));
	const blocked = draftEditBlock(liveTargets);
	if (blocked) invalid(blocked, 409);
	if (!body || typeof body !== 'object') invalid('Invalid JSON body');
	const input = body as Record<string, unknown>;
	const selection = normalizeSelectedConnectionIds(input.selectedConnectionIds);
	if (!selection.ok) invalid(selection.error);
	// Validate before the UPDATE: a non-string would reach the driver as a 500.
	const patch: { title?: string | null; baseBody?: string; selectedConnectionIds?: string } = {};
	if (input.title !== undefined) {
		const title = parseDraftTitle(input.title);
		if (!title.ok) invalid(title.error);
		patch.title = title.value;
	}
	if (input.baseBody !== undefined) {
		const text = parseDraftBody(input.baseBody);
		if (!text.ok) invalid(text.error);
		patch.baseBody = text.value;
	}
	if (selection.value !== undefined) patch.selectedConnectionIds = selection.value;
	await ctx.db
		.update(drafts)
		.set({ ...patch, updatedAt: new Date() })
		.where(eq(drafts.id, id));
	return { ok: true as const };
}
/**
 * Instagram refuses a post without a photo or video, and a few other shapes
 * the rest take. Every other platform's problems surface when it is sent, but
 * these are certain, so the request is refused before anything is written:
 * an API client learns now, not at the scheduled time.
 */
// get, Images, put and the meta write, plus room for the publish after.
const JPEG_COPY_CALLS = 4;
const JPEG_COPY_RESERVE = 25;

/**
 * A PNG or WebP attached before 1.21, or uploaded through the API, has no
 * JPEG copy for Instagram. With the Images binding the server makes the copy
 * and keeps it, so it happens once. Returns true when the request's call
 * budget ran short and some were left for the next try.
 */
async function makeMissingJpegCopies(ctx: OperationContext, draftId: string): Promise<boolean> {
	const images = (ctx.bindings as { IMAGES?: ImageResizer } | undefined)?.IMAGES;
	if (!images) return false;
	const rows = await ctx.db.select().from(draftMedia).where(eq(draftMedia.draftId, draftId));
	const missing = rows.filter((row) => {
		const mime = (row.mime || '').toLowerCase();
		if (mime !== 'image/png' && mime !== 'image/webp') return false;
		return !parseJson<StoredImageMeta>(row.metaJson, {}).jpeg;
	});
	for (const row of missing) {
		if (ctx.budget && ctx.budget.remaining < JPEG_COPY_CALLS + JPEG_COPY_RESERVE) return true;
		ctx.budget?.count();
		if (!(await makeStoredJpegCopy(ctx.media, row.storageKey, row.width, images))) continue;
		const meta: StoredImageMeta = {
			...parseJson<StoredImageMeta>(row.metaJson, {}),
			jpeg: { v: 1 }
		};
		await ctx.db
			.update(draftMedia)
			.set({ metaJson: JSON.stringify(meta) })
			.where(eq(draftMedia.id, row.id));
	}
	return false;
}

async function refuseUnfitForInstagram(
	ctx: OperationContext,
	draftId: string,
	conns: Array<{ platform: string }>
) {
	if (!conns.some((c) => c.platform === 'instagram')) return;
	const deferred = await makeMissingJpegCopies(ctx, draftId);
	const content = await buildNormalizedPost(ctx.db, draftId, 'instagram');
	const issues = getProvider('instagram').validate(content);
	if (issues.length) {
		if (deferred && issues.some((issue) => issue.message.includes('JPEG'))) {
			invalid('Instagram: still making JPEG copies of the photos — try again', 503, {
				platform: 'instagram',
				retryable: true
			});
		}
		invalid(`Instagram: ${issues[0].message}`, 400, {
			platform: 'instagram',
			issues: issues.map((issue) => issue.message)
		});
	}
}

export async function scheduleDraft(
	ctx: OperationContext,
	userId: string,
	draftId: string,
	body: unknown
) {
	const draft = await first(
		ctx.db
			.select()
			.from(drafts)
			.where(and(eq(drafts.id, draftId), eq(drafts.userId, userId)))
	);
	if (!draft) invalid('Not found', 404);
	if (!body || typeof body !== 'object') invalid('Invalid JSON body');
	const input = body as { connectionIds?: unknown; runAt?: unknown; cancelOthers?: unknown };
	const now = new Date();
	if (connectionIdsOverflow(input.connectionIds)) invalid('Too many connections (max 10)');
	if (input.cancelOthers !== undefined && typeof input.cancelOthers !== 'boolean')
		invalid('cancelOthers must be a boolean');
	const ids = normalizeConnectionIds(input.connectionIds);
	const runAt = input.runAt ? new Date(input.runAt as string) : null;
	if (!ids.length) invalid('connectionIds required');
	const problem = runAtError(input.runAt, now);
	if (problem) invalid(problem);
	if (!runAt) invalid('runAt required (ISO date)');
	const conns = await ctx.db
		.select()
		.from(connections)
		.where(
			and(
				eq(connections.userId, userId),
				inArray(connections.id, ids),
				eq(connections.status, 'active')
			)
		);
	if (conns.length !== ids.length) invalid('One or more connections not found');
	const classified = await classifyConnections(ctx.db, draftId, conns, now);
	const already = classified.filter((i) => i.kind === 'published').map((i) => i.connectionId);
	const flight = classified.filter((i) => i.kind === 'inFlight').map((i) => i.connectionId);
	if (already.length || flight.length)
		invalid(flight.length ? 'Already publishing' : 'Already published', 409, {
			alreadyPublished: already,
			inFlight: flight
		});
	await refuseUnfitForInstagram(ctx, draftId, conns);
	const ensured = await ensureTargets(ctx.db, draftId, conns, 'schedule', runAt, now);
	const blocked = ensured.filter((i) => i.alreadyPublished || i.inFlight);
	if (blocked.length)
		invalid(blocked.some((i) => i.inFlight) ? 'Already publishing' : 'Already published', 409, {
			alreadyPublished: blocked.filter((i) => i.alreadyPublished).map((i) => i.target.connectionId),
			inFlight: blocked.filter((i) => i.inFlight).map((i) => i.target.connectionId)
		});
	// Opt-in, so the API stays additive: the composer sends the whole destination
	// list, and an account taken off it must not keep its old time. Only rows
	// still waiting are touched; a jobId means the tick is already sending it.
	const cancelled = input.cancelOthers
		? await ctx.db
				.update(publishTargets)
				.set({ status: 'cancelled', jobId: null, scheduledFor: null, updatedAt: now })
				.where(
					and(
						eq(publishTargets.draftId, draftId),
						notInArray(publishTargets.connectionId, ids),
						inArray(publishTargets.status, ['scheduled', 'pending']),
						isNull(publishTargets.remotePostId),
						isNull(publishTargets.jobId)
					)
				)
				.returning({ connectionId: publishTargets.connectionId })
		: [];
	await refreshDraftStatus(ctx.db, draftId);
	return {
		targets: ensured.map((i) => i.target),
		scheduledFor: runAt.toISOString(),
		cancelled: [...new Set(cancelled.map((row) => row.connectionId))]
	};
}

export async function cancelDelivery(ctx: OperationContext, userId: string, id: string) {
	const target = await first(ctx.db.select().from(publishTargets).where(eq(publishTargets.id, id)));
	if (!target) invalid('Not found', 404);
	const draft = await first(ctx.db.select().from(drafts).where(eq(drafts.id, target.draftId)));
	if (!draft || draft.userId !== userId) invalid('Not found', 404);
	if (target.status === 'published' || target.remotePostId) invalid('Already published');
	if (target.status === 'cancelled') return { target };
	const now = new Date();
	const blocked = refuseInFlightOrPublished(target, now);
	if (blocked) invalid(blocked, 409);
	const stale = new Date(now.getTime() - STALE_CLAIM_MS);
	const [updated] = await ctx.db
		.update(publishTargets)
		.set({ status: 'cancelled', jobId: null, scheduledFor: null, updatedAt: now })
		.where(
			and(
				eq(publishTargets.id, id),
				or(
					inArray(publishTargets.status, ['pending', 'scheduled', 'failed']),
					and(eq(publishTargets.status, 'publishing'), lte(publishTargets.updatedAt, stale))
				)
			)
		)
		.returning();
	if (!updated) {
		const latest = await first(
			ctx.db.select().from(publishTargets).where(eq(publishTargets.id, id))
		);
		if (latest?.status === 'cancelled') return { target: latest };
		if (latest?.remotePostId || latest?.status === 'published') invalid('Already published');
		invalid('Already publishing', 409);
	}
	await refreshDraftStatus(ctx.db, target.draftId);
	return { target: updated };
}

export async function retryDelivery(ctx: OperationContext, userId: string, id: string) {
	const target = await first(ctx.db.select().from(publishTargets).where(eq(publishTargets.id, id)));
	if (!target) invalid('Not found', 404);
	const draft = await first(ctx.db.select().from(drafts).where(eq(drafts.id, target.draftId)));
	if (!draft || draft.userId !== userId) invalid('Not found', 404);
	const now = new Date();
	if (target.remotePostId)
		return { status: 'published', remotePostId: target.remotePostId, skipped: true };
	const blocked = refuseInFlightOrPublished(target, now);
	if (blocked) invalid(blocked, 409);
	const conn = await first(
		ctx.db.select().from(connections).where(eq(connections.id, target.connectionId))
	);
	if (!conn || conn.userId !== userId) invalid('Not found', 404);
	if (conn.status !== 'active') invalid('Account needs reconnect', 409);
	const stale = new Date(now.getTime() - STALE_CLAIM_MS);
	const reset = await ctx.db
		.update(publishTargets)
		.set({
			// A manual retry is fresh intent: clear stale claims and the attempt budget.
			status: 'pending',
			scheduledFor: null,
			errorMessage: null,
			jobId: null,
			attemptCount: 0,
			updatedAt: now
		})
		.where(
			and(
				eq(publishTargets.id, id),
				isNull(publishTargets.remotePostId),
				or(
					inArray(publishTargets.status, ['pending', 'scheduled', 'failed', 'cancelled']),
					and(eq(publishTargets.status, 'publishing'), lte(publishTargets.updatedAt, stale))
				)
			)
		)
		.returning({ id: publishTargets.id });
	if (!reset.length) {
		const latest = await first(
			ctx.db.select().from(publishTargets).where(eq(publishTargets.id, id))
		);
		if (latest?.remotePostId)
			return { status: 'published', remotePostId: latest.remotePostId, skipped: true };
		invalid('Already publishing', 409);
	}
	// The budget lets a video upload park before the request runs out of calls.
	const task = publishTarget(ctx.db, ctx.env, ctx.media, id, {
		now,
		budget: ctx.budget,
		mustTry: true,
		deadline: now.getTime() + INLINE_PUBLISH_MS
	});
	ctx.waitUntil?.(task.then(() => undefined).catch(() => undefined));
	return task;
}

export async function rescheduleDelivery(
	ctx: OperationContext,
	userId: string,
	id: string,
	body: unknown
) {
	const target = await first(ctx.db.select().from(publishTargets).where(eq(publishTargets.id, id)));
	if (!target) invalid('Not found', 404);
	const draft = await first(ctx.db.select().from(drafts).where(eq(drafts.id, target.draftId)));
	if (!draft || draft.userId !== userId) invalid('Not found', 404);
	const now = new Date();
	const blocked = refuseInFlightOrPublished(target, now);
	if (blocked) invalid(blocked, 409);
	if (target.status === 'cancelled') invalid('Cancelled — retry instead');
	if (!body || typeof body !== 'object') invalid('Invalid JSON body');
	const input = body as { runAt?: unknown };
	const runAt = input.runAt ? new Date(input.runAt as string) : null;
	const problem = runAtError(input.runAt, now);
	if (problem) invalid(problem);
	if (!runAt) invalid('runAt required', 400);
	const conn = await first(
		ctx.db.select().from(connections).where(eq(connections.id, target.connectionId))
	);
	if (!conn || conn.userId !== userId) invalid('Not found', 404);
	if (conn.status !== 'active') invalid('Account needs reconnect', 409);
	const stale = new Date(now.getTime() - STALE_CLAIM_MS);
	const updated = await ctx.db
		.update(publishTargets)
		.set({
			status: 'scheduled',
			scheduledFor: runAt,
			errorMessage: null,
			jobId: null,
			attemptCount: 0,
			updatedAt: now
		})
		.where(
			and(
				eq(publishTargets.id, id),
				isNull(publishTargets.remotePostId),
				or(
					inArray(publishTargets.status, ['pending', 'scheduled', 'failed']),
					and(eq(publishTargets.status, 'publishing'), lte(publishTargets.updatedAt, stale))
				)
			)
		)
		.returning({ id: publishTargets.id });
	if (!updated.length) {
		const latest = await first(
			ctx.db.select().from(publishTargets).where(eq(publishTargets.id, id))
		);
		if (latest?.remotePostId) invalid('Already published', 409);
		invalid('Already publishing', 409);
	}
	await refreshDraftStatus(ctx.db, target.draftId);
	return { ok: true as const, scheduledFor: runAt.toISOString() };
}

// The shape saveMediaBytes mints; anything else fails the serving route's key check.
const ALLOWED_MEDIA_EXTENSIONS = new Set(['jpg', 'png', 'webp', 'gif', 'mp4']);
// 12 bound parameters per media row; D1 caps a query at 100.
const MEDIA_INSERT_CHUNK = 8;
const VARIANT_PLATFORMS = new Set(['mastodon', 'bluesky', 'linkedin', 'threads', 'instagram', 'x']);
const VISIBILITIES = new Set(['public', 'unlisted', 'private', 'direct']);

/**
 * Copy a stored video in storage, without reading it into the isolate (a
 * 300 MB file would not fit), then read back what was copied: the source row
 * is not trusted. Its cover comes along. Null when there is nothing playable
 * to copy, in which case nothing is left behind.
 */
async function copyVideo(
	store: OperationContext['media'],
	item: { storageKey: string; metaJson: string | null },
	storageKey: string
): Promise<{ size: number; facts: Mp4Facts; meta: StoredVideoMeta } | null> {
	if (!store.copy || !store.size) return null;
	if (!(await store.copy(item.storageKey, storageKey))) return null;
	try {
		const size = (await store.size(storageKey)) ?? 0;
		const facts = await probeStoredVideo(store, storageKey, size);
		if (!facts?.videoCodec || size <= 0 || size > MAX_VIDEO_BYTES) throw new Error('unplayable');
		const meta = videoMetaFrom(facts);
		const cover = parseJson<Partial<StoredVideoMeta>>(item.metaJson, {}).cover;
		if (cover && (await store.copy(coverKey(item.storageKey), coverKey(storageKey)))) {
			meta.cover = cover;
		}
		return { size, facts, meta };
	} catch {
		await deleteMediaObjects(store, [storageKey]).catch(() => {});
		return null;
	}
}

/**
 * An image's preview and JPEG copy come along when the store can copy them;
 * otherwise the copy shows the original, and Instagram asks for it again.
 */
async function copyImageVariants(
	store: OperationContext['media'],
	item: { storageKey: string; metaJson: string | null },
	storageKey: string
): Promise<StoredImageMeta | null> {
	const stored = parseJson<StoredImageMeta>(item.metaJson, {});
	const copied: StoredImageMeta = {};
	const variants = [
		['preview', previewKey],
		['jpeg', jpegKey]
	] as const;
	for (const [name, keyOf] of variants) {
		const variant = stored[name];
		if (!variant || !store.copy) continue;
		try {
			if (await store.copy(keyOf(item.storageKey), keyOf(storageKey))) copied[name] = variant;
		} catch {
			// The original is still copied; this variant is just left behind.
		}
	}
	return Object.keys(copied).length ? copied : null;
}

export async function listDrafts(ctx: OperationContext, userId: string, requestedLimit?: number) {
	const limit = Number.isFinite(requestedLimit)
		? Math.min(DRAFTS_LIST_MAX_LIMIT, Math.max(1, Math.floor(requestedLimit!)))
		: DRAFTS_LIST_LIMIT;
	const rows = await ctx.db
		.select()
		.from(drafts)
		.where(eq(drafts.userId, userId))
		.orderBy(desc(drafts.updatedAt))
		.limit(limit + 1);
	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;
	type VariantRow = InferSelectModel<typeof draftVariants>;
	type MediaRow = InferSelectModel<typeof draftMedia>;
	type TargetRow = InferSelectModel<typeof publishTargets>;
	const ids = page.map((draft) => draft.id);
	const variants: VariantRow[] = [];
	const media: MediaRow[] = [];
	const targets: TargetRow[] = [];
	for (const chunk of chunkIds(ids)) {
		const [variantRows, mediaRows, targetRows] = (await batchQueries(ctx.db, [
			ctx.db.select().from(draftVariants).where(inArray(draftVariants.draftId, chunk)),
			ctx.db.select().from(draftMedia).where(inArray(draftMedia.draftId, chunk)),
			ctx.db.select().from(publishTargets).where(inArray(publishTargets.draftId, chunk))
		])) as [VariantRow[], MediaRow[], TargetRow[]];
		variants.push(...variantRows);
		media.push(...mediaRows);
		targets.push(...targetRows);
	}
	const connectionIds = [...new Set(targets.map((target) => target.connectionId))];
	const connectionRows: Array<
		Pick<InferSelectModel<typeof connections>, 'id' | 'platform' | 'handle' | 'displayName'>
	> = [];
	for (const chunk of chunkIds(connectionIds)) {
		connectionRows.push(
			...(await ctx.db
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
	const connectionById = new Map(connectionRows.map((connection) => [connection.id, connection]));
	const variantsByDraft = new Map<string, VariantRow[]>();
	const mediaByDraft = new Map<string, MediaRow[]>();
	const targetsByDraft = new Map<
		string,
		Array<TargetRow & { connection?: (typeof connectionRows)[number] }>
	>();
	for (const variant of variants)
		variantsByDraft.set(variant.draftId, [
			...(variantsByDraft.get(variant.draftId) ?? []),
			variant
		]);
	for (const item of media)
		mediaByDraft.set(item.draftId, [...(mediaByDraft.get(item.draftId) ?? []), item]);
	for (const target of targets)
		targetsByDraft.set(target.draftId, [
			...(targetsByDraft.get(target.draftId) ?? []),
			{ ...target, connection: connectionById.get(target.connectionId) }
		]);
	return {
		drafts: page.map((draft) =>
			serializeDraft(draft, {
				variants: variantsByDraft.get(draft.id) ?? [],
				media: mediaByDraft.get(draft.id) ?? [],
				targets: targetsByDraft.get(draft.id) ?? []
			})
		),
		hasMore
	};
}

export async function createDraft(
	ctx: OperationContext,
	userId: string,
	input: Record<string, unknown>
) {
	const selected = normalizeSelectedConnectionIds(input.selectedConnectionIds);
	if (!selected.ok) invalid(selected.error);
	const title = parseDraftTitle(input.title ?? null);
	if (!title.ok) invalid(title.error);
	const body = parseDraftBody(input.baseBody ?? '');
	if (!body.ok) invalid(body.error);
	const now = new Date();
	const [draft] = await ctx.db
		.insert(drafts)
		.values({
			id: newId(),
			userId,
			title: title.value,
			baseBody: body.value,
			...(selected.value !== undefined ? { selectedConnectionIds: selected.value } : {}),
			status: 'draft',
			createdAt: now,
			updatedAt: now
		})
		.returning();
	return { draft: serializeDraft(draft, { variants: [], media: [], targets: [] }) };
}

/**
 * Media is copied to new R2 keys: deleting a draft removes its objects, so
 * shared keys would let deleting one copy break the other. Targets are not
 * copied; the clone starts as a plain draft.
 */
export async function duplicateDraft(ctx: OperationContext, userId: string, draftId: string) {
	const source = await first(
		ctx.db
			.select()
			.from(drafts)
			.where(and(eq(drafts.id, draftId), eq(drafts.userId, userId)))
	);
	if (!source) invalid('Not found', 404);
	const variants = await ctx.db
		.select()
		.from(draftVariants)
		.where(eq(draftVariants.draftId, source.id));
	const media = await ctx.db.select().from(draftMedia).where(eq(draftMedia.draftId, source.id));
	const now = new Date();
	const newDraftId = newId();
	const savedKeys: string[] = [];
	try {
		const [draft] = await ctx.db
			.insert(drafts)
			.values({
				id: newDraftId,
				userId,
				title: source.title,
				baseBody: source.baseBody,
				selectedConnectionIds: source.selectedConnectionIds,
				status: 'draft',
				createdAt: now,
				updatedAt: now
			})
			.returning();
		const newVariants = variants.length
			? await ctx.db
					.insert(draftVariants)
					.values(
						variants.map((variant) => ({
							id: newId(),
							draftId: newDraftId,
							platform: variant.platform,
							body: variant.body,
							optionsJson: variant.optionsJson,
							createdAt: now,
							updatedAt: now
						}))
					)
					.returning()
			: [];
		// A missing object skips that attachment rather than failing the copy.
		const mediaValues: Array<typeof draftMedia.$inferInsert> = [];
		for (const item of media) {
			// The row is not trusted: re-check the key shape and what is stored.
			let extension: string;
			try {
				extension = assertSafeStorageKey(item.storageKey).split('.').pop() ?? '';
			} catch {
				continue;
			}
			if (!ALLOWED_MEDIA_EXTENSIONS.has(extension)) continue;
			const storageKey = `${Date.now()}-${randomHex(8)}.${extension}`;
			if ((item.mime || '').toLowerCase().startsWith('video/')) {
				const copied = await copyVideo(ctx.media, item, storageKey);
				if (!copied) continue;
				savedKeys.push(storageKey);
				mediaValues.push({
					id: newId(),
					draftId: newDraftId,
					storageKey,
					mime: 'video/mp4',
					size: copied.size,
					width: copied.facts.width,
					height: copied.facts.height,
					metaJson: JSON.stringify(copied.meta),
					altText: item.altText,
					sortOrder: item.sortOrder,
					segmentIndex: item.segmentIndex,
					createdAt: now
				});
				continue;
			}
			const bytes = await ctx.media.get(item.storageKey);
			if (!bytes) continue;
			const validated = validateImageUpload({ mime: item.mime, size: bytes.length, bytes });
			if (!validated.ok) continue;
			await ctx.media.put(storageKey, bytes, validated.mime);
			savedKeys.push(storageKey);
			const imageMeta = await copyImageVariants(ctx.media, item, storageKey);
			mediaValues.push({
				id: newId(),
				draftId: newDraftId,
				storageKey,
				mime: validated.mime,
				size: bytes.length,
				width: item.width,
				height: item.height,
				metaJson: imageMeta ? JSON.stringify(imageMeta) : null,
				altText: item.altText,
				sortOrder: item.sortOrder,
				segmentIndex: item.segmentIndex,
				createdAt: now
			});
		}
		const newMedia = [];
		for (let index = 0; index < mediaValues.length; index += MEDIA_INSERT_CHUNK) {
			newMedia.push(
				...(await ctx.db
					.insert(draftMedia)
					.values(mediaValues.slice(index, index + MEDIA_INSERT_CHUNK))
					.returning())
			);
		}
		return {
			draft: serializeDraft(draft, { variants: newVariants, media: newMedia, targets: [] })
		};
	} catch (error) {
		await deleteMediaObjects(ctx.media, savedKeys).catch(() => {});
		await ctx.db
			.delete(drafts)
			.where(eq(drafts.id, newDraftId))
			.catch(() => {});
		throw error;
	}
}

// Bad options would otherwise surface only at publish, as a provider error. Mirrors provider.validate.
function validateVariantOptions(options: unknown): string | null {
	if (options === undefined) return null;
	if (!options || typeof options !== 'object' || Array.isArray(options))
		return 'options must be an object';
	const value = options as Record<string, unknown>;
	if (value.visibility !== undefined && !VISIBILITIES.has(String(value.visibility)))
		return 'Invalid visibility';
	if (value.poll !== undefined && value.poll !== null) {
		const poll = validatePollConfig(value.poll);
		if (!poll.ok) return poll.error;
	}
	if (
		value.threadSegments !== undefined &&
		(!Array.isArray(value.threadSegments) ||
			value.threadSegments.some((segment) => typeof segment !== 'string'))
	)
		return 'threadSegments must be an array of strings';
	return null;
}

async function ensureDraftEditable(ctx: OperationContext, draftId: string) {
	const targets = await ctx.db
		.select()
		.from(publishTargets)
		.where(eq(publishTargets.draftId, draftId));
	const blocked = draftEditBlock(targets);
	if (blocked) invalid(blocked, 409);
}

export async function setDraftVariant(
	ctx: OperationContext,
	userId: string,
	draftId: string,
	input: unknown
) {
	const draft = await first(
		ctx.db
			.select()
			.from(drafts)
			.where(and(eq(drafts.id, draftId), eq(drafts.userId, userId)))
	);
	if (!draft) invalid('Not found', 404);
	await ensureDraftEditable(ctx, draftId);
	if (!input || typeof input !== 'object') invalid('Invalid JSON body');
	const fields = input as Record<string, unknown>;
	const optionsError = validateVariantOptions(fields.options);
	if (optionsError) invalid(optionsError);
	const options =
		fields.options && typeof fields.options === 'object'
			? (fields.options as Record<string, unknown>)
			: {};
	const segments = parseThreadSegments(options.threadSegments ?? []);
	if (!segments.ok) invalid(segments.error);
	if (fields.body !== undefined) {
		const body = parseSegmentBody(fields.body);
		if (!body.ok) invalid(body.error);
	}
	const platform = String(fields.platform || '');
	if (!VARIANT_PLATFORMS.has(platform))
		invalid('platform must be mastodon, bluesky, linkedin, threads, instagram, or x');
	const existing = await first(
		ctx.db
			.select()
			.from(draftVariants)
			.where(and(eq(draftVariants.draftId, draftId), eq(draftVariants.platform, platform)))
	);
	const now = new Date();
	const optionsJson =
		fields.options !== undefined
			? JSON.stringify(fields.options ?? {})
			: (existing?.optionsJson ?? '{}');
	// Bound the whole column: many full-length thread segments would be a driver error, not a 400.
	if (optionsJson.length > MAX_VARIANT_OPTIONS_LENGTH)
		invalid(
			`Variant options are too large to save (${optionsJson.length} characters, max ${MAX_VARIANT_OPTIONS_LENGTH})`
		);
	const variant = existing
		? (
				await ctx.db
					.update(draftVariants)
					.set({
						body: fields.body !== undefined ? (fields.body as string | null) : existing.body,
						optionsJson,
						updatedAt: now
					})
					.where(eq(draftVariants.id, existing.id))
					.returning()
			)[0]
		: (
				await ctx.db
					.insert(draftVariants)
					.values({
						id: newId(),
						draftId,
						platform,
						body: (fields.body ?? null) as string | null,
						optionsJson,
						createdAt: now,
						updatedAt: now
					})
					.returning()
			)[0];
	return { variant: serializeVariant(variant) };
}

export async function deleteDraftVariant(
	ctx: OperationContext,
	userId: string,
	draftId: string,
	platform: string | null
) {
	const draft = await first(
		ctx.db
			.select()
			.from(drafts)
			.where(and(eq(drafts.id, draftId), eq(drafts.userId, userId)))
	);
	if (!draft) invalid('Not found', 404);
	await ensureDraftEditable(ctx, draftId);
	if (!platform) invalid('platform required');
	await ctx.db
		.delete(draftVariants)
		.where(and(eq(draftVariants.draftId, draftId), eq(draftVariants.platform, platform)));
	return { ok: true as const };
}

/** Left for the next scheduler tick because this request's call budget might not cover it. */
function queuedResult(
	targetId: string,
	conn: { id: string; platform: string; handle: string | null; displayName: string | null }
) {
	return {
		targetId,
		connectionId: conn.id,
		platform: conn.platform,
		handle: conn.handle,
		displayName: conn.displayName,
		status: 'pending',
		permalink: null,
		error: null,
		skipped: true,
		deferred: true
	};
}

export async function publishDraft(
	ctx: OperationContext,
	userId: string,
	draftId: string,
	requestBody: unknown
) {
	const deadline = Date.now() + INLINE_PUBLISH_MS;
	const draft = await first(
		ctx.db
			.select()
			.from(drafts)
			.where(and(eq(drafts.id, draftId), eq(drafts.userId, userId)))
	);
	if (!draft) invalid('Not found', 404);
	if (!requestBody || typeof requestBody !== 'object') invalid('Invalid JSON body');
	const connectionIdsInput = (requestBody as Record<string, unknown>).connectionIds;
	if (connectionIdsOverflow(connectionIdsInput)) invalid('Too many connections (max 10)');
	const connectionIds = normalizeConnectionIds(connectionIdsInput);
	if (!connectionIds.length) invalid('connectionIds required');
	const userConnections = await ctx.db
		.select()
		.from(connections)
		.where(
			and(
				eq(connections.userId, userId),
				inArray(connections.id, connectionIds),
				eq(connections.status, 'active')
			)
		);
	if (userConnections.length !== connectionIds.length) invalid('One or more connections not found');
	// Refuse concurrent publishes of the same connections. Already-published ones pass
	// through as skipped, so re-posting a partly published draft still works.
	const now = new Date();
	const classified = await classifyConnections(ctx.db, draftId, userConnections, now);
	const inFlight = classified
		.filter((item) => item.kind === 'inFlight')
		.map((item) => item.connectionId);
	if (inFlight.length) invalid('Already publishing', 409, { inFlight });
	const published = new Set(
		classified.filter((item) => item.kind === 'published').map((item) => item.connectionId)
	);
	await refuseUnfitForInstagram(
		ctx,
		draftId,
		userConnections.filter((row) => !published.has(row.id))
	);
	const ensured = await ensureTargets(ctx.db, draftId, userConnections, 'now', null, now);
	const results = [];
	let stopped: string | null = null;
	// Once one target is left for the scheduler, the rest follow it.
	let deferring = false;
	let attempted = 0;
	for (const item of ensured) {
		const connection = userConnections.find((row) => row.id === item.target.connectionId);
		if (!connection) continue;
		if (item.alreadyPublished) {
			results.push({
				targetId: item.target.id,
				connectionId: connection.id,
				platform: connection.platform,
				handle: connection.handle,
				displayName: connection.displayName,
				status: 'published',
				permalink: item.target.remoteUrl ?? null,
				error: null,
				skipped: true
			});
			continue;
		}
		if (item.inFlight) {
			results.push({
				targetId: item.target.id,
				connectionId: connection.id,
				platform: connection.platform,
				handle: connection.handle,
				displayName: connection.displayName,
				status: 'publishing',
				permalink: null,
				error: null,
				skipped: true,
				inFlight: true
			});
			continue;
		}
		if (deferring) {
			results.push(queuedResult(item.target.id, connection));
			continue;
		}
		try {
			const task = publishTarget(ctx.db, ctx.env, ctx.media, item.target.id, {
				budget: ctx.budget,
				mustTry: attempted === 0,
				deadline
			});
			// Keeps the publish running if the client disconnects mid-request.
			ctx.waitUntil?.(task.then(() => undefined).catch(() => undefined));
			const result = await task;
			if (result.deferred) {
				deferring = true;
				results.push(queuedResult(item.target.id, connection));
				continue;
			}
			attempted += 1;
			const row = await first(
				ctx.db.select().from(publishTargets).where(eq(publishTargets.id, item.target.id))
			);
			results.push({
				targetId: item.target.id,
				connectionId: connection.id,
				platform: connection.platform,
				handle: connection.handle,
				displayName: connection.displayName,
				status: result.status,
				permalink: row?.remoteUrl ?? null,
				error: result.error ?? row?.errorMessage ?? null,
				skipped: result.skipped ?? false
			});
		} catch (error) {
			// Infrastructure, not the provider (usually D1's per-invocation limit): the next
			// target would fail too, so stop and report what did publish instead of a 500.
			console.error('[publish] aborted', item.target.id, error);
			stopped =
				humanizedCause(error instanceof Error ? error.message : String(error)) ??
				'Publishing stopped early — try again for the rest';
			break;
		}
	}
	const draftAfter = await first(ctx.db.select().from(drafts).where(eq(drafts.id, draftId)));
	const targets = await ctx.db
		.select()
		.from(publishTargets)
		.where(eq(publishTargets.draftId, draftId));
	return {
		results,
		...(stopped !== null ? { stopped: true, stoppedError: stopped } : {}),
		draft: draftAfter
			? serializeDraft(draftAfter, {
					targets: targets.map((target) => {
						const connection = userConnections.find((row) => row.id === target.connectionId);
						return {
							...target,
							connection: connection
								? { id: connection.id, platform: connection.platform, handle: connection.handle }
								: undefined
						};
					})
				})
			: null
	};
}

export function listConnections(ctx: OperationContext, userId: string) {
	return loadConnectionList(ctx.db, ctx.env, userId);
}

export async function getDraft(ctx: OperationContext, userId: string, draftId: string) {
	const draft = await loadOwnedDraft(ctx.db, draftId, userId);
	if (!draft) invalid('Not found', 404);
	return { draft };
}

export async function deleteDraft(ctx: OperationContext, userId: string, draftId: string) {
	const existing = await first(
		ctx.db
			.select()
			.from(drafts)
			.where(and(eq(drafts.id, draftId), eq(drafts.userId, userId)))
	);
	if (!existing) invalid('Not found', 404);
	const liveTargets = await ctx.db
		.select()
		.from(publishTargets)
		.where(eq(publishTargets.draftId, draftId));
	// Deleting mid-publish would orphan the remote post and race media cleanup.
	if (draftHasInFlightPublish(liveTargets))
		invalid('Publishing in progress — try again shortly', 409);
	const files = await ctx.db.select().from(draftMedia).where(eq(draftMedia.draftId, draftId));
	// Objects before the row: a crash in between leaves a retryable row, not orphaned bytes.
	await deleteMediaObjects(
		ctx.media,
		files.map((file) => file.storageKey)
	);
	await ctx.db.delete(drafts).where(eq(drafts.id, draftId));
	return { ok: true as const };
}

export function listQueue(ctx: OperationContext, userId: string, limit: number) {
	return loadQueueList(ctx.db, userId, limit);
}

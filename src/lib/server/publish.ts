import { and, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { isLocalAppUrl } from '$lib/domain/app-url';
import { safeHttpUrl } from '$lib/domain/links';
import { LEASE_REFRESH_MS, STALE_CLAIM_MS } from '$lib/domain/due-jobs';
import type { PublishResult } from '$lib/server/providers/types';
import {
	isThreadsAuthFailure,
	isThreadsMediaFetchFailure,
	parseThreadsMetaMarker
} from '$lib/domain/threads-error';
import { decodeImageDimensions } from './image-dimensions';
import { parsePollConfig } from '$lib/domain/poll';
import { signPublicMediaUrl } from './public-media';
import { resolvePublishSegments } from '$lib/domain/thread-segments';
import { targetRecordKey } from '$lib/domain/tid';
import { decryptJson, encryptJson } from './crypto';
import { chunkIds, first, newId, parseJson, type AppDb } from './db/client';
import {
	connections,
	draftMedia,
	drafts,
	draftVariants,
	publishAttempts,
	publishTargets
} from './db/schema';
import type { AppEnv } from './env';
import {
	classifyProviderError,
	estimateKeyFor,
	providerFor,
	ProviderError,
	PublishPartialError,
	UNCONFIRMED_POST_MARK,
	ZERNIO_MAX_POLLS,
	type ConnectionCredentials,
	type FetchLike,
	type PublishCheckpoint,
	type MediaStore,
	type NormalizedPost
} from './providers';
import { providerFetch } from './providers/timed-fetch';
import { countingFetch, type SubrequestBudget } from './budget';

/** Scheduler stops auto-retrying a target after this many claims; manual retry stays available. */
export const MAX_PUBLISH_ATTEMPTS = 5;

// Exponential backoff for retryable failures: 1m, 2m, 4m, 8m … capped at 30m.
// Without this, a 429 parks as past-due `scheduled` and the next tick hammers
// the provider immediately, burning all 5 attempts in seconds.
export function retryDelayMs(attempt: number): number {
	return Math.min(60_000 * 2 ** Math.max(0, attempt - 1), 30 * 60_000);
}

/**
 * Should this failure expire the connection? Typed 403 (forbidden) must
 * NOT: the credential was accepted but the action was refused
 * (policy/permission). Legacy regex keeps 401-shape matching for untyped
 * errors; 403/forbidden were deliberately removed from it. Meta permission
 * failures arrive as HTTP 400, so status-based matching never sees them —
 * isThreadsPermissionFailure covers that Threads-scoped shape below.
 */
export function isThreadsPermissionFailure(message: string): boolean {
	return isThreadsAuthFailure(message);
}

/**
 * A Threads failure carrying a parsed `[meta code[.subcode]]` marker is
 * ground truth: only codes 190/200 mean the credential died. This matters
 * because unrelated Threads content errors contain auth-looking words —
 * 4279004 says the carousel children are "invalid, non-existent or
 * expired", and the generic "expired" regex used to mark a perfectly good
 * account expired. Markerless messages keep the legacy regex rules.
 */
export function isAuthFailure(err: unknown, message: string): boolean {
	const classified = classifyProviderError(err);
	if (classified.code === 'auth') return true;
	if (classified.code !== undefined) return false;
	// Container processing failures are content/transient errors, never
	// credential ones: the word "expired" in an EXPIRED container status must
	// not expire a healthy account.
	if (/^Threads media container /i.test(message)) return false;
	if (parseThreadsMetaMarker(message)) return isThreadsAuthFailure(message);
	return (
		/401|unauthorized|invalid credentials|expired/i.test(message) ||
		isThreadsPermissionFailure(message)
	);
}

/**
 * Should this failure auto-retry with backoff? Structured codes decide when
 * present; otherwise legacy message matching applies unchanged (so an
 * unclassified 500 stays retryable exactly as before).
 */
export function isFailureRetryable(err: unknown, message: string): boolean {
	const classified = classifyProviderError(err);
	if (classified.code) return classified.retryable === true;
	return isRetryableError(message);
}

/**
 * Retryable failures stay claimable — the target is rescheduled with backoff
 * by markFailed below, so a scheduler tick finishes it without the user
 * clicking Retry. Only non-retryable failures (auth, content limits, policy)
 * park as `failed`. An exhausted attempt budget also parks (caller decides).
 */
export function statusAfterFailedPublish(opts: {
	retryable: boolean;
	scheduledFor?: Date | string | null;
	now?: Date;
}): 'scheduled' | 'failed' {
	return opts.retryable ? 'scheduled' : 'failed';
}

export async function buildNormalizedPost(
	db: AppDb,
	draftId: string,
	platform: string
): Promise<NormalizedPost> {
	const draft = await first(db.select().from(drafts).where(eq(drafts.id, draftId)));
	if (!draft) throw new Error('Draft not found');
	const variants = await db.select().from(draftVariants).where(eq(draftVariants.draftId, draftId));
	const media = await db.select().from(draftMedia).where(eq(draftMedia.draftId, draftId));
	media.sort((a, b) => a.sortOrder - b.sortOrder);

	const variant = variants.find((v) => v.platform === platform);
	const body = variant?.body ?? draft.baseBody;
	const options = parseJson<Record<string, unknown>>(variant?.optionsJson, {});

	const toAttachment = (m: (typeof media)[number]) => ({
		storageKey: m.storageKey,
		mime: m.mime,
		size: m.size,
		alt: m.altText || undefined,
		width: m.width ?? undefined,
		height: m.height ?? undefined
	});

	const mediaForSegment = (segmentIndex: number) =>
		media.filter((m) => (m.segmentIndex ?? 0) === segmentIndex).map(toAttachment);
	const segmentHasMedia = (segmentIndex: number) =>
		media.some((m) => (m.segmentIndex ?? 0) === segmentIndex);

	const postOptions: NonNullable<NormalizedPost['options']> = {
		visibility:
			options.visibility === 'unlisted' ||
			options.visibility === 'private' ||
			options.visibility === 'direct' ||
			options.visibility === 'public'
				? options.visibility
				: 'public',
		spoilerText: typeof options.spoilerText === 'string' ? options.spoilerText : undefined,
		langs: Array.isArray(options.langs) ? (options.langs as string[]) : undefined,
		poll: parsePollConfig(options.poll) ?? undefined
	};

	const segmentsOpt = options.threadSegments as string[] | undefined;
	if (segmentsOpt && segmentsOpt.length > 1) {
		const thread = segmentsOpt.map((text, i) => {
			const segMedia = mediaForSegment(i);
			return { text, media: segMedia.length ? segMedia : undefined, options: postOptions };
		});
		return {
			text: segmentsOpt[0] || '',
			media: mediaForSegment(0).length ? mediaForSegment(0) : undefined,
			thread,
			options: postOptions
		};
	}

	const resolved = resolvePublishSegments(body, segmentHasMedia);
	if (resolved.length > 1) {
		const thread = resolved.map(({ text, segmentIndex }) => {
			const segMedia = mediaForSegment(segmentIndex);
			return { text, media: segMedia.length ? segMedia : undefined, options: postOptions };
		});
		const firstMedia = mediaForSegment(resolved[0].segmentIndex);
		return {
			text: resolved[0].text,
			media: firstMedia.length ? firstMedia : undefined,
			thread,
			options: postOptions
		};
	}

	const only = resolved[0];
	const singleMedia = mediaForSegment(only.segmentIndex);
	return {
		text: only.text,
		media: singleMedia.length ? singleMedia : undefined,
		options: postOptions
	};
}

const isVideoMedia = (m: { mime?: string | null }): boolean =>
	(m.mime ?? '').toLowerCase().startsWith('video/');

async function hydrateMedia(content: NormalizedPost, store: MediaStore): Promise<NormalizedPost> {
	const fill = async (post: NormalizedPost): Promise<NormalizedPost> => {
		const media = post.media
			? await Promise.all(
					post.media.map(async (m) => {
						let next = m;
						if (!next.bytes && next.storageKey) {
							const bytes = await store.get(next.storageKey);
							if (bytes) next = { ...next, bytes };
						}
						// Backfill dims for rows uploaded before width/height were stored.
						// Correct dims fix Bluesky letterboxing; omit when undecodable.
						if (
							(!next.width || !next.height) &&
							next.bytes &&
							!(next.mime || '').toLowerCase().startsWith('video/')
						) {
							try {
								const dims = decodeImageDimensions(next.bytes);
								if (dims) next = { ...next, width: dims.width, height: dims.height };
							} catch {
								/* omit */
							}
						}
						return next;
					})
				)
			: undefined;
		const thread = post.thread ? await Promise.all(post.thread.map(fill)) : undefined;
		return { ...post, media, thread };
	};
	return fill(content);
}
/**
 * URL handed to providers that fetch media server-side (Threads). A
 * configured public media origin (an R2 custom domain behind Cloudflare
 * cache, for example) is served directly: no Worker hop and no signature to
 * mint, and the CDN absorbs Meta's repeated crawls. Keys carry 64 bits of
 * randomness, so unguessable URLs are the access control there — and those URLs
 * never expire, so a leaked one stays valid. Without it, fall back to the
 * short-lived signed Worker route.
 */
export function publicMediaUrlFor(env: AppEnv, storageKey: string): Promise<string> | string {
	const base = httpsBaseUrl(env.MEDIA_PUBLIC_BASE_URL);
	if (base) return `${base}/${encodeURIComponent(storageKey)}`;
	return signPublicMediaUrl(env.APP_ENCRYPTION_KEY, env.APP_URL, storageKey);
}

/** Normalized https origin, or null when unset/malformed (fall back). */
function httpsBaseUrl(raw: string | undefined): string | null {
	const value = raw?.trim().replace(/\/+$/, '');
	if (!value) return null;
	try {
		return new URL(value).protocol === 'https:' ? value : null;
	} catch {
		return null;
	}
}

/**
 * Roughly how many subrequests publishing this content will take from here:
 * the database writes around the publish, a storage read per attachment the
 * platform is sent as bytes, and the platform's own calls (uploads, status
 * polls, the post itself). An estimate, deliberately generous — it only decides
 * whether a second or later target in one request starts now or on the next
 * tick.
 */
export function publishCallEstimate(platform: string, content: NormalizedPost): number {
	const segments = content.thread && content.thread.length > 0 ? content.thread : [content];
	const media = segments.flatMap((s) => s.media ?? []);
	const images = media.filter((m) => !isVideoMedia(m));
	const videos = media.filter(isVideoMedia);
	const hasLink = (s: NormalizedPost) => /https?:\/\//i.test(s.text || '');
	// Claim, connection, attempt row, resume lookup, success, attempt summary
	// and draft status, a checkpoint per segment, and one more for whichever of
	// a credential write, a lease renewal or a connection-status fix happens.
	const database = 8 + segments.length;
	// One read per attachment, except where the platform is handed URLs instead
	// (PlatformProvider.mediaByUrl): then publish reads nothing from storage.
	let storage = media.length;
	let platformCalls = 1;
	switch (platform) {
		case 'x':
			for (const m of images) {
				const chunks = Math.max(1, Math.ceil((m.size ?? m.bytes?.length ?? 0) / 5_000_000));
				// init + appends + finalize + up to two alt-text calls, and status
				// polls for a GIF.
				platformCalls += 4 + chunks + ((m.mime || '').toLowerCase() === 'image/gif' ? 5 : 0);
			}
			platformCalls += segments.length;
			break;
		case 'mastodon':
			// Upload, plus a couple of polls while the instance processes it.
			platformCalls += images.length * 3 + segments.length;
			break;
		case 'bluesky':
			platformCalls += images.length + segments.length;
			// A link card: page fetch (and a redirect), image fetch, blob upload.
			platformCalls += segments.filter((s) => !(s.media ?? []).length && hasLink(s)).length * 4;
			break;
		case 'linkedin':
			platformCalls += images.length * 2 + 1;
			for (const v of videos) {
				platformCalls += 2 + Math.max(1, Math.ceil((v.size ?? v.bytes?.length ?? 0) / 4_194_304));
			}
			if (!media.length && hasLink(content)) platformCalls += 5;
			break;
		case 'threads':
			// Container, a couple of status polls and the publish per post; a
			// carousel adds a container and polls per item; the permalink lookup
			// and the identity check run once.
			platformCalls += segments.length * 4 + images.length * 3 + 4;
			storage = 0;
			break;
		case 'zernio':
			// One create and the status polls; media travels as URLs, so there
			// are no uploads and no storage reads.
			platformCalls += ZERNIO_MAX_POLLS;
			storage = 0;
			break;
		default:
			platformCalls += segments.length * 3 + media.length * 3;
	}
	return database + storage + platformCalls;
}

/** Calls the caller still needs after a publish returns (reads for the
 *  response, the draft status, the failure digest on a tick). */
export const PUBLISH_RESERVE_CALLS = 6;

export async function publishTarget(
	db: AppDb,
	env: AppEnv,
	store: MediaStore,
	targetId: string,
	options: {
		fetchImpl?: FetchLike;
		now?: Date;
		/** Counts this request's subrequests; see $lib/server/budget. */
		budget?: SubrequestBudget | null;
		/** The first target of a request always runs, whatever the budget says:
		 *  deferring it would only defer it again on every tick. */
		mustTry?: boolean;
	} = {}
): Promise<{
	status: string;
	remotePostId?: string;
	error?: string;
	skipped?: boolean;
	/** Not started: it might not finish inside this request's budget. The row
	 *  is untouched and still due, so the next tick publishes it. */
	deferred?: boolean;
}> {
	const now = options.now ?? new Date();
	const target = await first(
		db.select().from(publishTargets).where(eq(publishTargets.id, targetId))
	);
	if (!target) return { status: 'failed', error: 'Target not found' };
	// `published` is the authoritative signal, not the id: a provider that
	// answers 200 without an id (or a response we cannot parse) still published
	// the post, and reposting it because the id is missing is far worse than a
	// row without a permalink.
	if (target.status === 'published' || target.remotePostId) {
		return { status: 'published', remotePostId: target.remotePostId ?? undefined, skipped: true };
	}
	if (target.status === 'cancelled') {
		return { status: 'cancelled', error: 'Target cancelled' };
	}

	// Fail fast when the stored credential cannot possibly work (expired
	// token with no refresh path): mark the connection expired and park the
	// target WITHOUT burning an attempt. The WHERE excludes scheduled rows
	// so future schedules are never touched here.
	let knownPlatform: string | null = null;
	let knownEstimateKey: string | null = null;
	try {
		const preConn = await first(
			db.select().from(connections).where(eq(connections.id, target.connectionId))
		);
		if (preConn) {
			knownPlatform = preConn.platform;
			knownEstimateKey = estimateKeyFor(preConn);
			const provider = providerFor(preConn);
			const reason = provider.refreshImpossibleReason?.(
				await decryptJson<ConnectionCredentials>(
					preConn.credentialsEncrypted,
					env.APP_ENCRYPTION_KEY
				)
			);
			if (reason) {
				await db
					.update(connections)
					.set({ status: 'expired', updatedAt: now })
					.where(eq(connections.id, preConn.id));
				const parked = await db
					.update(publishTargets)
					.set({ status: 'failed', errorMessage: reason, jobId: null, updatedAt: now })
					.where(
						and(
							eq(publishTargets.id, targetId),
							isNull(publishTargets.remotePostId),
							inArray(publishTargets.status, ['pending', 'failed'])
						)
					)
					.returning({ id: publishTargets.id });
				// A concurrent claim may have moved the row (publishing /
				// published): only short-circuit when we actually parked it.
				if (parked.length) {
					await refreshDraftStatus(db, target.draftId);
					return { status: 'failed', error: reason };
				}
			}
		}
	} catch {
		// Any unexpected failure here (bad ciphertext, unknown platform)
		// falls through to the normal claim flow, which handles it.
	}

	// Built before the claim when there is a budget to check it against, so a
	// target that would not fit is left exactly as it was. Reused below.
	let prebuilt: NormalizedPost | null = null;
	if (options.budget && !options.mustTry && knownPlatform) {
		try {
			prebuilt = await buildNormalizedPost(db, target.draftId, knownPlatform);
			const needed =
				publishCallEstimate(knownEstimateKey ?? knownPlatform, prebuilt) + PUBLISH_RESERVE_CALLS;
			if (options.budget.remaining < needed) {
				return { status: target.status, skipped: true, deferred: true };
			}
		} catch {
			// Nothing to estimate from (a missing draft): the normal path
			// below reports that properly.
			prebuilt = null;
		}
	}

	const claimedGeneration = target.attemptCount + 1;
	const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
	const claimed = await db
		.update(publishTargets)
		.set({
			status: 'publishing',
			attemptCount: claimedGeneration,
			updatedAt: now
		})
		.where(
			and(
				eq(publishTargets.id, targetId),
				eq(publishTargets.attemptCount, target.attemptCount),
				or(
					inArray(publishTargets.status, ['pending', 'failed']),
					and(eq(publishTargets.status, 'scheduled'), lte(publishTargets.scheduledFor, now)),
					and(
						eq(publishTargets.status, 'publishing'),
						isNull(publishTargets.remotePostId),
						lte(publishTargets.updatedAt, staleBefore)
					)
				)
			)
		)
		.returning({ id: publishTargets.id });

	if (!claimed.length) {
		const latest = await first(
			db.select().from(publishTargets).where(eq(publishTargets.id, targetId))
		);
		if (latest?.status === 'published' || latest?.remotePostId) {
			return {
				status: 'published',
				remotePostId: latest.remotePostId ?? undefined,
				skipped: true
			};
		}
		return { status: latest?.status ?? 'failed', skipped: true };
	}

	const conn = await first(
		db.select().from(connections).where(eq(connections.id, target.connectionId))
	);
	if (!conn) {
		await markFailed(db, targetId, target.draftId, null, 'Connection not found', claimedGeneration);
		return { status: 'failed', error: 'Connection not found' };
	}

	const attemptId = newId();
	await db.insert(publishAttempts).values({
		id: attemptId,
		publishTargetId: targetId,
		startedAt: new Date(),
		success: false
	});

	// Segment-level checkpoint: a Worker abort mid-thread leaves the target
	// claimed with no attempt summary, and the stale-claim reclaim would then
	// publish from segment 0 again (duplicate live posts). Persisting each
	// segment as it lands lets lastPartialResume pick up where it left off.
	// Best effort: a checkpoint write must never fail a live publish, and
	// markFailed overwrites the row with the authoritative partial summary.
	// Claim lease. The reclaim path treats a row whose updatedAt is older than
	// STALE_CLAIM_MS as dead, but only the claim ever wrote that timestamp: a
	// slow publish (multi-segment thread, several large uploads) could outlive
	// the window while still running, and an overlapping tick would then claim
	// the same row and post it twice. Renew while this publish is alive.
	// Throttled to LEASE_REFRESH_MS so a normal publish costs no extra writes.
	let leaseAt = Date.now();
	const renewLease = async () => {
		if (Date.now() - leaseAt < LEASE_REFRESH_MS) return;
		try {
			await db
				.update(publishTargets)
				.set({ updatedAt: new Date() })
				.where(
					and(
						eq(publishTargets.id, targetId),
						eq(publishTargets.status, 'publishing'),
						eq(publishTargets.attemptCount, claimedGeneration)
					)
				);
			leaseAt = Date.now();
		} catch {
			// Best effort: the success write is fenced on attemptCount, so a
			// missed renewal can only cost a redundant reclaim later.
		}
	};

	// A holder rather than a `let`: the assignment happens inside the callback,
	// which TypeScript's narrowing cannot see from the catch block below.
	const resumeState: { last: PublishCheckpoint | null } = { last: null };
	const checkpoint = async (state: PublishCheckpoint) => {
		resumeState.last = state;
		await renewLease();
		try {
			await db
				.update(publishAttempts)
				.set({
					responseSummary: JSON.stringify({
						segmentIds: state.segmentIds,
						segmentCids: state.segmentCids,
						remoteUrl: state.remoteUrl ?? null,
						checkpoint: true
					})
				})
				.where(eq(publishAttempts.id, attemptId));
		} catch {
			// Best effort only.
		}
	};

	try {
		const creds = await decryptJson<ConnectionCredentials>(
			conn.credentialsEncrypted,
			env.APP_ENCRYPTION_KEY
		);
		const meta = parseJson<{ maxCharacters?: number; handle?: string }>(conn.metaJson, {});
		const provider = providerFor(conn);
		const built = prebuilt ?? (await buildNormalizedPost(db, target.draftId, conn.platform));
		const content = provider.mediaByUrl ? built : await hydrateMedia(built, store);
		// A row uploaded before the feature was switched off (or on another
		// instance) must fail with something a person can act on.
		if (!env.videoUploadEnabled && (content.media ?? []).some(isVideoMedia)) {
			throw new Error('Video uploads are not enabled on this instance');
		}

		const issues = provider.validate(content, {
			maxCharacters: meta.maxCharacters,
			handle: meta.handle || conn.handle || undefined
		});
		if (issues.length) throw new Error(issues.map((i) => i.message).join('; '));

		const baseFetch = options.fetchImpl ?? providerFetch;
		const fetchImpl = options.budget ? countingFetch(baseFetch, options.budget) : baseFetch;
		let workingCreds = creds;
		if (provider.refreshIfNeeded) {
			workingCreds = await refreshWithStoredRetry(
				db,
				env,
				conn.id,
				conn.credentialsEncrypted,
				creds,
				(c) => provider.refreshIfNeeded!(c, fetchImpl)
			);
			// Most publishes refresh nothing; writing the same credentials back
			// would spend a call of the request's budget for no change.
			if (JSON.stringify(workingCreds) !== JSON.stringify(creds)) {
				await db
					.update(connections)
					.set({
						credentialsEncrypted: await encryptJson(workingCreds, env.APP_ENCRYPTION_KEY),
						updatedAt: new Date()
					})
					.where(eq(connections.id, conn.id));
			}
		}

		// Identity healing: reconcile stored credentials with the live one
		// (Threads: the user id GET /me reports). Persisting makes the
		// correction permanent instead of re-deriving it on every retry, and
		// proves the token works — so a stale `expired` flag clears too.
		if (provider.alignCredentials) {
			const aligned = await provider.alignCredentials(workingCreds, meta, fetchImpl);
			if (aligned) {
				workingCreds = aligned;
				await db
					.update(connections)
					.set({
						credentialsEncrypted: await encryptJson(aligned, env.APP_ENCRYPTION_KEY),
						status: 'active',
						updatedAt: new Date()
					})
					.where(eq(connections.id, conn.id));
			}
		}

		const resumeFrom = await lastPartialResume(db, targetId);
		// The upload-heavy part of a publish lives inside provider.publish; make
		// sure the lease is current before handing over to it.
		await renewLease();
		// Keep the claim warm while the provider works. A single large upload can
		// outlive STALE_CLAIM_MS, and providers only checkpoint after a segment
		// lands — so without this the row looks abandoned mid-upload, an
		// overlapping tick reclaims it, and the post goes out twice.
		const heartbeat = setInterval(
			() => {
				void renewLease();
			},
			Math.max(30_000, Math.floor(LEASE_REFRESH_MS / 2))
		);
		let result: PublishResult;
		try {
			result = await provider.publish(
				content,
				workingCreds,
				{ maxCharacters: meta.maxCharacters, handle: conn.handle || undefined },
				fetchImpl,
				{
					resume: resumeFrom ?? undefined,
					allowLocalHosts: isLocalAppUrl(env.APP_URL),
					mediaUrlFor: (storageKey: string) => publicMediaUrlFor(env, storageKey),
					checkpoint,
					// Deliberately not attempt-scoped: the whole point is that a
					// retry of the same target and segment carries the same key, so
					// a provider that saw the first request recognises the second.
					idempotencyKey: (segmentIndex: number) => `${targetId}:${segmentIndex}`,
					recordKey: (segmentIndex: number) =>
						targetRecordKey(targetId, target.createdAt.getTime(), segmentIndex)
				}
			);
		} finally {
			clearInterval(heartbeat);
		}

		const published = await db
			.update(publishTargets)
			.set({
				status: 'published',
				remotePostId: result.remotePostId,
				remoteUrl: safeHttpUrl(result.remoteUrl),
				errorMessage: null,
				jobId: null,
				updatedAt: now
			})
			.where(
				and(
					eq(publishTargets.id, targetId),
					eq(publishTargets.status, 'publishing'),
					eq(publishTargets.attemptCount, claimedGeneration)
				)
			)
			.returning({ id: publishTargets.id });

		await db
			.update(publishAttempts)
			.set({
				finishedAt: new Date(),
				success: true,
				responseSummary: JSON.stringify({
					remotePostId: result.remotePostId,
					segmentIds: result.segmentIds,
					segmentCids: result.segmentCids,
					preempted: published.length === 0
				})
			})
			.where(eq(publishAttempts.id, attemptId));

		if (!published.length) {
			return { status: 'preempted', skipped: true, remotePostId: result.remotePostId };
		}

		// The provider accepted the post: whatever a previous failure claimed,
		// this credential works. Clear a stale `expired`/`error` flag so the
		// account does not stay stuck behind a manual reconnect.
		if (conn.status !== 'active') {
			await db
				.update(connections)
				.set({ status: 'active', updatedAt: now })
				.where(eq(connections.id, conn.id));
		}

		await refreshDraftStatus(db, target.draftId);
		return { status: 'published', remotePostId: result.remotePostId };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (isAuthFailure(err, message)) {
			await db
				.update(connections)
				.set({ status: 'expired', updatedAt: new Date() })
				.where(eq(connections.id, target.connectionId));
		}
		const partial = err instanceof PublishPartialError ? err : null;
		const errorDetail = err instanceof ProviderError ? (err.detail ?? null) : null;
		// The returned status is what callers report to the UI: `scheduled`
		// means "retrying automatically", `failed` means terminal.
		const nextStatus = await markFailed(
			db,
			targetId,
			target.draftId,
			attemptId,
			message,
			claimedGeneration,
			{
				scheduledFor: target.scheduledFor,
				retryable: isFailureRetryable(err, message),
				now,
				partial,
				errorDetail,
				// Whatever the provider last checkpointed survives a failure that is
				// not partial: a remote post created before the error (Zernio creates,
				// then polls) must be resumed, not created twice. An empty list is the
				// provider saying that post is dead, so the retry starts fresh.
				lastCheckpoint: resumeState.last
			}
		);
		return { status: nextStatus, error: message };
	}
}

/**
 * Refresh a credential, tolerating a refresh another publish just did.
 *
 * Some platforms rotate the refresh token on every use, so when two publishes
 * of one account refresh at the same moment, the slower one presents a token
 * that has just been replaced and is refused. The winner has already stored the
 * new credentials by then; reading them back and trying once more turns that
 * race into a success instead of an "expired" account. A refusal with nothing
 * newer stored is a real one and propagates.
 */
async function refreshWithStoredRetry(
	db: AppDb,
	env: AppEnv,
	connectionId: string,
	readCiphertext: string,
	creds: ConnectionCredentials,
	refresh: (creds: ConnectionCredentials) => Promise<ConnectionCredentials>
): Promise<ConnectionCredentials> {
	try {
		return await refresh(creds);
	} catch (err) {
		if (classifyProviderError(err).code !== 'auth') throw err;
		const latest = await first(
			db
				.select({ credentialsEncrypted: connections.credentialsEncrypted })
				.from(connections)
				.where(eq(connections.id, connectionId))
		);
		if (!latest?.credentialsEncrypted || latest.credentialsEncrypted === readCiphertext) throw err;
		return refresh(
			await decryptJson<ConnectionCredentials>(latest.credentialsEncrypted, env.APP_ENCRYPTION_KEY)
		);
	}
}

async function lastPartialResume(db: AppDb, targetId: string) {
	// Newest-first with a cap: resume only needs the latest summary bearing
	// segment ids, and attempt history grows without bound per target.
	const attempts = await db
		.select()
		.from(publishAttempts)
		.where(eq(publishAttempts.publishTargetId, targetId))
		.orderBy(desc(publishAttempts.startedAt))
		.limit(20);
	for (const attempt of attempts) {
		const summary = parseJson<{
			segmentIds?: string[];
			segmentCids?: string[];
			remoteUrl?: string | null;
			remotePostId?: string;
		}>(attempt.responseSummary, {});
		// An empty list is a statement, not an absence: the provider found the
		// remote post it was resuming dead and asked for a fresh start.
		if (Array.isArray(summary.segmentIds)) {
			if (!summary.segmentIds.length) return null;
			return {
				segmentIds: summary.segmentIds,
				segmentCids: summary.segmentCids,
				remoteUrl: summary.remoteUrl ?? null
			};
		}
	}
	return null;
}

async function markFailed(
	db: AppDb,
	targetId: string,
	draftId: string,
	attemptId: string | null,
	message: string,
	claimedGeneration: number,
	opts: {
		scheduledFor?: Date | string | null;
		retryable?: boolean;
		now?: Date;
		partial?: PublishPartialError | null;
		errorDetail?: string | null;
		lastCheckpoint?: PublishCheckpoint | null;
	} = {}
): Promise<'scheduled' | 'failed' | 'published'> {
	const now = opts.now ?? new Date();
	const nextStatus =
		claimedGeneration >= MAX_PUBLISH_ATTEMPTS
			? 'failed'
			: statusAfterFailedPublish({
					retryable: Boolean(opts.retryable),
					scheduledFor: opts.scheduledFor ?? null,
					now
				});
	// Backoff for manual failures and past-due schedules; a future schedule
	// keeps its own time. The scheduler tick claims `scheduled` rows once due,
	// so a retryable manual publish retries itself instead of parking.
	let retryAt: Date | undefined;
	if (nextStatus === 'scheduled') {
		const when = opts.scheduledFor
			? opts.scheduledFor instanceof Date
				? opts.scheduledFor.getTime()
				: new Date(opts.scheduledFor).getTime()
			: null;
		if (when == null || Number.isNaN(when) || when <= now.getTime() + 5000) {
			retryAt = new Date(now.getTime() + retryDelayMs(claimedGeneration));
		}
	}
	const failed = await db
		.update(publishTargets)
		.set({
			status: nextStatus,
			errorMessage: message,
			jobId: null,
			...(retryAt ? { scheduledFor: retryAt } : {}),
			updatedAt: now
		})
		.where(
			and(
				eq(publishTargets.id, targetId),
				eq(publishTargets.status, 'publishing'),
				eq(publishTargets.attemptCount, claimedGeneration)
			)
		)
		.returning({ id: publishTargets.id });
	if (attemptId) {
		// errorDetail carries the capped upstream body (codes/subcodes the
		// user-facing message slice cuts off). Resume parsing only reads
		// segment keys, so the extra field is inert there.
		const summary: Record<string, unknown> = {};
		if (opts.partial) {
			summary.segmentIds = opts.partial.segmentIds;
			summary.segmentCids = opts.partial.segmentCids;
			summary.remoteUrl = opts.partial.remoteUrl ?? null;
		} else if (opts.lastCheckpoint) {
			summary.segmentIds = opts.lastCheckpoint.segmentIds;
			summary.segmentCids = opts.lastCheckpoint.segmentCids;
			summary.remoteUrl = opts.lastCheckpoint.remoteUrl ?? null;
		}
		if (opts.errorDetail) summary.errorDetail = opts.errorDetail;
		await db
			.update(publishAttempts)
			.set({
				finishedAt: now,
				success: false,
				error: message,
				responseSummary: Object.keys(summary).length ? JSON.stringify(summary) : null
			})
			.where(eq(publishAttempts.id, attemptId));
	}
	if (!failed.length) {
		// The conditional UPDATE matched nothing: another claim (stale-claim
		// reclaim or a preempting publish) owns the row now. Report what the
		// row actually says instead of a status this attempt never persisted.
		const latest = await first(
			db
				.select({ status: publishTargets.status })
				.from(publishTargets)
				.where(eq(publishTargets.id, targetId))
		);
		return latest?.status === 'published' || latest?.status === 'scheduled'
			? latest.status
			: 'failed';
	}
	await refreshDraftStatus(db, draftId);
	return nextStatus;
}

/**
 * Correlated status expression: evaluated by the database at UPDATE time from
 * the target rows as they exist then, so a concurrent publish cannot be
 * clobbered by a stale in-memory snapshot. Shared by the single-draft and
 * bulk refreshers; the CASE mirrors the branch order this replaced.
 */
const DRAFT_STATUS_SQL = sql`(
	SELECT CASE
		WHEN a = 0 THEN 'draft'
		WHEN p = a THEN 'published'
		WHEN s > 0 AND p = 0 AND f = 0 THEN 'scheduled'
		WHEN p > 0 AND (f > 0 OR s > 0) THEN 'partial'
		WHEN f = a THEN 'failed'
		WHEN f > 0 THEN 'partial'
		WHEN s > 0 THEN 'scheduled'
		ELSE 'draft'
	END
	FROM (
		SELECT
			COUNT(CASE WHEN status <> 'cancelled' THEN 1 END) AS a,
			COUNT(CASE WHEN status = 'published' THEN 1 END) AS p,
			COUNT(CASE WHEN status = 'failed' THEN 1 END) AS f,
			COUNT(CASE WHEN status IN ('scheduled', 'pending', 'publishing') THEN 1 END) AS s
		FROM publish_targets
		WHERE draft_id = drafts.id
	)
)`;

export async function refreshDraftStatus(db: AppDb, draftId: string) {
	// One atomic statement. The previous read-then-write could interleave when
	// two destinations of the same draft published concurrently (manual
	// per-destination fan-out, queue consumers, or two isolates): the slower
	// writer could persist a status computed before the other target landed.
	// D1/libsql serialize statements, so the last statement always computes
	// from the final target rows.
	await db.run(
		sql`UPDATE drafts SET status = ${DRAFT_STATUS_SQL}, updated_at = ${Date.now()} WHERE id = ${draftId}`
	);
}

/** Keeps the IN(...) list under D1's 100 bound-parameters-per-query limit. */
export const DRAFT_STATUS_CHUNK = 90;

/**
 * Bulk refresh for flows that can touch many drafts at once (a disconnect
 * removes every target on one connection). Same atomic UPDATE, one statement
 * per chunk instead of one per draft — D1's Free plan allows only 50 queries
 * per invocation, so the per-draft loop could exhaust the budget.
 */
export async function refreshDraftStatuses(db: AppDb, draftIds: string[]) {
	const ids = [...new Set(draftIds)];
	for (const chunk of chunkIds(ids, DRAFT_STATUS_CHUNK)) {
		await db.run(
			sql`UPDATE drafts SET status = ${DRAFT_STATUS_SQL}, updated_at = ${Date.now()} WHERE ${inArray(drafts.id, chunk)}`
		);
	}
}

export function isRetryableError(message: string): boolean {
	const lower = message.toLowerCase();
	// The post may already be live (unconfirmedPostError). A thread that failed
	// part-way is classified by its message alone, so the code is not enough.
	if (lower.includes(UNCONFIRMED_POST_MARK)) return false;
	if (lower.includes('grapheme') || lower.includes('characters on this')) return false;
	if (lower.includes('segment needs') || lower.includes('empty')) return false;
	if (lower.includes('max 4 images') || lower.includes('max 4 photos')) return false;
	// Any per-file size cap ("max 2MB per image", "max 15MB per GIF"). Matched
	// by shape rather than by number, so changing a cap cannot turn a
	// permanent refusal into a retry storm.
	if (/max \d+mb/.test(lower)) return false;
	if (lower.includes('x max 280') || lower.includes('max 1 cashtag')) return false;
	// Video while ENABLE_VIDEO_UPLOAD is off: only the operator can change this,
	// so retrying on a backoff wastes the attempt budget and buries the reason.
	if (lower.includes('video uploads are not enabled')) return false;
	if (lower.includes('x video is not supported')) return false;
	if (lower.includes('utf-8 bytes') || lower.includes('max 16mb')) return false;
	// The app's own host allowlist rejected the stored instance (Mastodon:
	// "Instance host not allowed", Bluesky: "PDS host not allowed"). That is
	// a permanent policy refusal — retrying cannot change it.
	if (lower.includes('host not allowed')) return false;
	if (
		lower.includes('linkedin') &&
		(lower.includes('does not support threads') || lower.includes('single post'))
	)
		return false;
	if (lower.includes('threads') && lower.includes('text-only')) return false;
	// Permission-shaped Threads 400s must not burn the scheduler's retry
	// budget: retrying the same credential cannot succeed. Manual retry stays
	// available, and succeeds right after a reconnect.
	if (isThreadsPermissionFailure(lower)) return false;
	// Meta's media crawler hiccups (subcode 2207052) are transient by nature —
	// the same bytes fetched fine seconds later — so they must stay retryable
	// (scheduler backoff for scheduled posts, manual Retry otherwise).
	if (isThreadsMediaFetchFailure(lower)) return true;
	// Other Threads 4xx container/publish failures are client errors — the
	// identical request cannot succeed on a timer. 429 is excluded on
	// purpose: rate limits must stay retryable. Manual retry stays available.
	if (/threads (container|publish) failed \(4(?!29)\d/.test(lower)) return false;
	if (lower.includes('linkedin') && (lower.includes('8mb') || lower.includes('webp'))) return false;
	if (lower.includes('max 5 links')) return false;
	if (lower.includes('credentials require')) return false;
	if (lower.includes('target not found') || lower.includes('target cancelled')) return false;
	if (lower.includes('already scheduled')) return false;
	if (/401|unauthorized|invalid credentials|forbidden|403/.test(lower)) return false;
	return true;
}

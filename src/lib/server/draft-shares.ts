import { and, eq, gt, type InferSelectModel } from 'drizzle-orm';
import { bytesToHex, utf8Bytes } from '#lib/domain/bytes.js';
import { hasGoneOut, isShareTokenFormat } from '#lib/domain/draft-share.js';
import { hmacHex } from './crypto';
import { batchQueries, first, newId, type AppDb } from './db/client';
import { draftMedia, draftShares, drafts, draftVariants, publishTargets } from './db/schema';

/**
 * The token is derived rather than random so the owner can be shown the same
 * link again while the table holds only its hash: a copy of the database alone
 * cannot rebuild a working link. The dedicated sub-key keeps these HMACs apart
 * from every other use of APP_ENCRYPTION_KEY.
 */
async function shareToken(secret: string, shareId: string): Promise<string> {
	return hmacHex(await hmacHex(secret, 'subkey:draft-share:v1'), `draft-share:${shareId}`);
}

// Domain-separated like the API key and session hashes, so equal raw values in
// two tables can never produce equal digests.
export async function hashShareToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		utf8Bytes(`draftshare:${token}`) as BufferSource
	);
	return bytesToHex(new Uint8Array(digest));
}

export type ShareLink = { token: string; expiresAt: Date };

/** The draft's link while it still works; an expired row is as good as none. */
export async function currentShare(
	db: AppDb,
	secret: string,
	draftId: string,
	now = new Date()
): Promise<ShareLink | null> {
	const row = await first(
		db
			.select()
			.from(draftShares)
			.where(and(eq(draftShares.draftId, draftId), gt(draftShares.expiresAt, now)))
	);
	if (!row) return null;
	return { token: await shareToken(secret, row.id), expiresAt: row.expiresAt };
}

/** A new link for the draft. Any earlier one stops working: one link per draft. */
export async function createShare(
	db: AppDb,
	secret: string,
	draftId: string,
	lifetimeMs: number,
	now = new Date()
): Promise<ShareLink> {
	const id = newId();
	const token = await shareToken(secret, id);
	const expiresAt = new Date(now.getTime() + lifetimeMs);
	await batchQueries(db, [
		db.delete(draftShares).where(eq(draftShares.draftId, draftId)),
		db.insert(draftShares).values({
			id,
			draftId,
			tokenHash: await hashShareToken(token),
			expiresAt,
			createdAt: now
		})
	]);
	return { token, expiresAt };
}

export async function revokeShare(db: AppDb, draftId: string): Promise<void> {
	await db.delete(draftShares).where(eq(draftShares.draftId, draftId));
}

export type SharedDraft = {
	draft: InferSelectModel<typeof drafts>;
	variants: InferSelectModel<typeof draftVariants>[];
	media: InferSelectModel<typeof draftMedia>[];
	expiresAt: Date;
};

/** The live share behind a token: well-formed, known, unexpired. */
async function liveShare(db: AppDb, token: string | null | undefined, now: Date) {
	if (!isShareTokenFormat(token)) return null;
	return first(
		db
			.select({ draftId: draftShares.draftId, expiresAt: draftShares.expiresAt })
			.from(draftShares)
			.where(
				and(eq(draftShares.tokenHash, await hashShareToken(token)), gt(draftShares.expiresAt, now))
			)
	);
}

type TargetState = { status: string; remotePostId: string | null };

function targetStates(db: AppDb, draftId: string) {
	return db
		.select({ status: publishTargets.status, remotePostId: publishTargets.remotePostId })
		.from(publishTargets)
		.where(eq(publishTargets.draftId, draftId));
}

/**
 * The draft behind a token, or null when the token is malformed, unknown,
 * expired, or its post has gone out. Every caller answers all of those with the
 * same 404, so a visitor cannot tell a revoked link from one that never existed.
 * A deleted draft takes its share row with it (ON DELETE CASCADE).
 */
export async function resolveShare(
	db: AppDb,
	token: string | null | undefined,
	now = new Date()
): Promise<SharedDraft | null> {
	const share = await liveShare(db, token, now);
	if (!share) return null;
	const [draftRows, targets, variants, media] = (await batchQueries(db, [
		db.select().from(drafts).where(eq(drafts.id, share.draftId)),
		targetStates(db, share.draftId),
		db.select().from(draftVariants).where(eq(draftVariants.draftId, share.draftId)),
		db.select().from(draftMedia).where(eq(draftMedia.draftId, share.draftId))
	])) as [
		InferSelectModel<typeof drafts>[],
		TargetState[],
		InferSelectModel<typeof draftVariants>[],
		InferSelectModel<typeof draftMedia>[]
	];
	const draft = draftRows[0];
	if (!draft || hasGoneOut(targets)) return null;
	media.sort((a, b) => a.sortOrder - b.sortOrder);
	return { draft, variants, media, expiresAt: share.expiresAt };
}

/** One attachment of a shared draft, under the same rules as the page itself. */
export async function resolveSharedMedia(
	db: AppDb,
	token: string | null | undefined,
	storageKey: string,
	now = new Date()
): Promise<InferSelectModel<typeof draftMedia> | null> {
	const share = await liveShare(db, token, now);
	if (!share) return null;
	const [targets, media] = (await batchQueries(db, [
		targetStates(db, share.draftId),
		db
			.select()
			.from(draftMedia)
			.where(and(eq(draftMedia.draftId, share.draftId), eq(draftMedia.storageKey, storageKey)))
	])) as [TargetState[], InferSelectModel<typeof draftMedia>[]];
	if (hasGoneOut(targets)) return null;
	return media[0] ?? null;
}

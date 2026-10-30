import { and, eq, gt, inArray, ne, type InferSelectModel } from 'drizzle-orm';
import { bytesToHex, utf8Bytes } from '#lib/domain/bytes.js';
import { hasGoneOut, isShareTokenFormat } from '#lib/domain/draft-share.js';
import {
	resolveRestoredSelection,
	resolveSavedSelection,
	restorableTargetIds
} from '#lib/domain/platform-sync.js';
import { hmacHex } from './crypto';
import { batchQueries, first, newId, parseJson, type AppDb } from './db/client';
import {
	connections,
	draftMedia,
	draftShares,
	drafts,
	draftVariants,
	publishTargets
} from './db/schema';

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

/**
 * The draft's link while it still works; an expired row is as good as none. So
 * is one minted under a different APP_ENCRYPTION_KEY: the token rebuilt from
 * the current key would not match the stored hash, and showing it would hand
 * the owner a link that 404s.
 */
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
	const token = await shareToken(secret, row.id);
	if ((await hashShareToken(token)) !== row.tokenHash) return null;
	return { token, expiresAt: row.expiresAt };
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
	/** The platforms the post is going to, for picking which variants to show. */
	platforms: string[];
	expiresAt: Date;
};

/**
 * The live share behind a token: well-formed, known, unexpired, and made under
 * the current key. The hash alone would match forever, so without rebuilding
 * the token a rotated APP_ENCRYPTION_KEY would leave old links working while
 * the composer no longer shows them.
 */
async function liveShare(db: AppDb, secret: string, token: string | null | undefined, now: Date) {
	if (!isShareTokenFormat(token)) return null;
	const share = await first(
		db
			.select({
				id: draftShares.id,
				draftId: draftShares.draftId,
				expiresAt: draftShares.expiresAt
			})
			.from(draftShares)
			.where(
				and(eq(draftShares.tokenHash, await hashShareToken(token)), gt(draftShares.expiresAt, now))
			)
	);
	if (!share || (await shareToken(secret, share.id)) !== token) return null;
	return share;
}

type TargetState = { connectionId: string; status: string; remotePostId: string | null };

function targetStates(db: AppDb, draftId: string) {
	return db
		.select({
			connectionId: publishTargets.connectionId,
			status: publishTargets.status,
			remotePostId: publishTargets.remotePostId
		})
		.from(publishTargets)
		.where(eq(publishTargets.draftId, draftId));
}

/**
 * The draft behind a token, or null when the token is malformed, unknown,
 * expired, from an earlier key, or its post has gone out. Every caller answers all of those with the
 * same 404, so a visitor cannot tell a revoked link from one that never existed.
 * A deleted draft takes its share row with it (ON DELETE CASCADE).
 */
export async function resolveShare(
	db: AppDb,
	secret: string,
	token: string | null | undefined,
	now = new Date()
): Promise<SharedDraft | null> {
	const share = await liveShare(db, secret, token, now);
	if (!share) return null;
	const [draftRows, targets, variants, media, accounts] = (await batchQueries(db, [
		db.select().from(drafts).where(eq(drafts.id, share.draftId)),
		targetStates(db, share.draftId),
		db.select().from(draftVariants).where(eq(draftVariants.draftId, share.draftId)),
		db.select().from(draftMedia).where(eq(draftMedia.draftId, share.draftId)),
		// The owner's selectable accounts, as the composer lists them: archive
		// tombstones are never a destination.
		db
			.select({ id: connections.id, platform: connections.platform })
			.from(connections)
			.where(
				and(
					inArray(
						connections.userId,
						db.select({ id: drafts.userId }).from(drafts).where(eq(drafts.id, share.draftId))
					),
					ne(connections.status, 'disconnected')
				)
			)
	])) as [
		InferSelectModel<typeof drafts>[],
		TargetState[],
		InferSelectModel<typeof draftVariants>[],
		InferSelectModel<typeof draftMedia>[],
		{ id: string; platform: string }[]
	];
	const draft = draftRows[0];
	if (!draft || hasGoneOut(targets)) return null;
	media.sort((a, b) => a.sortOrder - b.sortOrder);
	// The same precedence the composer restores a draft with: its own saved
	// selection, else its publish targets. Neither means nothing is selected.
	const selected =
		resolveSavedSelection(parseJson<unknown>(draft.selectedConnectionIds, null), accounts) ??
		resolveRestoredSelection(restorableTargetIds(targets), accounts) ??
		[];
	const platforms = [
		...new Set(accounts.filter((a) => selected.includes(a.id)).map((a) => a.platform))
	];
	return { draft, variants, media, platforms, expiresAt: share.expiresAt };
}

/** One attachment of a shared draft, under the same rules as the page itself. */
export async function resolveSharedMedia(
	db: AppDb,
	secret: string,
	token: string | null | undefined,
	storageKey: string,
	now = new Date()
): Promise<InferSelectModel<typeof draftMedia> | null> {
	const share = await liveShare(db, secret, token, now);
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

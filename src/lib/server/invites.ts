import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { randomHex } from '#lib/domain/bytes.js';
import { hmacHex } from './crypto';
import { first, newId, type AppDb } from './db/client';
import { invites } from './db/schema';
import type { AppEnv } from './env';

/**
 * Invite links: single-use, expiring, and the only way past the waitlist and the
 * cap that the admin does not have to approve by hand. The code is shown once,
 * like an API key; D1 keeps an HMAC of it under AUTH_SECRET, so a copy of the
 * database cannot be turned back into working links.
 */
export const INVITE_PREFIX = 'inv_';
export const INVITE_TTL_DAYS_DEFAULT = 7;
export const INVITE_TTL_DAYS_MAX = 90;
const INVITE_SHAPE = /^inv_[0-9a-f]{32}$/;

export function isInviteFormat(raw: unknown): raw is string {
	return typeof raw === 'string' && INVITE_SHAPE.test(raw);
}

async function hashInvite(env: AppEnv, code: string): Promise<string> {
	return hmacHex(env.AUTH_SECRET, `invite:${code}`);
}

export async function createInvite(
	db: AppDb,
	env: AppEnv,
	opts: { createdBy: string; note?: string | null; ttlDays?: number; now?: Date }
): Promise<{ id: string; code: string; expiresAt: Date }> {
	const now = opts.now ?? new Date();
	const days = Math.min(
		Math.max(Math.trunc(opts.ttlDays ?? INVITE_TTL_DAYS_DEFAULT), 1),
		INVITE_TTL_DAYS_MAX
	);
	const code = `${INVITE_PREFIX}${randomHex(16)}`;
	const id = newId();
	const expiresAt = new Date(now.getTime() + days * 86_400_000);
	await db.insert(invites).values({
		id,
		codeHash: await hashInvite(env, code),
		note: opts.note?.trim().slice(0, 120) || null,
		createdBy: opts.createdBy,
		createdAt: now,
		expiresAt
	});
	return { id, code, expiresAt };
}

export interface InviteSummary {
	id: string;
	note: string | null;
	createdAt: number;
	expiresAt: number;
	usedAt: number | null;
	usedBy: string | null;
	state: 'open' | 'used' | 'expired';
}

export async function listInvites(db: AppDb, now = new Date()): Promise<InviteSummary[]> {
	const rows = await db.select().from(invites).orderBy(desc(invites.createdAt)).limit(200);
	return rows.map((row) => ({
		id: row.id,
		note: row.note ?? null,
		createdAt: row.createdAt.getTime(),
		expiresAt: row.expiresAt.getTime(),
		usedAt: row.usedAt ? row.usedAt.getTime() : null,
		usedBy: row.usedBy ?? null,
		state: row.usedAt ? 'used' : row.expiresAt <= now ? 'expired' : 'open'
	}));
}

export async function revokeInvite(db: AppDb, id: string): Promise<boolean> {
	const removed = await db.delete(invites).where(eq(invites.id, id)).returning({ id: invites.id });
	return removed.length > 0;
}

/**
 * Spend an invite. One conditional UPDATE, so two sign-ups racing on the same
 * link cannot both get it. Returns the invite's id, or null for a code that is
 * unknown, used or expired (deliberately indistinguishable to the caller).
 */
export async function claimInvite(
	db: AppDb,
	env: AppEnv,
	code: unknown,
	now = new Date()
): Promise<string | null> {
	if (!isInviteFormat(code)) return null;
	const claimed = await db
		.update(invites)
		.set({ usedAt: now })
		.where(
			and(
				eq(invites.codeHash, await hashInvite(env, code)),
				isNull(invites.usedAt),
				gt(invites.expiresAt, now)
			)
		)
		.returning({ id: invites.id });
	return claimed[0]?.id ?? null;
}

/** Record who an invite let in, once their account exists. */
export async function bindInvite(db: AppDb, id: string, userId: string): Promise<void> {
	await db.update(invites).set({ usedBy: userId }).where(eq(invites.id, id));
}

/** Hand an invite back when the sign-up it was spent on did not happen. */
export async function releaseInvite(db: AppDb, id: string): Promise<void> {
	await db
		.update(invites)
		.set({ usedAt: null, usedBy: null })
		.where(and(eq(invites.id, id), isNull(invites.usedBy)));
}

/** Whether this account came in through an invite: verifying its email then
 *  activates it, whatever the waitlist says. */
export async function wasInvited(db: AppDb, userId: string): Promise<boolean> {
	return Boolean(
		await first(db.select({ id: invites.id }).from(invites).where(eq(invites.usedBy, userId)))
	);
}

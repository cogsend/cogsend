import { and, asc, count, eq, max, ne } from 'drizzle-orm';
import type { UserRole, UserStatus } from '#lib/domain/registration.js';
import { revokeOtherSessions } from './auth';
import { first, type AppDb } from './db/client';
import { connections, drafts, sessions, users } from './db/schema';

/**
 * The admin's view of the accounts on an instance, and the changes they can
 * make to one. Every function here acts on a user id the caller has already
 * authorised as an admin action; none of it is reachable by a member.
 */

export interface UserSummary {
	id: string;
	email: string;
	displayName: string | null;
	role: UserRole;
	status: UserStatus;
	totpEnabled: boolean;
	createdAt: number;
	lastLoginAt: number | null;
	lastSeenAt: number | null;
	drafts: number;
	connections: number;
}

function toNumber(value: unknown): number {
	const n = typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
	return Number.isFinite(n) ? n : 0;
}

function toMs(value: unknown): number | null {
	if (value === null || value === undefined) return null;
	if (value instanceof Date) return value.getTime();
	const n = toNumber(value);
	return n > 0 ? n : null;
}

/** Every account, oldest first, with the counts the Users page shows. Four
 *  queries whatever the number of users, so it stays inside the D1 budget. */
export async function listUsers(db: AppDb): Promise<UserSummary[]> {
	const rows = await db
		.select({
			id: users.id,
			email: users.email,
			displayName: users.displayName,
			role: users.role,
			status: users.status,
			totpEnabled: users.totpEnabled,
			createdAt: users.createdAt,
			lastLoginAt: users.lastLoginAt
		})
		.from(users)
		.orderBy(asc(users.createdAt), asc(users.id));
	const [seen, draftCounts, connectionCounts] = await Promise.all([
		db
			.select({ userId: sessions.userId, at: max(sessions.lastSeenAt) })
			.from(sessions)
			.groupBy(sessions.userId),
		db.select({ userId: drafts.userId, n: count() }).from(drafts).groupBy(drafts.userId),
		db
			.select({ userId: connections.userId, n: count() })
			.from(connections)
			.groupBy(connections.userId)
	]);
	const seenBy = new Map(seen.map((r) => [r.userId, toMs(r.at)]));
	const draftsBy = new Map(draftCounts.map((r) => [r.userId, toNumber(r.n)]));
	const connsBy = new Map(connectionCounts.map((r) => [r.userId, toNumber(r.n)]));
	return rows.map((row) => ({
		id: row.id,
		email: row.email,
		displayName: row.displayName ?? null,
		role: row.role === 'admin' ? 'admin' : 'member',
		status: row.status as UserStatus,
		totpEnabled: Boolean(row.totpEnabled),
		createdAt: row.createdAt.getTime(),
		lastLoginAt: row.lastLoginAt ? row.lastLoginAt.getTime() : null,
		lastSeenAt: seenBy.get(row.id) ?? null,
		drafts: draftsBy.get(row.id) ?? 0,
		connections: connsBy.get(row.id) ?? 0
	}));
}

export async function countActiveUsers(db: AppDb): Promise<number> {
	const row = await first(db.select({ n: count() }).from(users).where(eq(users.status, 'active')));
	return toNumber(row?.n);
}

/** True when the instance has more than one account. Reads at most two rows. */
export async function hasSeveralUsers(db: AppDb): Promise<boolean> {
	const rows = await db.select({ id: users.id }).from(users).limit(2);
	return rows.length > 1;
}

/**
 * Whether removing `userId`'s admin powers (demoting, suspending or deleting
 * it) would leave an instance with other accounts and no active admin to run
 * it. A lone account may always delete itself: that is today's single-user
 * "delete my account".
 */
export async function wouldOrphanInstance(db: AppDb, userId: string): Promise<boolean> {
	const target = await first(
		db.select({ role: users.role, status: users.status }).from(users).where(eq(users.id, userId))
	);
	if (!target || target.role !== 'admin' || target.status !== 'active') return false;
	const otherAdmin = await first(
		db
			.select({ id: users.id })
			.from(users)
			.where(and(eq(users.role, 'admin'), eq(users.status, 'active'), ne(users.id, userId)))
			.limit(1)
	);
	if (otherAdmin) return false;
	const other = await first(
		db.select({ id: users.id }).from(users).where(ne(users.id, userId)).limit(1)
	);
	return Boolean(other);
}

export class UserAdminError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
	}
}

/**
 * Change an account's status. Anything but `active` signs it out everywhere;
 * its API keys stop working through the status check in the hook, and work
 * again if it is reactivated.
 */
export async function setUserStatus(
	db: AppDb,
	actorId: string,
	userId: string,
	status: Extract<UserStatus, 'active' | 'suspended'>
): Promise<void> {
	if (userId === actorId) throw new UserAdminError('You cannot change your own status', 400);
	if (status !== 'active' && (await wouldOrphanInstance(db, userId))) {
		throw new UserAdminError('Make another account an admin first', 409);
	}
	const updated = await db
		.update(users)
		.set({ status, updatedAt: new Date() })
		.where(eq(users.id, userId))
		.returning({ id: users.id });
	if (!updated.length) throw new UserAdminError('Not found', 404);
	if (status !== 'active') await revokeOtherSessions(db, userId);
}

export async function setUserRole(
	db: AppDb,
	actorId: string,
	userId: string,
	role: UserRole
): Promise<void> {
	if (userId === actorId) throw new UserAdminError('You cannot change your own role', 400);
	if (role !== 'admin' && (await wouldOrphanInstance(db, userId))) {
		throw new UserAdminError('Make another account an admin first', 409);
	}
	const updated = await db
		.update(users)
		.set({ role, updatedAt: new Date() })
		.where(eq(users.id, userId))
		.returning({ id: users.id });
	if (!updated.length) throw new UserAdminError('Not found', 404);
	// The session read takes the role from the row on every request, so this is
	// belt and braces: nothing minted under the old role outlives the change.
	await revokeOtherSessions(db, userId);
}

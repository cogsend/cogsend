import { and, eq, sql } from 'drizzle-orm';
import { first, newId, type AppDb } from './db/client';
import { mfaChallenges } from './db/schema';
import { hashToken } from './auth';
import type { AppEnv } from './env';

export const AUTH_GATE_MAX_FAILURES = 8;
export const AUTH_GATE_WINDOW_MS = 15 * 60_000;

export type AuthGateKind = 'password' | 'password-all' | 'rotate-gate' | 'totp-gate';

function gateExpires(now = new Date()) {
	return new Date(now.getTime() + AUTH_GATE_WINDOW_MS);
}

/** `scope` narrows a gate further, e.g. to one client address. */
async function gateTokenHash(env: AppEnv, kind: AuthGateKind, userId: string, scope?: string) {
	return hashToken(`gate:${kind}:${userId}${scope ? `:${scope}` : ''}`, env.AUTH_SECRET);
}

export async function assertAuthGateOpen(
	db: AppDb,
	env: AppEnv,
	userId: string,
	kind: AuthGateKind,
	opts: { scope?: string; max?: number } = {}
) {
	const max = opts.max ?? AUTH_GATE_MAX_FAILURES;
	const tokenHash = await gateTokenHash(env, kind, userId, opts.scope);
	const row = await first(
		db.select().from(mfaChallenges).where(eq(mfaChallenges.tokenHash, tokenHash))
	);
	if (!row) return;
	const now = new Date();
	if (row.expiresAt < now) {
		await db.delete(mfaChallenges).where(eq(mfaChallenges.id, row.id));
		return;
	}
	if (row.failedAttempts >= max) {
		throw Object.assign(new Error('Too many attempts — try again in 15 minutes'), { status: 401 });
	}
}

export async function recordAuthGateFailure(
	db: AppDb,
	env: AppEnv,
	userId: string,
	kind: AuthGateKind,
	opts: { scope?: string; max?: number } = {}
) {
	const max = opts.max ?? AUTH_GATE_MAX_FAILURES;
	const tokenHash = await gateTokenHash(env, kind, userId, opts.scope);
	const now = new Date();
	const nowMs = now.getTime();
	const expiry = gateExpires(now);
	// One UPSERT so the increment happens inside SQLite. The read-then-write it
	// replaced let two concurrent failures both persist `count + 1`, which is
	// exactly the timing a guessing burst produces. A row past its window is
	// reset to a fresh count, and the window is extended once the row is locked
	// (matching the previous behavior).
	const rows = await db
		.insert(mfaChallenges)
		.values({
			id: newId(),
			userId,
			tokenHash,
			kind,
			remember: false,
			failedAttempts: 1,
			expiresAt: expiry,
			createdAt: now
		})
		.onConflictDoUpdate({
			target: mfaChallenges.tokenHash,
			set: {
				failedAttempts: sql`CASE WHEN ${mfaChallenges.expiresAt} < ${nowMs} THEN 1 ELSE ${mfaChallenges.failedAttempts} + 1 END`,
				expiresAt: sql`CASE
						WHEN ${mfaChallenges.expiresAt} < ${nowMs} THEN ${expiry.getTime()}
						WHEN ${mfaChallenges.failedAttempts} + 1 >= ${max} THEN ${expiry.getTime()}
						ELSE ${mfaChallenges.expiresAt}
					END`
			}
		})
		.returning({ failedAttempts: mfaChallenges.failedAttempts });
	const failedAttempts = rows[0]?.failedAttempts ?? 1;
	return { locked: failedAttempts >= max };
}

export async function clearAuthGate(
	db: AppDb,
	env: AppEnv,
	userId: string,
	kind: AuthGateKind,
	opts: { scope?: string } = {}
) {
	const tokenHash = await gateTokenHash(env, kind, userId, opts.scope);
	await db.delete(mfaChallenges).where(and(eq(mfaChallenges.tokenHash, tokenHash)));
}

/**
 * Wrong passwords are counted per client address and across all addresses.
 *
 * A per-account count alone let anyone who knew the owner's email lock them
 * out, fifteen minutes at a time, indefinitely. Counting per address means a
 * guesser locks only themselves (eight failures, as before); the account-wide
 * cap, set higher, still stops guessing spread over many addresses. Without an
 * address (local dev, tests) the per-account count is the one that applies.
 */
export const PASSWORD_GATE_GLOBAL_MAX = 40;

/**
 * The bucket for a client address: the address itself for IPv4, the /64 for
 * IPv6 — one connection is usually handed a whole /64, so counting single
 * IPv6 addresses would give a guesser billions of fresh buckets.
 */
export function clientAddressBucket(ip: string | null | undefined): string | undefined {
	const value = ip?.trim().toLowerCase();
	if (!value) return undefined;
	if (!value.includes(':')) return value;
	// An IPv4 address written as IPv6 (`::ffff:192.0.2.1`) is that IPv4 address.
	if (value.includes('.')) return value.slice(value.lastIndexOf(':') + 1);
	const [head, tail = ''] = value.split('::');
	const left = head ? head.split(':') : [];
	const right = value.includes('::') && tail ? tail.split(':') : [];
	const fill = value.includes('::')
		? Array(Math.max(0, 8 - left.length - right.length)).fill('0')
		: [];
	const groups = [...left, ...fill, ...right].map((g) => g.replace(/^0+(?=.)/, ''));
	return `${groups.slice(0, 4).join(':')}::/64`;
}

export async function assertPasswordGateOpen(
	db: AppDb,
	env: AppEnv,
	userId: string,
	ip: string | null | undefined
) {
	await assertAuthGateOpen(db, env, userId, 'password', { scope: clientAddressBucket(ip) });
	await assertAuthGateOpen(db, env, userId, 'password-all', { max: PASSWORD_GATE_GLOBAL_MAX });
}

/**
 * `knownEmail: false` is a sign-in attempt with an address that is not the
 * account's. It counts against its own client address, so the lockout answer is
 * the same whatever email was typed and cannot confirm the right one. It never
 * counts against the whole account: that would let anyone who does not know
 * the email lock the owner out. Without an address there is nothing it can be
 * held to, so it is not counted at all. Both paths write twice (the second
 * into a counter nothing checks), so response time cannot tell them apart.
 */
export async function recordPasswordFailure(
	db: AppDb,
	env: AppEnv,
	userId: string,
	ip: string | null | undefined,
	opts: { knownEmail?: boolean } = {}
): Promise<{ locked: boolean }> {
	const knownEmail = opts.knownEmail ?? true;
	const scope = clientAddressBucket(ip);
	if (!knownEmail && !scope) return { locked: false };
	const own = await recordAuthGateFailure(db, env, userId, 'password', { scope });
	const all = await recordAuthGateFailure(db, env, userId, 'password-all', {
		max: PASSWORD_GATE_GLOBAL_MAX,
		scope: knownEmail ? undefined : 'unknown-email'
	});
	return { locked: own.locked || (knownEmail && all.locked) };
}

/** A correct password clears this address's count and the account-wide one. */
export async function clearPasswordGate(
	db: AppDb,
	env: AppEnv,
	userId: string,
	ip: string | null | undefined
) {
	await clearAuthGate(db, env, userId, 'password', { scope: clientAddressBucket(ip) });
	await clearAuthGate(db, env, userId, 'password-all');
}

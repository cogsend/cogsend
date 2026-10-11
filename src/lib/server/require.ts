import { hasApiScope, type ApiScope } from '#lib/domain/api-scopes.js';
import { anySecretMatches, extractBearerToken } from '#lib/domain/bearer.js';
import { isFullyVerified, type SessionUser } from './auth';
import { unauthorized } from './http';
import { verifyTickToken } from './tick-token';
import type { AppDb } from './db/client';

export function requireUser(user: SessionUser | null): SessionUser {
	if (!isFullyVerified(user)) unauthorized();
	return user!;
}

/** Session-only: rejects bearer credentials (API_TOKEN machine user, API
 *  keys). Use for credential/key management — connection OAuth flows,
 *  disconnects, key rotation — which must never be reachable by a leaked
 *  token that already impersonates the user. */
export function requireSession(
	user: SessionUser | null,
	authMethod: 'session' | 'bearer' | null
): SessionUser {
	if (authMethod !== 'session' || !isFullyVerified(user)) unauthorized();
	return user!;
}

export function assertScheduler(
	request: Request,
	env: { AUTH_SECRET: string; SCHEDULER_SECRET?: string; API_TOKEN?: string }
) {
	const token = extractBearerToken(request.headers);
	// Least privilege: the session-signing AUTH_SECRET must never travel as a
	// bearer credential. Scheduler callers use SCHEDULER_SECRET (preferred) or
	// the long-lived API_TOKEN that GitHub Actions already holds.
	if (!anySecretMatches(token, [env.SCHEDULER_SECRET, env.API_TOKEN])) {
		unauthorized();
	}
}

/**
 * The tick route admits one credential beyond assertScheduler's two: the
 * Settings-minted tick token. The hook already scopes it to
 * /api/internal/tick (never /api/internal/publish), and the docs hand this
 * token to external pingers (cron-job.org, UptimeRobot) — so refusing it
 * here would 401 the documented path one layer after the hook approved it.
 * Same wire contract as the hook's check: SCHEDULER_SECRET and API_TOKEN
 * still work, AUTH_SECRET never does.
 */
export async function assertSchedulerOrTickToken(
	request: Request,
	env: { AUTH_SECRET: string; SCHEDULER_SECRET?: string; API_TOKEN?: string },
	db: AppDb
) {
	const token = extractBearerToken(request.headers);
	if (anySecretMatches(token, [env.SCHEDULER_SECRET, env.API_TOKEN])) return;
	if (await verifyTickToken(db, token)) return;
	unauthorized();
}

export function requireScope(locals: { apiKeyScopes?: string[] | null }, scope: ApiScope): void {
	const scopes = locals.apiKeyScopes;
	if (!scopes) return;
	if (!hasApiScope(scopes as ApiScope[], scope)) {
		throw Object.assign(new Error('Insufficient scope'), { status: 403 });
	}
}

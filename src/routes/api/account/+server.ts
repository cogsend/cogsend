import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { hashPassword, verifyPassword } from '$lib/server/crypto';
import { users } from '$lib/server/db/schema';
import { fail, handleError, ok } from '$lib/server/http';
import {
	assertPasswordGateOpen,
	clearPasswordGate,
	recordPasswordFailure
} from '$lib/server/auth-gate';
import { rateLimitKey } from '$lib/server/rate-limit';
import { getAdminUser, revokeOtherSessions } from '$lib/server/auth';
import { requireSession } from '$lib/server/require';
import { forgetToken } from '$lib/server/updater/saved-token';
import { emailProblem, normalizeEmail, passwordProblem } from '$lib/domain/credentials';

/**
 * The login itself: email and password.
 *
 * Session-only and re-authenticated with the current password — a leaked API key
 * must never be able to take over the account. The account lives in D1, created
 * by `npm run setup` before the first request; `npm run admin:reset` is the way
 * back in when the password is gone.
 */
export const GET: RequestHandler = async ({ locals }) => {
	try {
		requireSession(locals.user, locals.authMethod);
		return ok({ email: locals.user?.email ?? null });
	} catch (err) {
		return handleError(err);
	}
};

export const PATCH: RequestHandler = async ({ request, locals }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		const body = await request.json().catch(() => null);
		if (!body || typeof body !== 'object') return fail('Invalid JSON body', 400);
		const payload = body as Record<string, unknown>;
		const currentPassword = String(payload.currentPassword ?? '');
		if (!currentPassword) return fail('Enter your current password', 400);

		const row = await getAdminUser(locals.db);
		if (!row) return fail('This instance has no account yet', 409);
		// Same gate as the login form: a live session must not become an
		// unlimited oracle for the password (25k PBKDF2 is cheap to repeat), and
		// it is the same secret, so the counters are shared.
		await assertPasswordGateOpen(locals.db, locals.env, row.id, rateLimitKey(request.headers));
		if (!(await verifyPassword(currentPassword, row.passwordHash))) {
			const gate = await recordPasswordFailure(
				locals.db,
				locals.env,
				row.id,
				rateLimitKey(request.headers)
			);
			return fail(
				gate.locked ? 'Too many attempts — try again later' : 'Current password is incorrect',
				401
			);
		}
		await clearPasswordGate(locals.db, locals.env, row.id, rateLimitKey(request.headers));

		const wantEmail = Object.hasOwn(payload, 'email');
		const wantPassword = Object.hasOwn(payload, 'newPassword');
		const email = normalizeEmail(String(payload.email ?? ''));
		const newPassword = String(payload.newPassword ?? '');
		const emailIssue = wantEmail ? emailProblem(email) : null;
		if (emailIssue) return fail(emailIssue, 400);
		if (wantPassword) {
			const passwordIssue = passwordProblem(newPassword);
			if (passwordIssue) return fail(passwordIssue, 400);
			if (await verifyPassword(newPassword, row.passwordHash)) {
				return fail('That is already your password', 400);
			}
		}
		if (!wantEmail && !wantPassword) return fail('Nothing to change', 400);

		await locals.db
			.update(users)
			.set({
				...(wantEmail ? { email } : {}),
				...(wantPassword ? { passwordHash: await hashPassword(newPassword) } : {}),
				updatedAt: new Date()
			})
			.where(eq(users.id, row.id));

		// A password change invalidates every session, including this one: the
		// client signs in again with the new password. It also drops the update
		// token saved under the old one; re-locking it here would add two more
		// password derivations to a request that already runs three, past the
		// Workers Free CPU budget.
		if (wantPassword) {
			await revokeOtherSessions(locals.db, row.id, undefined);
			await forgetToken(locals.db);
		}
		return ok({ email: wantEmail ? email : user.email, reauth: wantPassword });
	} catch (err) {
		return handleError(err);
	}
};

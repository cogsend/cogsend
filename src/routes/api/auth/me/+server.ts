import type { RequestHandler } from './$types';
import { getUserById, isFullyVerified, needsTotpEnroll } from '#lib/server/auth.js';
import { clearMfaCookie, clearSessionCookie } from '#lib/server/cookies.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import { requireSession } from '#lib/server/require.js';
import {
	assertAuthGateOpen,
	assertPasswordGateOpen,
	clearAuthGate,
	clearPasswordGate,
	recordAuthGateFailure,
	recordPasswordFailure
} from '#lib/server/auth-gate.js';
import { rateLimitKey } from '#lib/server/rate-limit.js';
import { checkUserCode } from '#lib/server/totp.js';
import { verifyPassword } from '#lib/server/crypto.js';
import { deleteUserAndData } from '#lib/server/user-data.js';
import { wouldOrphanInstance } from '#lib/server/users.js';

export const GET: RequestHandler = async ({ locals }) => {
	const user = locals.user;
	return ok({
		user: isFullyVerified(user)
			? { id: user!.id, email: user!.email, timezone: user!.timezone, role: user!.role }
			: null,
		needsEnroll: needsTotpEnroll(user),
		totpEnabled: Boolean(user?.totpEnabled)
	});
};

/**
 * Permanently delete the account and all associated data (drafts, connections,
 * targets, keys — everything cascades off users).
 *
 * Session-only, and re-authenticated: a live session alone must not be able to
 * destroy the instance (an unattended browser, a stolen cookie, or a script
 * holding a session token). Both factors are checked here — the password and a
 * current code — and both are throttled by the same gates the login form uses,
 * so this cannot become a new place to guess either of them. On a local instance
 * with `SKIP_TOTP`, where the password is the whole login, the code is not asked
 * for, exactly as on the sign-in form.
 */
export const DELETE: RequestHandler = async ({ request, locals, cookies, url }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		const body = await request.json().catch(() => null);
		const password = String((body as Record<string, unknown> | null)?.password ?? '');
		const code = String((body as Record<string, unknown> | null)?.code ?? '');
		if (!password) return fail('Enter your password to confirm', 400);
		if (!locals.env.skipTotp && !code) {
			return fail('Enter a code from your authenticator app to confirm', 400);
		}
		const row = await getUserById(locals.db, user.id);
		if (!row) return fail('Not found', 404);

		await assertPasswordGateOpen(locals.db, locals.env, row.id, rateLimitKey(request.headers));
		if (!(await verifyPassword(password, row.passwordHash))) {
			const gate = await recordPasswordFailure(
				locals.db,
				locals.env,
				row.id,
				rateLimitKey(request.headers)
			);
			return fail(
				gate.locked ? 'Too many attempts — try again later' : 'That password is not correct',
				401
			);
		}
		await clearPasswordGate(locals.db, locals.env, row.id, rateLimitKey(request.headers));

		if (!locals.env.skipTotp) {
			await assertAuthGateOpen(locals.db, locals.env, row.id, 'totp-gate');
			const check = await checkUserCode(locals.db, locals.env, row, code);
			if (!check.ok) {
				const gate = await recordAuthGateFailure(locals.db, locals.env, row.id, 'totp-gate');
				return fail(
					gate.locked ? 'Too many attempts — try again later' : 'That code is not valid',
					401
				);
			}
			await clearAuthGate(locals.db, locals.env, row.id, 'totp-gate');
		}

		// An admin with members and no fellow admin would leave them stranded.
		if (await wouldOrphanInstance(locals.db, row.id)) {
			return fail('Make another account an admin before deleting yours', 409);
		}

		// Media goes in installments when there is too much for one request:
		// the account stays until the objects are gone, and the caller is told
		// to come back (see #lib/server/user-data).
		const { deletedMedia, done } = await deleteUserAndData(locals.db, locals.media, row.id);
		if (!done) {
			return ok(
				{
					ok: false,
					deletedMedia,
					// Both factors are re-checked on every call, so say so: the
					// caller needs a fresh authenticator code, not the same one.
					message: 'Still deleting media — call again with a new code to continue'
				},
				202
			);
		}
		clearSessionCookie(cookies, locals.env, url.host);
		clearMfaCookie(cookies, locals.env, url.host);
		return ok({ ok: true });
	} catch (err) {
		return handleError(err);
	}
};

import type { RequestHandler } from './$types';
import { checkAccountPassword } from '#lib/server/auth-gate.js';
import { getUserById } from '#lib/server/auth.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import { rateLimitKey } from '#lib/server/rate-limit.js';
import { requireAdminSession } from '#lib/server/require.js';
import { SavedTokenError, unlockToken } from '#lib/server/updater/saved-token.js';

/**
 * Open the saved Cloudflare token with the account password, for one update.
 * Answers with a key the browser sends with each step instead of the token,
 * which never leaves the server (see #lib/server/updater/saved-token).
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const admin = requireAdminSession(locals.user, locals.authMethod);
		const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
		const password = typeof body?.password === 'string' ? body.password : '';
		if (!password) return fail('Enter your CogSend password', 400);
		const user = await getUserById(locals.db, admin.id);
		if (!user) return fail('Not found', 404);
		const check = await checkAccountPassword(
			locals.db,
			locals.env,
			user,
			password,
			rateLimitKey(request.headers)
		);
		if (check !== 'ok') {
			return fail(
				check === 'locked' ? 'Too many attempts — try again later' : 'Your password is incorrect',
				401
			);
		}
		return ok({ unlockKey: await unlockToken(locals.db, password) });
	} catch (err) {
		if (err instanceof SavedTokenError) return fail(err.message, err.status);
		return handleError(err);
	}
};

import type { RequestHandler } from './$types';
import { checkAccountPassword } from '$lib/server/auth-gate';
import { getAdminUser } from '$lib/server/auth';
import { fail, handleError, ok } from '$lib/server/http';
import { rateLimitKey } from '$lib/server/rate-limit';
import { requireSession } from '$lib/server/require';
import { SavedTokenError, unlockToken } from '$lib/server/updater/saved-token';

/**
 * Open the saved Cloudflare token with the account password, for one update.
 * Answers with a key the browser sends with each step instead of the token,
 * which never leaves the server (see $lib/server/updater/saved-token).
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		requireSession(locals.user, locals.authMethod);
		const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
		const password = typeof body?.password === 'string' ? body.password : '';
		if (!password) return fail('Enter your CogSend password', 400);
		const user = await getAdminUser(locals.db);
		if (!user) return fail('This instance has no account yet', 409);
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

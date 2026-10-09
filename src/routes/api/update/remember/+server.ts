import type { RequestHandler } from './$types';
import { checkAccountPassword } from '$lib/server/auth-gate';
import { getAdminUser } from '$lib/server/auth';
import { fail, handleError, ok } from '$lib/server/http';
import { rateLimitKey } from '$lib/server/rate-limit';
import { requireSession } from '$lib/server/require';
import { forgetToken, saveToken } from '$lib/server/updater/saved-token';

/**
 * Remember the Cloudflare token for later updates, locked with the account
 * password (see $lib/server/updater/saved-token), or forget it. Session only:
 * an API key must never be able to plant or read the token that replaces this
 * instance's code. Answers with the token's last four characters at most.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		requireSession(locals.user, locals.authMethod);
		const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
		const token = typeof body?.token === 'string' ? body.token.trim() : '';
		const password = typeof body?.password === 'string' ? body.password : '';
		if (!/^[\w-]{20,200}$/.test(token))
			return fail('That does not look like a Cloudflare API token', 400);
		if (!password) return fail('Enter your CogSend password to lock the token with', 400);
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
		return ok({ savedToken: await saveToken(locals.db, token, password) });
	} catch (err) {
		return handleError(err);
	}
};

export const DELETE: RequestHandler = async ({ locals }) => {
	try {
		requireSession(locals.user, locals.authMethod);
		await forgetToken(locals.db);
		return ok({ savedToken: null });
	} catch (err) {
		return handleError(err);
	}
};

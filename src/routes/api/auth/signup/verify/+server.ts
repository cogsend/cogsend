import type { RequestHandler } from './$types';
import { getUserById } from '#lib/server/auth.js';
import { setMfaCookie } from '#lib/server/cookies.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import { registrationConfig } from '#lib/server/registration.js';
import { confirmEmail, readVerifyEmailToken } from '#lib/server/signup.js';
import { startEnrollChallenge } from '#lib/server/totp.js';

/**
 * The button behind the confirmation link. A POST rather than the link itself,
 * so a mail scanner that fetches every URL in a message does not confirm the
 * address on its own.
 *
 * An account that becomes active goes straight on to authenticator setup, like
 * a first sign-in; one that lands on the waitlist is told so.
 */
export const POST: RequestHandler = async ({ request, locals, cookies, url }) => {
	try {
		const config = await registrationConfig(locals.db, locals.env);
		if (!config.enabled) return fail('Not found', 404);
		const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
		const userId = await readVerifyEmailToken(locals.env, body?.token);
		if (!userId) return fail('This link has expired. Sign up again to get a new one.', 400);

		const status = await confirmEmail(locals.db, config, userId);
		if (!status) {
			// Already confirmed (a second click) or gone: either way, signing in
			// is what happens next, and the sign-in form explains any state.
			return ok({ next: 'login' });
		}
		if (status !== 'active') return ok({ next: 'waitlist' });

		const user = await getUserById(locals.db, userId);
		if (!user) return ok({ next: 'login' });
		const token = await startEnrollChallenge(locals.db, locals.env, user.id, true);
		setMfaCookie(cookies, locals.env, url.host, token);
		return ok({ next: 'enroll' });
	} catch (err) {
		return handleError(err);
	}
};

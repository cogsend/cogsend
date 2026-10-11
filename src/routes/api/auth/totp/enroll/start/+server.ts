import type { RequestHandler } from './$types';
import { setMfaCookie } from '#lib/server/cookies.js';
import { handleError, ok } from '#lib/server/http.js';
import { enrollStart, MFA_COOKIE, resolveEnrollToken } from '#lib/server/totp.js';

export const POST: RequestHandler = async ({ locals, cookies, url }) => {
	try {
		const existing = cookies.get(MFA_COOKIE);
		const token = await resolveEnrollToken(locals.db, locals.env, {
			user: locals.user,
			mfaRaw: existing,
			remember: true
		});
		if (token !== existing) setMfaCookie(cookies, locals.env, url.host, token);
		const data = await enrollStart(locals.db, locals.env, token);
		return ok(data);
	} catch (err) {
		return handleError(err);
	}
};

import type { RequestHandler } from './$types';
import { clearMfaCookie, setSessionCookie } from '#lib/server/cookies.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import { enrollConfirm, MFA_COOKIE } from '#lib/server/totp.js';

export const POST: RequestHandler = async ({ request, locals, cookies, url }) => {
	try {
		const body = await request.json().catch(() => null);
		if (!body || typeof body !== 'object') return fail('Invalid JSON body', 400);
		const code = String(body.code || '');
		const raw = cookies.get(MFA_COOKIE);
		if (!raw) return fail('Setup expired — sign in again', 401);
		const result = await enrollConfirm(locals.db, locals.env, raw, code);
		clearMfaCookie(cookies, locals.env, url.host);
		setSessionCookie(cookies, locals.env, url.host, result.raw, result.maxAge);
		return ok({ user: result.user });
	} catch (err) {
		return handleError(err);
	}
};

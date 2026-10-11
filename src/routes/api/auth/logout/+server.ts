import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { destroySession, getSessionUser, SESSION_COOKIE } from '#lib/server/auth.js';
import { clearMfaCookie, clearSessionCookie } from '#lib/server/cookies.js';
import { mfaChallenges } from '#lib/server/db/schema.js';
import { ok } from '#lib/server/http.js';

export const POST: RequestHandler = async ({ locals, cookies, url }) => {
	// Look up the session owner first: MFA challenges must die with logout or
	// a stolen cog_mfa cookie stays usable for its full 10-minute window.
	const raw = cookies.get(SESSION_COOKIE);
	const session = await getSessionUser(locals.db, locals.env, raw);
	await destroySession(locals.db, locals.env, raw);
	if (session) {
		await locals.db.delete(mfaChallenges).where(eq(mfaChallenges.userId, session.user.id));
	}
	clearSessionCookie(cookies, locals.env, url.host);
	clearMfaCookie(cookies, locals.env, url.host);
	return ok({ ok: true });
};

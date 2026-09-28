import type { RequestHandler } from './$types';
import { createSession, getAdminUser } from '$lib/server/auth';
import { verifyPassword } from '$lib/server/crypto';
import {
	assertPasswordGateOpen,
	clearPasswordGate,
	recordPasswordFailure
} from '$lib/server/auth-gate';
import { rateLimitKey } from '$lib/server/rate-limit';
import { setMfaCookie, setSessionCookie } from '$lib/server/cookies';
import { fail, handleError, ok } from '$lib/server/http';
import { startEnrollChallenge, startLoginChallenge } from '$lib/server/totp';

export const POST: RequestHandler = async ({ request, locals, cookies, url }) => {
	try {
		const body = await request.json().catch(() => null);
		if (!body || typeof body !== 'object') return fail('Invalid JSON body', 400);
		const email = String(body.email || '').trim();
		const password = String(body.password || '');
		const remember = body.remember !== false;
		if (!email || !password) return fail('Email and password required');
		// The single account: `npm run setup` wrote it before the first request.
		const admin = await getAdminUser(locals.db);
		if (!admin) return fail('This instance has no account yet', 409);
		// The gate is keyed on the single admin row, so an unknown email must not
		// advance its account-wide count — otherwise anyone can lock the real
		// owner out with guesses at a made-up address. It counts against its own
		// client address only (see recordPasswordFailure).
		const knownEmail = email.trim().toLowerCase() === admin.email.trim().toLowerCase();
		const ip = rateLimitKey(request.headers);
		await assertPasswordGateOpen(locals.db, locals.env, admin.id, ip);
		// The key derivation runs against the account's own hash whatever email
		// was typed, so a wrong email takes as long as a wrong password and the
		// response time cannot confirm the address.
		const passwordOk = await verifyPassword(password, admin.passwordHash);
		if (!knownEmail || !passwordOk) {
			const failGate = await recordPasswordFailure(locals.db, locals.env, admin.id, ip, {
				knownEmail
			});
			if (failGate.locked) return fail('Too many attempts — try again in 15 minutes', 401);
			return fail('Invalid credentials', 401);
		}
		await clearPasswordGate(locals.db, locals.env, admin.id, ip);
		if (locals.env.skipTotp) {
			// Local dev: password is the whole login. Mint a verified session.
			const { raw, maxAge } = await createSession(
				locals.db,
				locals.env,
				admin.id,
				remember,
				true,
				admin.passwordHash
			);
			setSessionCookie(cookies, locals.env, url.host, raw, maxAge);
			return ok({ user: { id: admin.id, email: admin.email } });
		}
		if (admin.totpEnabled) {
			const token = await startLoginChallenge(locals.db, locals.env, admin.id, remember);
			setMfaCookie(cookies, locals.env, url.host, token);
			return ok({ needTotp: true });
		}
		const token = await startEnrollChallenge(locals.db, locals.env, admin.id, remember);
		setMfaCookie(cookies, locals.env, url.host, token);
		return ok({ needEnroll: true });
	} catch (err) {
		return handleError(err);
	}
};

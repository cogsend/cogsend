import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { normalizeEmail } from '#lib/domain/credentials.js';
import { statusProblem } from '#lib/domain/registration.js';
import { createSession, getAdminUser } from '#lib/server/auth.js';
import { first } from '#lib/server/db/client.js';
import { users } from '#lib/server/db/schema.js';
import { verifyPassword } from '#lib/server/crypto.js';
import {
	assertPasswordGateOpen,
	clearPasswordGate,
	recordPasswordFailure
} from '#lib/server/auth-gate.js';
import { rateLimitKey } from '#lib/server/rate-limit.js';
import { setMfaCookie, setSessionCookie } from '#lib/server/cookies.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import { startEnrollChallenge, startLoginChallenge } from '#lib/server/totp.js';

export const POST: RequestHandler = async ({ request, locals, cookies, url }) => {
	try {
		const body = await request.json().catch(() => null);
		if (!body || typeof body !== 'object') return fail('Invalid JSON body', 400);
		const email = String(body.email || '').trim();
		const password = String(body.password || '');
		const remember = body.remember !== false;
		if (!email || !password) return fail('Email and password required');
		// The owner is read first on every attempt: a single-user instance has
		// no other row, and on a multi-user one it holds the per-address
		// lockout and the hash a wrong email is checked against.
		const owner = await getAdminUser(locals.db);
		if (!owner) return fail('This instance has no account yet', 409);
		const account = await first(
			locals.db
				.select()
				.from(users)
				.where(eq(users.email, normalizeEmail(email)))
		);
		// An unknown email must not advance any account-wide count, or anyone
		// could lock a real user out with guesses at a made-up address. It counts
		// against its own client address only (see recordPasswordFailure).
		const knownEmail = Boolean(account);
		const target = account ?? owner;
		const gate = { addressUserId: owner.id };
		const ip = rateLimitKey(request.headers);
		await assertPasswordGateOpen(locals.db, locals.env, target.id, ip, gate);
		// The key derivation runs against a real hash whatever email was typed,
		// so a wrong email takes as long as a wrong password and the response
		// time cannot confirm the address.
		const passwordOk = await verifyPassword(password, target.passwordHash);
		if (!knownEmail || !passwordOk) {
			const failGate = await recordPasswordFailure(locals.db, locals.env, target.id, ip, {
				knownEmail,
				...gate
			});
			if (failGate.locked) return fail('Too many attempts — try again in 15 minutes', 401);
			return fail('Invalid credentials', 401);
		}
		await clearPasswordGate(locals.db, locals.env, target.id, ip, gate);
		// Only after the password checked out, so it confirms nothing.
		const problem = statusProblem(target.status);
		if (problem) return fail(problem, 403, { status: target.status });
		if (locals.env.skipTotp) {
			// Local dev: password is the whole login. Mint a verified session.
			const { raw, maxAge } = await createSession(
				locals.db,
				locals.env,
				target.id,
				remember,
				true,
				target.passwordHash
			);
			setSessionCookie(cookies, locals.env, url.host, raw, maxAge);
			return ok({ user: { id: target.id, email: target.email } });
		}
		if (target.totpEnabled) {
			const token = await startLoginChallenge(locals.db, locals.env, target.id, remember);
			setMfaCookie(cookies, locals.env, url.host, token);
			return ok({ needTotp: true });
		}
		const token = await startEnrollChallenge(locals.db, locals.env, target.id, remember);
		setMfaCookie(cookies, locals.env, url.host, token);
		return ok({ needEnroll: true });
	} catch (err) {
		return handleError(err);
	}
};

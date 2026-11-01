import type { RequestHandler } from './$types';
import { emailProblem, normalizeEmail, passwordProblem } from '#lib/domain/credentials.js';
import { createSession } from '#lib/server/auth.js';
import { readStoredAppName } from '#lib/server/app-settings.js';
import { setMfaCookie, setSessionCookie } from '#lib/server/cookies.js';
import { hashPassword } from '#lib/server/crypto.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import { bindInvite, claimInvite, releaseInvite } from '#lib/server/invites.js';
import { canVerifyEmail, registrationConfig } from '#lib/server/registration.js';
import {
	checkSignupFormToken,
	insertMember,
	plannedStatus,
	sendVerificationEmail,
	verifyEmailToken
} from '#lib/server/signup.js';
import { startEnrollChallenge } from '#lib/server/totp.js';

/**
 * Public sign-up, for instances that opted in with REGISTRATION (see
 * docs/multi-user.md). Answers 404 while it is off, exactly like a route that
 * does not exist.
 *
 * What a caller can learn here is kept to what they could learn anyway:
 *   * With email verification (Resend and NOTIFY_FROM configured), every
 *     accepted request gets the same "check your inbox" answer, whether the
 *     address was new or already had an account.
 *   * Without it, an address that is taken gets the waitlist answer. In `open`
 *     mode a new address goes straight to authenticator setup instead, so the
 *     two can be told apart; docs/multi-user.md says so, and the edge rate
 *     limit on this path is what bounds that.
 *
 * The honeypot field (`website`) is invisible to people; a form that fills it
 * is told it was accepted and nothing is written.
 */
type Next = 'verify-email' | 'waitlist';

function accepted(next: Next) {
	return ok({ next }, 202);
}

export const POST: RequestHandler = async ({ request, locals, cookies, url }) => {
	try {
		const config = await registrationConfig(locals.db, locals.env);
		if (!config.enabled) return fail('Not found', 404);

		const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
		if (!body || typeof body !== 'object') return fail('Invalid JSON body', 400);
		const verifyEmail = canVerifyEmail(locals.env);
		const quietAnswer: Next = verifyEmail ? 'verify-email' : 'waitlist';

		if (typeof body.website === 'string' && body.website.trim()) return accepted(quietAnswer);
		const form = await checkSignupFormToken(locals.env, body.formToken);
		if (form !== 'ok') {
			return fail(
				form === 'too-fast'
					? 'That was quick. Wait a moment and try again.'
					: 'This form has expired. Reload the page and try again.',
				400
			);
		}

		const invite = typeof body.invite === 'string' ? body.invite.trim() : '';
		if (config.mode === 'off' && !invite) {
			return fail('Sign-up is closed on this instance right now', 403);
		}

		const email = normalizeEmail(String(body.email ?? ''));
		const password = String(body.password ?? '');
		const problem = emailProblem(email) ?? passwordProblem(password);
		if (problem) return fail(problem, 400);

		const inviteId = invite ? await claimInvite(locals.db, locals.env, invite) : null;
		if (invite && !inviteId) {
			return fail('That invite link is not valid any more. Ask for a new one.', 400);
		}

		const passwordHash = await hashPassword(password);
		const created = await insertMember(locals.db, {
			email,
			passwordHash,
			planned: plannedStatus({ config, invited: Boolean(inviteId), verifyEmail }),
			cap: config.cap
		});
		if (!created) {
			// Taken. The invite was not used on anybody, so it goes back.
			if (inviteId) await releaseInvite(locals.db, inviteId);
			return accepted(quietAnswer);
		}
		if (inviteId) await bindInvite(locals.db, inviteId, created.id);

		if (created.status === 'unverified') {
			const token = await verifyEmailToken(locals.env, created.id);
			const link = `${url.origin}/signup/verify?token=${encodeURIComponent(token)}`;
			const appName = (await readStoredAppName(locals.db)) ?? locals.env.APP_NAME;
			try {
				await sendVerificationEmail(locals.env, { to: email, link, appName });
			} catch (err) {
				// The account stays unconfirmed and is released after a day; the
				// answer must not differ from the one a taken address gets.
				console.error('[signup] verification email failed', err);
			}
			return accepted('verify-email');
		}
		if (created.status !== 'active') return accepted('waitlist');

		if (locals.env.skipTotp) {
			const { raw, maxAge } = await createSession(
				locals.db,
				locals.env,
				created.id,
				true,
				true,
				passwordHash
			);
			setSessionCookie(cookies, locals.env, url.host, raw, maxAge);
			return ok({ user: { id: created.id, email } });
		}
		const token = await startEnrollChallenge(locals.db, locals.env, created.id, true);
		setMfaCookie(cookies, locals.env, url.host, token);
		return ok({ needEnroll: true });
	} catch (err) {
		return handleError(err);
	}
};

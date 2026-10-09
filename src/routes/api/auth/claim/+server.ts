import { sql } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { timingSafeEqual, utf8Bytes } from '$lib/domain/bytes';
import { emailProblem, normalizeEmail, passwordProblem } from '$lib/domain/credentials';
import { createSession, getAdminUser, needsSetup } from '$lib/server/auth';
import { setMfaCookie, setSessionCookie } from '$lib/server/cookies';
import { hashPassword, hmacHex } from '$lib/server/crypto';
import { fail, handleError, ok } from '$lib/server/http';
import { startEnrollChallenge } from '$lib/server/totp';

/** Both sides are MACed before the comparison, so it runs over equal-length
 *  digests and its timing says nothing about the key's length or prefix. */
const CLAIM_LABEL = 'claim:setup-key:v1';

/**
 * Creating the single account from the browser, for an instance nobody has
 * claimed yet (a Deploy to Cloudflare install has no terminal to run
 * `npm run setup` from).
 *
 * The proof is APP_ENCRYPTION_KEY: only whoever deployed the Worker typed it,
 * so finding the URL first is not enough to own the instance. The edge rate
 * limiter covers this path (see rate-limit.ts); there is no account yet for the
 * per-account lockout to count against, and a 32+ character key is not
 * something a burst of guesses gets near.
 */
export const POST: RequestHandler = async ({ request, locals, cookies, url }) => {
	try {
		const body = await request.json().catch(() => null);
		if (!body || typeof body !== 'object') return fail('Invalid JSON body', 400);
		const setupKey = String(body.setupKey ?? '').trim();
		const email = normalizeEmail(String(body.email ?? ''));
		const password = String(body.password ?? '');

		if (!(await needsSetup(locals.db))) return fail('This instance already has an account', 409);
		if (!setupKey) return fail('Enter the encryption key you set when you deployed', 400);

		const [given, expected] = await Promise.all([
			hmacHex(CLAIM_LABEL, setupKey),
			// Trimmed like the input: a secret pasted with a trailing newline is the same key.
			hmacHex(CLAIM_LABEL, locals.env.APP_ENCRYPTION_KEY.trim())
		]);
		if (!timingSafeEqual(utf8Bytes(given), utf8Bytes(expected))) {
			return fail('That is not the encryption key this instance was deployed with', 401);
		}

		const problem = emailProblem(email) ?? passwordProblem(password);
		if (problem) return fail(problem, 400);

		const id = crypto.randomUUID();
		const now = Date.now();
		const passwordHash = await hashPassword(password);
		// One statement, so two claims racing each other cannot both insert:
		// the second sees the first's row and writes nothing.
		await locals.db.run(sql`
			INSERT INTO users (id, email, password_hash, display_name, timezone, created_at, updated_at,
				totp_enabled, totp_secret_enc, totp_enrolled_at, totp_last_step, settings_json)
			SELECT ${id}, ${email}, ${passwordHash}, NULL, 'UTC', ${now}, ${now}, 0, NULL, NULL, NULL, NULL
			WHERE NOT EXISTS (SELECT 1 FROM users)`);
		const admin = await getAdminUser(locals.db);
		if (!admin || admin.id !== id) return fail('This instance already has an account', 409);

		if (locals.env.skipTotp) {
			// Local dev, as in api/auth/login: the password is the whole login.
			const { raw, maxAge } = await createSession(
				locals.db,
				locals.env,
				admin.id,
				true,
				true,
				admin.passwordHash
			);
			setSessionCookie(cookies, locals.env, url.host, raw, maxAge);
			return ok({ user: { id: admin.id, email: admin.email } });
		}
		const token = await startEnrollChallenge(locals.db, locals.env, admin.id, true);
		setMfaCookie(cookies, locals.env, url.host, token);
		return ok({ needEnroll: true });
	} catch (err) {
		return handleError(err);
	}
};

import type { RequestHandler } from './$types';
import { fail, handleError, ok } from '#lib/server/http.js';
import { requireSession } from '#lib/server/require.js';
import { readTickToken, revokeTickToken, rotateTickToken } from '#lib/server/tick-token.js';

/**
 * The credential an external cron uses to tick this instance.
 *
 * Session-only, like API-key management: a leaked token must not be able to
 * mint or rotate its own replacement. The raw value is returned exactly once,
 * on creation, and only its hash is stored.
 */

export const GET: RequestHandler = async ({ locals }) => {
	try {
		requireSession(locals.user, locals.authMethod);
		const status = await readTickToken(locals.db);
		return ok(status);
	} catch (err) {
		return handleError(err);
	}
};

export const POST: RequestHandler = async ({ locals }) => {
	try {
		requireSession(locals.user, locals.authMethod);
		const { token, prefix, createdAt } = await rotateTickToken(locals.db);
		return ok({ token, prefix, createdAt, rotated: true }, 201);
	} catch (err) {
		return handleError(err);
	}
};

export const DELETE: RequestHandler = async ({ locals }) => {
	try {
		requireSession(locals.user, locals.authMethod);
		const revoked = await revokeTickToken(locals.db);
		if (!revoked) return fail('No tick token to revoke', 404);
		return ok({ ok: true, revoked: true });
	} catch (err) {
		return handleError(err);
	}
};

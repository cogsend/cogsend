import type { RequestHandler } from './$types';
import { fail, handleError, ok } from '#lib/server/http.js';
import { revokeInvite } from '#lib/server/invites.js';
import { requireAdminSession } from '#lib/server/require.js';

export const DELETE: RequestHandler = async ({ locals, params }) => {
	try {
		requireAdminSession(locals.user, locals.authMethod);
		if (!(await revokeInvite(locals.db, params.id))) return fail('Not found', 404);
		return ok({ ok: true });
	} catch (err) {
		return handleError(err);
	}
};

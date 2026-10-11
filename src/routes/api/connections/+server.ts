import type { RequestHandler } from './$types';
import { listConnections } from '#lib/server/connection-list.js';
import { handleError, ok } from '#lib/server/http.js';
import { requireScope, requireUser } from '#lib/server/require.js';

export const GET: RequestHandler = async ({ locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'read');
		return ok(await listConnections(locals.db, locals.env, user.id));
	} catch (err) {
		return handleError(err);
	}
};

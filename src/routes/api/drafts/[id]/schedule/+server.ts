import type { RequestHandler } from './$types';
import { handleError, ok } from '#lib/server/http.js';
import { requireScope, requireUser } from '#lib/server/require.js';
import { scheduleDraft } from '#lib/server/api/operations.js';

export const POST: RequestHandler = async ({ params, request, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		const body = await request.json().catch(() => null);
		return ok(await scheduleDraft(locals, user.id, params.id, body));
	} catch (err) {
		return handleError(err);
	}
};

import type { RequestHandler } from './$types';
import { handleError, ok } from '#lib/server/http.js';
import { publishDraft } from '#lib/server/api/operations.js';
import { requireScope, requireUser } from '#lib/server/require.js';

export const POST: RequestHandler = async ({ params, request, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		const body = await request.json().catch(() => null);
		return ok(await publishDraft(locals, user.id, params.id, body));
	} catch (err) {
		return handleError(err);
	}
};

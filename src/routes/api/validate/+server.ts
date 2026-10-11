import type { RequestHandler } from './$types';
import { fail, handleError, ok } from '#lib/server/http.js';
import { validatePost } from '#lib/server/api/operations.js';
import { requireScope, requireUser } from '#lib/server/require.js';
export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		requireUser(locals.user);
		requireScope(locals, 'read');
		const body = await request.json().catch(() => null);
		if (!body || typeof body !== 'object') return fail('Invalid JSON body', 400);
		return ok(validatePost(body));
	} catch (err) {
		return handleError(err);
	}
};

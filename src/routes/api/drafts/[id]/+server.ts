import type { RequestHandler } from './$types';
import { deleteDraft, getDraft, updateDraft } from '#lib/server/api/operations.js';
import { handleError, ok } from '#lib/server/http.js';
import { requireScope, requireUser } from '#lib/server/require.js';

export const GET: RequestHandler = async ({ params, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'read');
		return ok(await getDraft(locals, user.id, params.id));
	} catch (err) {
		return handleError(err);
	}
};

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		const body = await request.json().catch(() => null);
		return ok(await updateDraft(locals, user.id, params.id, body));
	} catch (err) {
		return handleError(err);
	}
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		return ok(await deleteDraft(locals, user.id, params.id));
	} catch (err) {
		return handleError(err);
	}
};

import type { RequestHandler } from './$types';
import { handleError, ok } from '#lib/server/http.js';
import { requireScope, requireUser } from '#lib/server/require.js';
import { deleteDraftVariant, setDraftVariant } from '#lib/server/api/operations.js';

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		const body = await request.json().catch(() => null);
		return ok(await setDraftVariant(locals, user.id, params.id, body));
	} catch (error) {
		return handleError(error);
	}
};

export const DELETE: RequestHandler = async ({ params, url, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		return ok(
			await deleteDraftVariant(locals, user.id, params.id, url.searchParams.get('platform'))
		);
	} catch (error) {
		return handleError(error);
	}
};

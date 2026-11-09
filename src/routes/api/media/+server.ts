import type { RequestHandler } from './$types';
import { handleError, ok } from '#lib/server/http.js';
import {
	LIBRARY_PAGE_LIMIT,
	LIBRARY_PAGE_MAX_LIMIT,
	listMediaLibrary,
	parseLibraryCursor
} from '#lib/server/media-library.js';
import { parseListLimit } from '#lib/server/post-list.js';
import { requireScope, requireUser } from '#lib/server/require.js';

export const GET: RequestHandler = async ({ locals, url }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'read');
		const limit = parseListLimit(
			url.searchParams.get('limit'),
			LIBRARY_PAGE_LIMIT,
			LIBRARY_PAGE_MAX_LIMIT
		);
		const before = parseLibraryCursor(url.searchParams.get('before'));
		return ok(await listMediaLibrary(locals.db, user.id, { limit, before }));
	} catch (err) {
		return handleError(err);
	}
};

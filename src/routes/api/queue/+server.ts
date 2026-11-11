import type { RequestHandler } from './$types';
import { handleError, ok } from '#lib/server/http.js';
import {
	QUEUE_LIST_LIMIT,
	QUEUE_LIST_MAX_LIMIT,
	loadQueueList,
	parseListLimit,
	parseListSearch,
	parseQueueCursor
} from '#lib/server/post-list.js';
import { requireScope, requireUser } from '#lib/server/require.js';

export const GET: RequestHandler = async ({ locals, url }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'read');
		const limit = parseListLimit(
			url?.searchParams.get('limit'),
			QUEUE_LIST_LIMIT,
			QUEUE_LIST_MAX_LIMIT
		);
		return ok(
			await loadQueueList(locals.db, user.id, limit, {
				before: parseQueueCursor(url?.searchParams.get('before')),
				q: parseListSearch(url?.searchParams.get('q'))
			})
		);
	} catch (err) {
		return handleError(err);
	}
};

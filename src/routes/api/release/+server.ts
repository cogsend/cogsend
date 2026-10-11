import type { RequestHandler } from './$types';
import { handleError, ok } from '#lib/server/http.js';
import { checkForRelease } from '#lib/server/release.js';
import { requireScope, requireUser } from '#lib/server/require.js';

/**
 * "Is a newer release out?" — asked by the Settings page so the operator does
 * not have to remember to check the repository.
 *
 * Session-scoped like the rest of Settings, cached in D1 (see #lib/server/release),
 * and never fatal: a failure returns `latest: null` with an `error` string and
 * the UI stays quiet. `?refresh=1` forces a fresh look.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
	try {
		requireUser(locals.user);
		requireScope(locals, 'read');
		const refresh = url.searchParams.get('refresh') === '1';
		return ok(await checkForRelease(locals.db, { refresh }));
	} catch (err) {
		return handleError(err);
	}
};

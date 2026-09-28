import type { RequestHandler } from './$types';
import { handleError, ok } from '$lib/server/http';
import { parseTimeZone } from '$lib/domain/time-zone';
import { loadInsights } from '$lib/server/insights-report';
import { requireScope, requireUser } from '$lib/server/require';

export const GET: RequestHandler = async ({ locals, url }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'read');
		// The page sends the browser's zone, so days are the viewer's own even
		// before the stored zone has caught up with it.
		const zone = parseTimeZone(url.searchParams.get('tz')) ?? user.timezone;
		return ok(await loadInsights(locals.db, user.id, url.searchParams.get('days'), zone));
	} catch (err) {
		return handleError(err);
	}
};

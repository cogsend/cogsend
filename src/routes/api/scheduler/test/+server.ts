import type { RequestHandler } from './$types';
import { handleError, ok } from '#lib/server/http.js';
import { requireScope, requireUser } from '#lib/server/require.js';
import { runSchedulerTick } from '#lib/server/scheduler.js';

/**
 * "Tick now", for the Settings card that explains scheduled publishing.
 *
 * It runs the same pass the cron runs, in-process, so an operator can tell
 * whether the app side works before blaming their pinger. It needs `write`
 * because it can publish: a read-only key must not be able to.
 */
export const POST: RequestHandler = async ({ locals }) => {
	try {
		requireUser(locals.user);
		requireScope(locals, 'write');
		const result = await runSchedulerTick(locals.db, locals.env, {
			store: locals.media,
			queue: locals.queue,
			budget: locals.budget
		});
		return ok({ processed: result.processed, deferred: result.deferred, ok: true });
	} catch (err) {
		return handleError(err);
	}
};

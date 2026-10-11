import type { RequestHandler } from './$types';
import { handleError, ok } from '#lib/server/http.js';
import { assertSchedulerOrTickToken } from '#lib/server/require.js';
import { runSchedulerTick } from '#lib/server/scheduler.js';

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		// The hook admits three credentials for this path: SCHEDULER_SECRET and
		// API_TOKEN (every internal route) plus the Settings tick token (this
		// route only). Re-check here so the route enforces it itself instead of
		// trusting every caller to have run the hook — and so the Settings
		// token, the one the docs hand to external pingers, actually works.
		await assertSchedulerOrTickToken(request, locals.env, locals.db);
		// The cron pinger can time out mid-tick; waitUntil keeps the current
		// invocation alive up to 30s past the disconnect. A large batch can
		// still outlast that — leftovers stay due and run on the next tick.
		const task = runSchedulerTick(locals.db, locals.env, {
			store: locals.media,
			queue: locals.queue,
			budget: locals.budget
		});
		locals.waitUntil(task.then(() => undefined).catch(() => undefined));
		const result = await task;
		return ok(result);
	} catch (err) {
		return handleError(err);
	}
};

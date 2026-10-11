import type { RequestHandler } from './$types';
import { fail, handleError, ok } from '#lib/server/http.js';
import { assertScheduler } from '#lib/server/require.js';
import { consumePublishJob } from '#lib/server/scheduler.js';

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		assertScheduler(request, locals.env);
		const body = await request.json().catch(() => null);
		if (!body || typeof body !== 'object') return fail('Invalid JSON body', 400);
		const targetId = String(body.targetId || '');
		if (!targetId) return fail('targetId required');
		const result = await consumePublishJob(locals.db, locals.env, locals.media, targetId);
		return ok(result);
	} catch (err) {
		return handleError(err);
	}
};

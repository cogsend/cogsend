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
		const jobId = typeof body.jobId === 'string' && body.jobId ? body.jobId : undefined;
		const result = await consumePublishJob(
			locals.db,
			locals.env,
			locals.media,
			targetId,
			undefined,
			locals.budget,
			jobId
		);
		return ok(result);
	} catch (err) {
		return handleError(err);
	}
};

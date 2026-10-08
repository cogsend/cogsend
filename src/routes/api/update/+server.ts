import type { RequestHandler } from './$types';
import { handleError, ok } from '$lib/server/http';
import { requireSession } from '$lib/server/require';
import { jobExpired, readJob, readPrevious, readTarget } from '$lib/server/updater/state';

/**
 * Where an in-app update stands, for Settings to resume from or offer a
 * rollback. Upload-session JWTs and binding details stay on the server.
 */
export const GET: RequestHandler = async ({ locals, platform }) => {
	try {
		requireSession(locals.user, locals.authMethod);
		const [job, previous, target] = await Promise.all([
			readJob(locals.db),
			readPrevious(locals.db),
			readTarget(locals.db)
		]);
		return ok({
			version: __APP_VERSION__,
			install: platform?.env?.COGSEND_INSTALL === 'button' ? 'button' : 'other',
			target,
			previous,
			job: job
				? {
						tag: job.tag,
						phase: job.phase,
						startedAt: job.startedAt,
						expired: jobExpired(job),
						remainingBuckets: job.buckets?.length ?? null,
						uploaded: Boolean(job.completionJwt),
						newVersionId: job.newVersionId ?? null,
						scriptName: job.scriptName
					}
				: null
		});
	} catch (err) {
		return handleError(err);
	}
};

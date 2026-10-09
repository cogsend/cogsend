import type { RequestHandler } from './$types';
import { githubUpdateTarget } from '$lib/domain/github-update';
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
		// A rollback only applies while the update's version still serves; the
		// rollback step checks Cloudflare too, for a Worker without the metadata.
		const running = platform?.env?.CF_VERSION_METADATA?.id ?? null;
		const rollback =
			previous?.installedVersionId && (!running || running === previous.installedVersionId)
				? previous
				: null;
		const env = platform?.env;
		const install = env?.COGSEND_INSTALL === 'button' ? 'button' : 'other';
		return ok({
			version: __APP_VERSION__,
			install,
			github:
				install === 'button' ? githubUpdateTarget(env?.COGSEND_REPO, env?.COGSEND_BRANCH) : null,
			target,
			previous: rollback,
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

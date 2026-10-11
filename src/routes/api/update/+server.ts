import type { RequestHandler } from './$types';
import { githubUpdateTarget } from '#lib/domain/github-update.js';
import { handleError, ok } from '#lib/server/http.js';
import { requireSession } from '#lib/server/require.js';
import { savedTokenStatus } from '#lib/server/updater/saved-token.js';
import { jobExpired, readJob, readPrevious, readTarget } from '#lib/server/updater/state.js';

/**
 * Where an in-app update stands, for Settings to resume from or offer a
 * rollback. Upload-session JWTs and binding details stay on the server.
 */
export const GET: RequestHandler = async ({ locals }) => {
	try {
		requireSession(locals.user, locals.authMethod);
		const [job, previous, target, savedToken] = await Promise.all([
			readJob(locals.db),
			readPrevious(locals.db),
			readTarget(locals.db),
			savedTokenStatus(locals.db)
		]);
		// A rollback only applies while the update's version still serves; the
		// rollback step checks Cloudflare too, for a Worker without the metadata.
		const running = locals.bindings.CF_VERSION_METADATA?.id ?? null;
		const rollback =
			previous?.installedVersionId && (!running || running === previous.installedVersionId)
				? previous
				: null;
		const env = locals.bindings;
		const install = env?.COGSEND_INSTALL === 'button' ? 'button' : 'other';
		return ok({
			version: __APP_VERSION__,
			install,
			github:
				install === 'button' ? githubUpdateTarget(env?.COGSEND_REPO, env?.COGSEND_BRANCH) : null,
			target,
			savedToken,
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

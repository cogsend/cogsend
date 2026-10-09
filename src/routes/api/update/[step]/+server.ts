import type { RequestHandler } from './$types';
import { fail, handleError, ok } from '$lib/server/http';
import { requireSession } from '$lib/server/require';
import { CloudflareApiError } from '$lib/server/updater/cloudflare-api';
import { updaterContext } from '$lib/server/updater/context';
import {
	UpdateError,
	stepAbort,
	stepAssets,
	stepPrepare,
	stepPromote,
	stepRollback,
	stepStage,
	stepTarget,
	stepVersion,
	type UpdaterContext
} from '$lib/server/updater/steps';

/**
 * One step of the in-app update; see $lib/server/updater/steps for the order.
 *
 * Session only, with a verified second factor: an API key or MCP client must
 * never be able to replace the code this instance runs. The Cloudflare token
 * travels in the JSON body, not a header, so request logging cannot record it,
 * and it is used for this request alone.
 */
const STEPS: Record<
	string,
	(ctx: UpdaterContext, body: Record<string, unknown>) => Promise<unknown>
> = {
	target: (ctx, body) =>
		stepTarget(ctx, {
			accountId: typeof body.accountId === 'string' ? body.accountId : undefined,
			scriptName: typeof body.scriptName === 'string' ? body.scriptName : undefined
		}),
	prepare: (ctx, body) => stepPrepare(ctx, { tag: typeof body.tag === 'string' ? body.tag : '' }),
	assets: (ctx) => stepAssets(ctx),
	version: (ctx) => stepVersion(ctx),
	stage: (ctx) => stepStage(ctx),
	promote: (ctx, body) => stepPromote(ctx, { skipStage: body.skipStage === true }),
	rollback: (ctx) => stepRollback(ctx),
	abort: (ctx) => stepAbort(ctx)
};

export const POST: RequestHandler = async (event) => {
	try {
		requireSession(event.locals.user, event.locals.authMethod);
		const run = Object.hasOwn(STEPS, event.params.step) ? STEPS[event.params.step] : null;
		if (!run) return fail('Unknown update step', 404);
		const body = (await event.request.json().catch(() => null)) as Record<string, unknown> | null;
		const token = typeof body?.token === 'string' ? body.token.trim() : '';
		if (!token) return fail('Paste a Cloudflare API token to continue', 400);
		return ok(await run(updaterContext(event, token), body ?? {}));
	} catch (err) {
		if (err instanceof UpdateError) return fail(err.message, err.status);
		if (err instanceof CloudflareApiError) {
			const status = err.status === 401 || err.status === 403 ? 403 : 502;
			const hint =
				status === 403
					? ' Check that the token has the permissions the link pre-fills, for this account.'
					: '';
			return fail(`${err.message}${hint}`, status);
		}
		return handleError(err);
	}
};

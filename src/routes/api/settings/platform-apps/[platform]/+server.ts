import type { RequestHandler } from './$types';
import { isOAuthPlatform, type OAuthPlatformId } from '$lib/domain/platform-setup';
import { platformName } from '$lib/domain/platforms';
import { fail, handleError, ok } from '$lib/server/http';
import {
	configuredByEnv,
	deletePlatformCredentials,
	platformCredentialStatus,
	savePlatformCredentials
} from '$lib/server/platform-credentials';
import { requireSession } from '$lib/server/require';

/**
 * The accounts dialog's form for an OAuth app's credentials.
 *
 * Session only: a leaked API key or MCP client must not be able to point the
 * instance's connect flow at an app somebody else controls. Nothing here ever
 * returns a credential; the answer is the same presence map the accounts page
 * reads.
 */
async function statusFor(locals: App.Locals, id: OAuthPlatformId) {
	const status = await platformCredentialStatus(locals.db, locals.env);
	return {
		platform: id,
		configured: status.configured,
		secrets: status.secrets,
		sources: status.sources,
		savedClientIds: status.savedClientIds
	};
}

function platformFrom(param: string | undefined): OAuthPlatformId | null {
	return param && isOAuthPlatform(param) ? param : null;
}

export const PUT: RequestHandler = async ({ locals, params, request }) => {
	try {
		requireSession(locals.user, locals.authMethod);
		const id = platformFrom(params.platform);
		if (!id) return fail('Unknown platform', 404);
		if (configuredByEnv(locals.env, id)) {
			return fail(`${platformName(id)} is already set up with Worker secrets`, 409);
		}
		const body = await request.json().catch(() => null);
		if (!body || typeof body !== 'object') return fail('Invalid JSON body', 400);
		try {
			await savePlatformCredentials(locals.db, locals.env, id, body as Record<string, unknown>);
		} catch (err) {
			if (err instanceof Error && err.message.startsWith('Missing ')) return fail(err.message, 400);
			throw err;
		}
		return ok(await statusFor(locals, id));
	} catch (err) {
		return handleError(err);
	}
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	try {
		requireSession(locals.user, locals.authMethod);
		const id = platformFrom(params.platform);
		if (!id) return fail('Unknown platform', 404);
		await deletePlatformCredentials(locals.db, id);
		return ok(await statusFor(locals, id));
	} catch (err) {
		return handleError(err);
	}
};

import type { RequestHandler } from './$types';
import { randomHex } from '$lib/domain/bytes';
import { OAUTH_PENDING_TTL_MS } from '$lib/domain/oauth-pending';
import { encryptSecret } from '$lib/server/crypto';
import { oauthPending } from '$lib/server/db/schema';
import { handleError, ok } from '$lib/server/http';
import { resolvePlatformCredentials } from '$lib/server/platform-credentials';
import { platformNotConfigured } from '$lib/server/platform-setup';
import { threadsAuthorizeUrl } from '$lib/server/providers';
import { SESSION_COOKIE } from '$lib/server/auth';
import { bindOAuthState } from '$lib/server/oauth-state';
import { requireSession } from '$lib/server/require';

export const POST: RequestHandler = async ({ locals, cookies }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		const credentials = await resolvePlatformCredentials(locals.db, locals.env, 'threads');
		const appId = credentials?.values.THREADS_APP_ID;
		const appSecret = credentials?.values.THREADS_APP_SECRET;
		if (!appId || !appSecret) return platformNotConfigured('threads');
		const state = randomHex(16);
		const sessionId = cookies.get(SESSION_COOKIE) ?? `machine:${user.id}`;
		const bound = await bindOAuthState({
			secret: locals.env.AUTH_SECRET,
			pendingId: state,
			sessionId
		});
		await locals.db.insert(oauthPending).values({
			id: state,
			userId: user.id,
			instanceUrl: 'threads',
			clientId: appId,
			clientSecretEnc: await encryptSecret(appSecret, locals.env.APP_ENCRYPTION_KEY),
			expiresAt: new Date(Date.now() + OAUTH_PENDING_TTL_MS),
			createdAt: new Date()
		});
		return ok({
			authorizeUrl: threadsAuthorizeUrl(appId, locals.env.APP_URL, bound)
		});
	} catch (err) {
		return handleError(err);
	}
};

import type { RequestHandler } from './$types';
import { isLocalAppUrl } from '#lib/domain/app-url.js';
import { randomHex } from '#lib/domain/bytes.js';
import { OAUTH_PENDING_TTL_MS } from '#lib/domain/oauth-pending.js';
import { encryptSecret } from '#lib/server/crypto.js';
import { oauthPending } from '#lib/server/db/schema.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import {
	mastodonAuthorizeUrl,
	mastodonRegisterApp,
	providerFetch,
	sanitizeMastodonInstanceUrl
} from '#lib/server/providers/index.js';
import { SESSION_COOKIE } from '#lib/server/auth.js';
import { bindOAuthState } from '#lib/server/oauth-state.js';
import { requireSession } from '#lib/server/require.js';

export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		const body = await request.json().catch(() => null);
		if (!body || typeof body !== 'object') return fail('Invalid JSON body', 400);
		const instanceUrl = String(body.instanceUrl || '').trim();
		if (!instanceUrl) return fail('instanceUrl required');
		// Local hosts are reachable only from a local instance; a real APP_URL
		// keeps SSRF blocking on.
		const allowLocal = isLocalAppUrl(locals.env.APP_URL);
		let normalized: string;
		try {
			normalized = sanitizeMastodonInstanceUrl(instanceUrl, allowLocal);
		} catch (e) {
			return fail(e instanceof Error ? e.message : 'Invalid instance URL');
		}
		const app = await mastodonRegisterApp(
			normalized,
			locals.env.APP_URL,
			providerFetch,
			allowLocal
		);
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
			instanceUrl: app.instanceUrl,
			clientId: app.clientId,
			clientSecretEnc: await encryptSecret(app.clientSecret, locals.env.APP_ENCRYPTION_KEY),
			expiresAt: new Date(Date.now() + OAUTH_PENDING_TTL_MS),
			createdAt: new Date()
		});
		const authorizeUrl = mastodonAuthorizeUrl(
			app.instanceUrl,
			app.clientId,
			locals.env.APP_URL,
			bound,
			allowLocal
		);
		return ok({ authorizeUrl });
	} catch (err) {
		return handleError(err);
	}
};

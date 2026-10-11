import type { RequestHandler } from './$types';
import { randomHex } from '#lib/domain/bytes.js';
import { OAUTH_PENDING_TTL_MS } from '#lib/domain/oauth-pending.js';
import { isPlatformId } from '#lib/domain/platforms.js';
import { ZERNIO_PENDING_MARKER, toZernioPlatform } from '#lib/domain/zernio.js';
import { SESSION_COOKIE } from '#lib/server/auth.js';
import { encryptSecret } from '#lib/server/crypto.js';
import { oauthPending } from '#lib/server/db/schema.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import { bindOAuthState } from '#lib/server/oauth-state.js';
import { requireSession } from '#lib/server/require.js';
import { connectUrl } from '#lib/server/zernio.js';
import {
	resolveZernioKey,
	zernioCallbackUrl,
	zernioKeyProblem
} from '#lib/server/zernio-import.js';

export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		const body = (await request.json().catch(() => ({}))) as {
			apiKey?: unknown;
			profileId?: unknown;
			platform?: unknown;
		};
		const platform = typeof body.platform === 'string' ? body.platform : '';
		const zernioPlatform = isPlatformId(platform) ? toZernioPlatform(platform) : null;
		if (!zernioPlatform) return fail('That platform cannot be connected through Zernio');
		// Zernio's hosted Bluesky page appends its result to the redirect with a
		// second `?`, which corrupts the bound state, and names no account id.
		if (platform === 'bluesky') {
			return fail(
				'Bluesky cannot be connected from here yet: connect it in Zernio, then import it'
			);
		}
		const profileId = typeof body.profileId === 'string' ? body.profileId.trim() : '';
		if (!profileId) return fail('Pick the Zernio profile to connect the account to');
		const apiKey = await resolveZernioKey({
			db: locals.db,
			env: locals.env,
			userId: user.id,
			apiKey: body.apiKey
		});

		const pendingId = randomHex(16);
		const sessionId = cookies.get(SESSION_COOKIE) ?? `machine:${user.id}`;
		const bound = await bindOAuthState({
			secret: locals.env.AUTH_SECRET,
			pendingId,
			sessionId
		});
		// The key has to survive the round trip through Zernio and the platform;
		// the pending row's encrypted slot is where the other flows keep theirs.
		await locals.db.insert(oauthPending).values({
			id: pendingId,
			userId: user.id,
			instanceUrl: ZERNIO_PENDING_MARKER,
			clientId: profileId,
			clientSecretEnc: await encryptSecret(apiKey, locals.env.APP_ENCRYPTION_KEY),
			expiresAt: new Date(Date.now() + OAUTH_PENDING_TTL_MS),
			createdAt: new Date()
		});
		const authorizeUrl = await connectUrl({
			apiKey,
			platform: zernioPlatform,
			profileId,
			redirectUrl: zernioCallbackUrl(locals.env.APP_URL, bound)
		});
		return ok({ authorizeUrl });
	} catch (err) {
		return zernioKeyProblem(err) ?? handleError(err);
	}
};

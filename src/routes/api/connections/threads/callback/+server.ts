import { createOAuthCallback } from '#lib/server/oauth-callback.js';
import { decryptSecret } from '#lib/server/crypto.js';
import { threadsExchangeCode } from '#lib/server/providers/index.js';

export const GET = createOAuthCallback({
	platform: 'threads',
	pendingMarker: 'threads',
	accountIdKey: 'threadsUserId',
	async complete({ pending, code, env }) {
		const appSecret = await decryptSecret(pending.clientSecretEnc, env.APP_ENCRYPTION_KEY);
		const exchanged = await threadsExchangeCode({
			appId: pending.clientId,
			appSecret,
			code,
			appUrl: env.APP_URL
		});
		return {
			// NOTE: the global appSecret is deliberately NOT persisted per row.
			// Threads refresh/verify need only the access token; the secret stays
			// in env (and short-lived in oauth_pending) to shrink blast radius.
			credentials: {
				accessToken: exchanged.accessToken,
				expiresAt: exchanged.expiresAt,
				tokenType: exchanged.tokenType,
				scopes: exchanged.scopes,
				clientId: pending.clientId,
				threadsUserId: exchanged.threadsUserId,
				threadsUsername: exchanged.threadsUsername
			},
			displayName: exchanged.displayName,
			handle: exchanged.handle,
			avatarUrl: exchanged.avatarUrl,
			meta: { threadsUserId: exchanged.threadsUserId, maxCharacters: 500 }
		};
	}
});

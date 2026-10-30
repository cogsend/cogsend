import { createOAuthCallback } from '#lib/server/oauth-callback.js';
import { decryptSecret } from '#lib/server/crypto.js';
import { instagramExchangeCode } from '#lib/server/providers/index.js';

export const GET = createOAuthCallback({
	platform: 'instagram',
	pendingMarker: 'instagram',
	accountIdKey: 'igUserId',
	async complete({ pending, code, env }) {
		const appSecret = await decryptSecret(pending.clientSecretEnc, env.APP_ENCRYPTION_KEY);
		const exchanged = await instagramExchangeCode({
			appId: pending.clientId,
			appSecret,
			code,
			appUrl: env.APP_URL
		});
		return {
			// The app secret stays out of the row, as for Threads: refresh and
			// verify need only the access token.
			credentials: {
				accessToken: exchanged.accessToken,
				expiresAt: exchanged.expiresAt,
				tokenType: exchanged.tokenType,
				scopes: exchanged.scopes,
				clientId: pending.clientId,
				igUserId: exchanged.igUserId,
				igUsername: exchanged.igUsername
			},
			displayName: exchanged.displayName,
			handle: exchanged.handle,
			avatarUrl: exchanged.avatarUrl,
			meta: {
				igUserId: exchanged.igUserId,
				igAccountType: exchanged.igAccountType,
				maxCharacters: exchanged.maxCharacters
			}
		};
	}
});

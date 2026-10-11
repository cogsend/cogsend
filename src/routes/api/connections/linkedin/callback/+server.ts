import { createOAuthCallback } from '#lib/server/oauth-callback.js';
import { decryptSecret } from '#lib/server/crypto.js';
import { linkedinExchangeCode } from '#lib/server/providers/index.js';

export const GET = createOAuthCallback({
	platform: 'linkedin',
	pendingMarker: 'linkedin',
	accountIdKey: 'personUrn',
	async complete({ pending, code, env }) {
		const clientSecret = await decryptSecret(pending.clientSecretEnc, env.APP_ENCRYPTION_KEY);
		const exchanged = await linkedinExchangeCode({
			clientId: pending.clientId,
			clientSecret,
			code,
			appUrl: env.APP_URL
		});
		return {
			credentials: {
				accessToken: exchanged.accessToken,
				refreshToken: exchanged.refreshToken,
				expiresAt: exchanged.expiresAt,
				tokenType: exchanged.tokenType,
				scopes: exchanged.scopes,
				clientId: pending.clientId,
				clientSecret,
				personUrn: exchanged.personUrn,
				openIdSub: exchanged.openIdSub
			},
			displayName: exchanged.displayName,
			handle: exchanged.handle,
			avatarUrl: exchanged.avatarUrl,
			meta: { personUrn: exchanged.personUrn, maxCharacters: 3000 }
		};
	}
});

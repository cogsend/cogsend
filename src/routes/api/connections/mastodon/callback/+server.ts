import { isLocalAppUrl } from '#lib/domain/app-url.js';
import { createOAuthCallback } from '#lib/server/oauth-callback.js';
import { decryptSecret } from '#lib/server/crypto.js';
import { mastodonExchangeCode, providerFetch } from '#lib/server/providers/index.js';

export const GET = createOAuthCallback({
	platform: 'mastodon',
	// One connection per account *per instance*, so the instance URL is part of
	// the row identity. The pending row carries the real instance URL, so this
	// flow has no marker to check.
	matchInstanceUrl: true,
	async complete({ pending, code, env }) {
		// Local hosts are reachable only from a local instance; a real APP_URL
		// keeps SSRF blocking on.
		const allowLocal = isLocalAppUrl(env.APP_URL);
		const clientSecret = await decryptSecret(pending.clientSecretEnc, env.APP_ENCRYPTION_KEY);
		const exchanged = await mastodonExchangeCode(
			pending.instanceUrl,
			pending.clientId,
			clientSecret,
			code,
			env.APP_URL,
			providerFetch,
			allowLocal
		);
		return {
			credentials: {
				accessToken: exchanged.accessToken,
				clientId: exchanged.clientId,
				clientSecret: exchanged.clientSecret,
				instanceUrl: exchanged.instanceUrl
			},
			displayName: exchanged.displayName,
			handle: exchanged.handle,
			avatarUrl: exchanged.avatarUrl,
			instanceUrl: exchanged.instanceUrl,
			meta: { maxCharacters: exchanged.maxCharacters ?? 500 }
		};
	}
});

import { platformName } from '#lib/domain/platforms.js';
import { PLATFORM_SETUP, type OAuthPlatformId } from '#lib/domain/platform-setup.js';
import { fail } from '#lib/server/http.js';

/**
 * A connect route whose platform has no credentials on this deployment.
 *
 * Not a server failure, so not a 500: 409 with a code the accounts dialog turns
 * into its setup panel, which is where the secret names belong. The message is
 * what the person connecting reads, so it says nothing about environment
 * variables; `secrets` carries them for whoever runs the deployment.
 */
export function platformNotConfigured(id: OAuthPlatformId) {
	return fail(`${platformName(id)} is not enabled on this instance`, 409, {
		code: 'platform_not_configured',
		platform: id,
		secrets: [...PLATFORM_SETUP[id].secrets]
	});
}

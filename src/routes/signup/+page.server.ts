import { error, redirect } from '@sveltejs/kit';
import { isFullyVerified } from '#lib/server/auth.js';
import { isInviteFormat } from '#lib/server/invites.js';
import { canVerifyEmail, registrationConfig } from '#lib/server/registration.js';
import { signupFormToken } from '#lib/server/signup.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const config = await registrationConfig(locals.db, locals.env);
	// Indistinguishable from a page that does not exist while sign-up is off.
	if (!config.enabled) error(404, 'Not found');
	if (isFullyVerified(locals.user)) redirect(303, '/');
	const invite = url.searchParams.get('invite');
	return {
		mode: config.mode,
		invite: isInviteFormat(invite) ? invite : null,
		verifyEmail: canVerifyEmail(locals.env),
		formToken: await signupFormToken(locals.env)
	};
};

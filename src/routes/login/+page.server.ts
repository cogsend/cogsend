import { redirect } from '@sveltejs/kit';
import { isFullyVerified, needsSetup, needsTotpEnroll } from '$lib/server/auth';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	// No account yet: the page offers the claim form, which only someone holding
	// APP_ENCRYPTION_KEY can complete (see api/auth/claim).
	if (await needsSetup(locals.db)) return { notConfigured: true };
	if (isFullyVerified(locals.user)) redirect(303, '/');
	if (needsTotpEnroll(locals.user)) redirect(303, '/login/setup-2fa');
	return {};
};

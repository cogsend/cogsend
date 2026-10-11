import { redirect } from '@sveltejs/kit';
import { isFullyVerified, needsTotpEnroll } from '#lib/server/auth.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (isFullyVerified(locals.user)) redirect(303, '/');
	if (needsTotpEnroll(locals.user)) redirect(303, '/login/setup-2fa');
	return {};
};

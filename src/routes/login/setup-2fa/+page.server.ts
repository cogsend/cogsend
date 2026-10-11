import { redirect } from '@sveltejs/kit';
import { isFullyVerified } from '#lib/server/auth.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (isFullyVerified(locals.user)) redirect(303, '/');
	return { email: locals.user?.email ?? null };
};

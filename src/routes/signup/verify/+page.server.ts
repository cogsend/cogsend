import { error } from '@sveltejs/kit';
import { registrationConfig } from '#lib/server/registration.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const config = await registrationConfig(locals.db, locals.env);
	if (!config.enabled) error(404, 'Not found');
	return { token: url.searchParams.get('token') ?? '' };
};

import type { RequestHandler } from './$types';
import { fail, handleError, ok } from '#lib/server/http.js';
import {
	parseRegistrationPatch,
	registrationConfig,
	saveRegistrationSettings
} from '#lib/server/registration.js';
import { requireAdminSession } from '#lib/server/require.js';

/**
 * The admin's day-to-day sign-up controls: pause it, switch between waitlist
 * and open, change the cap. `null` hands a value back to the environment.
 * Nothing here can turn sign-up on while REGISTRATION is off.
 */
export const PATCH: RequestHandler = async ({ locals, request }) => {
	try {
		requireAdminSession(locals.user, locals.authMethod);
		const current = await registrationConfig(locals.db, locals.env);
		if (!current.enabled) {
			return fail('Sign-up is off in this instance’s environment (REGISTRATION)', 409);
		}
		const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
		if (!body || typeof body !== 'object') return fail('Invalid JSON body', 400);
		const patch = parseRegistrationPatch(body);
		if (!patch.ok) return fail(patch.error, 400);
		await saveRegistrationSettings(locals.db, patch);
		return ok({ registration: await registrationConfig(locals.db, locals.env) });
	} catch (err) {
		return handleError(err);
	}
};

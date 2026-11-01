import type { LayoutServerLoad } from './$types';
import { readStoredAppName } from '#lib/server/app-settings.js';
import { isAdmin, isFullyVerified } from '#lib/server/auth.js';
import { multiUserActive } from '#lib/server/registration.js';

export const load: LayoutServerLoad = async ({ locals }) => {
	// Name and photo ride along on the session read in hooks, so this load
	// does not query the user again.
	const storedAppName = await readStoredAppName(locals.db);
	// Only an admin is shown the Users page, and only once the instance has
	// more than one account or has opted into sign-up.
	const showUsers =
		isFullyVerified(locals.user) && isAdmin(locals.user)
			? await multiUserActive(locals.db, locals.env)
			: false;
	return {
		user: locals.user,
		displayName: locals.user?.displayName ?? null,
		profilePictureUrl: locals.user?.profilePictureUrl ?? '',
		appName: storedAppName ?? locals.env.APP_NAME,
		showUsers
	};
};

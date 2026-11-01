import type { RequestHandler } from './$types';
import { handleError, ok } from '#lib/server/http.js';
import { listInvites } from '#lib/server/invites.js';
import { canVerifyEmail, registrationConfig } from '#lib/server/registration.js';
import { requireAdminSession } from '#lib/server/require.js';
import { listUsers } from '#lib/server/users.js';

/**
 * Everything the Users page shows in one answer: the accounts, the sign-up
 * configuration with how much of the cap is used, and the invite links.
 * Session-only and admin-only, like every route under /api/admin (the hook
 * refuses members before this runs).
 */
export const GET: RequestHandler = async ({ locals }) => {
	try {
		requireAdminSession(locals.user, locals.authMethod);
		const [users, registration, invites] = await Promise.all([
			listUsers(locals.db),
			registrationConfig(locals.db, locals.env),
			listInvites(locals.db)
		]);
		return ok({
			users,
			invites,
			registration: {
				...registration,
				activeCount: users.filter((u) => u.status === 'active').length,
				pendingCount: users.filter((u) => u.status === 'pending').length,
				verifyEmail: canVerifyEmail(locals.env)
			}
		});
	} catch (err) {
		return handleError(err);
	}
};

import type { RequestHandler } from './$types';
import { checkAccountPassword } from '#lib/server/auth-gate.js';
import { getUserById } from '#lib/server/auth.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import { rateLimitKey } from '#lib/server/rate-limit.js';
import { requireAdminSession } from '#lib/server/require.js';
import { deleteUserAndData } from '#lib/server/user-data.js';
import {
	setUserRole,
	setUserStatus,
	UserAdminError,
	wouldOrphanInstance
} from '#lib/server/users.js';

/**
 * Approve, suspend, reinstate, promote or demote one account. Approving is
 * setting `active`; it is the admin's call, so it is not held to the cap that
 * open sign-up stops at. An admin cannot change their own account here.
 */
export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	try {
		const admin = requireAdminSession(locals.user, locals.authMethod);
		const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
		if (!body || typeof body !== 'object') return fail('Invalid JSON body', 400);
		const status = body.status;
		const role = body.role;
		if (status === undefined && role === undefined) return fail('Nothing to change', 400);
		if (status !== undefined && status !== 'active' && status !== 'suspended') {
			return fail('Status must be active or suspended', 400);
		}
		if (role !== undefined && role !== 'admin' && role !== 'member') {
			return fail('Role must be admin or member', 400);
		}
		if (status !== undefined) await setUserStatus(locals.db, admin.id, params.id, status);
		if (role !== undefined) await setUserRole(locals.db, admin.id, params.id, role);
		return ok({ ok: true });
	} catch (err) {
		if (err instanceof UserAdminError) return fail(err.message, err.status);
		return handleError(err);
	}
};

/**
 * Delete an account and all of its data, R2 media included. The admin's own
 * password is asked for (behind the sign-in lockout), so a session left open
 * cannot be used to wipe other people's work. Like self-service deletion, a
 * large library goes in installments: 202 means call again.
 */
export const DELETE: RequestHandler = async ({ locals, params, request }) => {
	try {
		const admin = requireAdminSession(locals.user, locals.authMethod);
		if (params.id === admin.id) {
			return fail('Delete your own account from Settings instead', 400);
		}
		const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
		const password = typeof body?.password === 'string' ? body.password : '';
		if (!password) return fail('Enter your password to confirm', 400);
		const adminRow = await getUserById(locals.db, admin.id);
		if (!adminRow) return fail('Unauthorized', 401);
		const check = await checkAccountPassword(
			locals.db,
			locals.env,
			adminRow,
			password,
			rateLimitKey(request.headers)
		);
		if (check !== 'ok') {
			return fail(
				check === 'locked' ? 'Too many attempts — try again later' : 'Your password is incorrect',
				401
			);
		}
		const target = await getUserById(locals.db, params.id);
		if (!target) return fail('Not found', 404);
		if (await wouldOrphanInstance(locals.db, target.id)) {
			return fail('Make another account an admin first', 409);
		}
		const { deletedMedia, done } = await deleteUserAndData(locals.db, locals.media, target.id);
		if (!done) {
			return ok(
				{ ok: false, deletedMedia, message: 'Still deleting media — call again to continue' },
				202
			);
		}
		return ok({ ok: true, deletedMedia });
	} catch (err) {
		return handleError(err);
	}
};

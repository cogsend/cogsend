import type { RequestHandler } from './$types';
import { fail, handleError, ok } from '#lib/server/http.js';
import { createInvite, listInvites } from '#lib/server/invites.js';
import { registrationConfig } from '#lib/server/registration.js';
import { requireAdminSession } from '#lib/server/require.js';

export const GET: RequestHandler = async ({ locals }) => {
	try {
		requireAdminSession(locals.user, locals.authMethod);
		return ok({ invites: await listInvites(locals.db) });
	} catch (err) {
		return handleError(err);
	}
};

/**
 * A new invite link. The code is in this answer and nowhere else: D1 keeps a
 * hash. Refused while the environment has sign-up off, because the link would
 * lead to a page that does not exist.
 */
export const POST: RequestHandler = async ({ locals, request, url }) => {
	try {
		const admin = requireAdminSession(locals.user, locals.authMethod);
		const config = await registrationConfig(locals.db, locals.env);
		if (!config.enabled) {
			return fail('Turn on REGISTRATION for this instance before inviting people', 409);
		}
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
		const ttlDays = typeof body.ttlDays === 'number' ? body.ttlDays : undefined;
		const note = typeof body.note === 'string' ? body.note : null;
		const invite = await createInvite(locals.db, locals.env, {
			createdBy: admin.id,
			note,
			ttlDays
		});
		return ok(
			{
				id: invite.id,
				expiresAt: invite.expiresAt.getTime(),
				link: `${url.origin}/signup?invite=${invite.code}`
			},
			201
		);
	} catch (err) {
		return handleError(err);
	}
};

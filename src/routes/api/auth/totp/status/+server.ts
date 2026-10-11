import type { RequestHandler } from './$types';
import { handleError, ok } from '#lib/server/http.js';
import { requireSession } from '#lib/server/require.js';
import { totpStatus } from '#lib/server/totp.js';

export const GET: RequestHandler = async ({ locals }) => {
	try {
		// Session-only, like the rest of credential management: the backup-code
		// count is not something a leaked API key should be able to read.
		const user = requireSession(locals.user, locals.authMethod);
		return ok(await totpStatus(locals.db, user.id));
	} catch (err) {
		return handleError(err);
	}
};

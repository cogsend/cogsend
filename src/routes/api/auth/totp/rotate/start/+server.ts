import type { RequestHandler } from './$types';
import { requireSession } from '#lib/server/require.js';
import { setMfaCookie } from '#lib/server/cookies.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import { rotateStart } from '#lib/server/totp.js';

export const POST: RequestHandler = async ({ request, locals, cookies, url }) => {
	try {
		requireSession(locals.user, locals.authMethod);
		const body = await request.json().catch(() => null);
		if (!body || typeof body !== 'object') return fail('Invalid JSON body', 400);
		const code = String(body.code || '');
		const result = await rotateStart(locals.db, locals.env, locals.user!, code);
		setMfaCookie(cookies, locals.env, url.host, result.mfaToken);
		return ok({
			secret: result.secret,
			otpauthUrl: result.otpauthUrl,
			qrSvg: result.qrSvg,
			backupCodes: result.backupCodes
		});
	} catch (err) {
		return handleError(err);
	}
};

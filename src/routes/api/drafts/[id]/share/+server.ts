import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { hasGoneOut, sharePath, shareLifetimeMs, SHARE_MAX_DAYS } from '#lib/domain/draft-share.js';
import { first, type AppDb } from '#lib/server/db/client.js';
import { drafts, publishTargets } from '#lib/server/db/schema.js';
import {
	createShare,
	currentShare,
	revokeShare,
	type ShareLink
} from '#lib/server/draft-shares.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import { requireScope, requireUser } from '#lib/server/require.js';

async function ownsDraft(db: AppDb, draftId: string, userId: string): Promise<boolean> {
	const row = await first(
		db
			.select({ id: drafts.id })
			.from(drafts)
			.where(and(eq(drafts.id, draftId), eq(drafts.userId, userId)))
	);
	return Boolean(row);
}

function present(appUrl: string, link: ShareLink | null) {
	if (!link) return { share: null };
	return {
		share: {
			url: `${appUrl.replace(/\/$/, '')}${sharePath(link.token)}`,
			expiresAt: link.expiresAt
		}
	};
}

export const GET: RequestHandler = async ({ params, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'read');
		if (!(await ownsDraft(locals.db, params.id, user.id))) return fail('Not found', 404);
		const link = await currentShare(locals.db, locals.env.APP_ENCRYPTION_KEY, params.id);
		return ok(present(locals.env.APP_URL, link));
	} catch (err) {
		return handleError(err);
	}
};

export const POST: RequestHandler = async ({ params, locals, request }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		const body = (await request.json().catch(() => null)) as { expiresInDays?: unknown } | null;
		const lifetime = shareLifetimeMs(body?.expiresInDays ?? undefined);
		if (lifetime === null) {
			return fail(`expiresInDays must be a whole number from 1 to ${SHARE_MAX_DAYS}`);
		}
		if (!(await ownsDraft(locals.db, params.id, user.id))) return fail('Not found', 404);
		const targets = await locals.db
			.select({ status: publishTargets.status, remotePostId: publishTargets.remotePostId })
			.from(publishTargets)
			.where(eq(publishTargets.draftId, params.id));
		// The link would stop working the moment it was made.
		if (hasGoneOut(targets)) return fail('Already published — nothing left to preview', 409);
		const link = await createShare(locals.db, locals.env.APP_ENCRYPTION_KEY, params.id, lifetime);
		return ok(present(locals.env.APP_URL, link), 201);
	} catch (err) {
		return handleError(err);
	}
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		if (!(await ownsDraft(locals.db, params.id, user.id))) return fail('Not found', 404);
		await revokeShare(locals.db, params.id);
		return ok({ share: null });
	} catch (err) {
		return handleError(err);
	}
};

import { isRedirect, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { ZERNIO_PENDING_MARKER, fromZernioPlatform } from '#lib/domain/zernio.js';
import { SESSION_COOKIE } from '#lib/server/auth.js';
import { decryptSecret } from '#lib/server/crypto.js';
import { first } from '#lib/server/db/client.js';
import { toAppOrigin } from '#lib/server/oauth-callback.js';
import { oauthPending } from '#lib/server/db/schema.js';
import { splitOAuthState, verifyOAuthState } from '#lib/server/oauth-state.js';
import { listAccounts, zernioApiMessage } from '#lib/server/zernio.js';
import { upsertZernioConnection } from '#lib/server/zernio-import.js';

/**
 * Zernio lands here after its hosted flow with `connected`, `profileId`,
 * `accountId` and `username`, or `error`, `platform` and `error_message`.
 * The state check mirrors createOAuthCallback: the pending row must exist,
 * be ours, be unexpired and be bound to the session that started the flow.
 */
export const GET: RequestHandler = async ({ url, locals, cookies }) => {
	const appUrl = locals.env.APP_URL.replace(/\/$/, '');
	const state = url.searchParams.get('pending');
	const candidate = splitOAuthState(state);
	const pending = candidate
		? await first(locals.db.select().from(oauthPending).where(eq(oauthPending.id, candidate)))
		: null;
	const sessionId = cookies.get(SESSION_COOKIE) ?? (pending ? `machine:${pending.userId}` : null);
	const pendingId = await verifyOAuthState({ secret: locals.env.AUTH_SECRET, state, sessionId });
	if (
		!pending ||
		!pendingId ||
		pending.id !== pendingId ||
		pending.expiresAt < new Date() ||
		pending.instanceUrl !== ZERNIO_PENDING_MARKER
	) {
		if (pending) await locals.db.delete(oauthPending).where(eq(oauthPending.id, pending.id));
		redirect(302, `${appUrl}/accounts?error=oauth_expired`, toAppOrigin(appUrl));
	}
	await locals.db.delete(oauthPending).where(eq(oauthPending.id, pending.id));

	const failure = url.searchParams.get('error');
	if (failure) {
		const message = url.searchParams.get('error_message') || failure;
		redirect(302, `${appUrl}/accounts?error=${encodeURIComponent(message)}`, toAppOrigin(appUrl));
	}
	try {
		const apiKey = await decryptSecret(pending.clientSecretEnc, locals.env.APP_ENCRYPTION_KEY);
		const accountId = url.searchParams.get('accountId') ?? '';
		const account = (await listAccounts({ apiKey, profileId: pending.clientId })).find(
			(a) => a._id === accountId
		);
		if (!account) throw new Error('Zernio did not report the connected account');
		const platform = fromZernioPlatform(account.platform);
		if (!platform) throw new Error(`CogSend cannot post to ${account.platform}`);
		await upsertZernioConnection({
			db: locals.db,
			env: locals.env,
			userId: pending.userId,
			apiKey,
			account
		});
		redirect(302, `${appUrl}/accounts?connected=${platform}`, toAppOrigin(appUrl));
	} catch (e) {
		if (isRedirect(e)) throw e;
		redirect(
			302,
			`${appUrl}/accounts?error=${encodeURIComponent(zernioApiMessage(e))}`,
			toAppOrigin(appUrl)
		);
	}
};

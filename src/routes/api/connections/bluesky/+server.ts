import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { encryptJson } from '#lib/server/crypto.js';
import { newId, parseJson } from '#lib/server/db/client.js';
import { findExistingConnection } from '#lib/server/oauth-callback.js';
import { connections } from '#lib/server/db/schema.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import { blueskyCreateSession } from '#lib/server/providers/index.js';
import { requireSession } from '#lib/server/require.js';

/**
 * Bluesky answers a wrong handle or app password with a 401. Passed through,
 * that reads as our own session having expired, and the reconnect wording it
 * gets on the page is wrong for an account that was never connected.
 */
function loginRefusal(err: unknown): string | null {
	const status = (err as { status?: number } | null)?.status;
	if (status !== 400 && status !== 401) return null;
	const message = err instanceof Error ? err.message : '';
	if (message.includes('AuthFactorTokenRequired')) {
		return 'Bluesky asked for an email code — use an app password, not your account password';
	}
	return "Bluesky didn't accept that handle and app password. Check both, or create a new app password in Bluesky's settings.";
}

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		const body = await request.json().catch(() => null);
		if (!body || typeof body !== 'object') return fail('Invalid JSON body', 400);
		const handle = String(body.handle || '').trim();
		const appPassword = String(body.appPassword || '').trim();
		const pdsHost = String(body.pdsHost || 'https://bsky.social').trim();
		if (!handle || !appPassword) return fail('handle and appPassword required');

		let session: Awaited<ReturnType<typeof blueskyCreateSession>>;
		try {
			session = await blueskyCreateSession(handle, appPassword, pdsHost);
		} catch (err) {
			const refused = loginRefusal(err);
			if (refused) return fail(refused, 400);
			throw err;
		}
		const encrypted = await encryptJson(
			{
				handle: session.handle,
				appPassword,
				accessJwt: session.accessJwt,
				refreshJwt: session.refreshJwt,
				did: session.did,
				pdsHost: session.pdsHost
			},
			locals.env.APP_ENCRYPTION_KEY
		);
		// Matched on the DID first: a Bluesky handle is a domain and can change,
		// and a changed handle must revive the account's row, not add a second.
		const existing = findExistingConnection(
			await locals.db
				.select()
				.from(connections)
				.where(and(eq(connections.userId, user.id), eq(connections.platform, 'bluesky'))),
			session.handle ?? '',
			session.did,
			'did'
		);
		const now = new Date();
		// A reconnect keeps the operator's link style.
		const compactLinks = parseJson<{ compactLinks?: unknown }>(existing?.metaJson, {}).compactLinks;
		const data = {
			displayName: session.displayName || session.handle || null,
			handle: session.handle || null,
			avatarUrl: session.avatarUrl || null,
			credentialsEncrypted: encrypted,
			metaJson: JSON.stringify({
				did: session.did,
				pdsHost: session.pdsHost,
				...(compactLinks === true ? { compactLinks } : {})
			}),
			status: 'active',
			updatedAt: now
		};
		const connection = existing
			? (
					await locals.db
						.update(connections)
						.set(data)
						.where(eq(connections.id, existing.id))
						.returning()
				)[0]
			: (
					await locals.db
						.insert(connections)
						.values({
							id: newId(),
							userId: user.id,
							platform: 'bluesky',
							...data,
							createdAt: now
						})
						.returning()
				)[0];

		return ok({
			connection: {
				id: connection.id,
				platform: connection.platform,
				handle: connection.handle,
				displayName: connection.displayName,
				status: connection.status
			}
		});
	} catch (err) {
		return handleError(err);
	}
};

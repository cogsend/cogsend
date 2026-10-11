import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { encryptJson } from '#lib/server/crypto.js';
import { newId } from '#lib/server/db/client.js';
import { findExistingConnection } from '#lib/server/oauth-callback.js';
import { connections } from '#lib/server/db/schema.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import { blueskyCreateSession } from '#lib/server/providers/index.js';
import { requireSession } from '#lib/server/require.js';

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		const body = await request.json().catch(() => null);
		if (!body || typeof body !== 'object') return fail('Invalid JSON body', 400);
		const handle = String(body.handle || '').trim();
		const appPassword = String(body.appPassword || '').trim();
		const pdsHost = String(body.pdsHost || 'https://bsky.social').trim();
		if (!handle || !appPassword) return fail('handle and appPassword required');

		const session = await blueskyCreateSession(handle, appPassword, pdsHost);
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
		const data = {
			displayName: session.displayName || session.handle || null,
			handle: session.handle || null,
			avatarUrl: session.avatarUrl || null,
			credentialsEncrypted: encrypted,
			metaJson: JSON.stringify({ did: session.did, pdsHost: session.pdsHost }),
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

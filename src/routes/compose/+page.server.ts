import { and, desc, eq, ne } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { parseProfileSettings } from '#lib/domain/profile-settings.js';
import { batchQueries } from '#lib/server/db/client.js';
import { connections, users } from '#lib/server/db/schema.js';
import { loadOwnedDraft } from '#lib/server/draft-record.js';
import { requireUser } from '#lib/server/require.js';
import { serializeConnection } from '#lib/server/serialize.js';

type ConnectionRow = {
	id: string;
	platform: string;
	displayName: string | null;
	handle: string | null;
	avatarUrl: string | null;
	instanceUrl: string | null;
	status: string;
	metaJson: string;
	createdAt: Date;
};

type SettingsRow = { settingsJson: string | null; displayName: string | null };

// Server-render the account list (and an open draft) with the document so the
// editor paints them on first paint instead of waiting for a client round trip.
export const load: PageServerLoad = async ({ locals, url }) => {
	const user = requireUser(locals.user);
	const draftId = url.searchParams.get('id');
	// Settle the two reads separately: a failed draft must not cost the account
	// list, and a failed account list must not cost the draft. The editor's
	// client fallback covers whatever is missing, with its own error and retry.
	const [listed, draft] = await Promise.all([
		(
			batchQueries(locals.db, [
				locals.db
					.select({
						id: connections.id,
						platform: connections.platform,
						displayName: connections.displayName,
						handle: connections.handle,
						avatarUrl: connections.avatarUrl,
						instanceUrl: connections.instanceUrl,
						status: connections.status,
						metaJson: connections.metaJson,
						createdAt: connections.createdAt
					})
					.from(connections)
					// Archive tombstones are not selectable destinations.
					.where(and(eq(connections.userId, user.id), ne(connections.status, 'disconnected')))
					.orderBy(desc(connections.createdAt)),
				locals.db
					.select({ settingsJson: users.settingsJson, displayName: users.displayName })
					.from(users)
					.where(eq(users.id, user.id))
			]) as Promise<[ConnectionRow[], SettingsRow[]]>
		).catch((err): [ConnectionRow[], SettingsRow[]] => {
			console.error('[compose] account list failed', err);
			return [[], []];
		}),
		draftId
			? loadOwnedDraft(locals.db, draftId, user.id).catch((err) => {
					console.error('[compose] draft failed', err);
					return null;
				})
			: Promise.resolve(null)
	]);
	const [rows, userRows] = listed;
	return {
		connections: rows.map(serializeConnection),
		settings: parseProfileSettings(userRows[0]?.settingsJson ?? null),
		displayName: userRows[0]?.displayName ?? user.displayName ?? null,
		draft,
		canMakeJpegCopies: Boolean((locals.bindings as { IMAGES?: unknown } | undefined)?.IMAGES)
	};
};

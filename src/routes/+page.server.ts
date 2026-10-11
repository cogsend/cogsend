import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { batchQueries } from '#lib/server/db/client.js';
import { connections, drafts, publishTargets } from '#lib/server/db/schema.js';
import { requireUser } from '#lib/server/require.js';
import { schedulerHealth } from '#lib/server/scheduler.js';

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals.user);
	const ownedConnections = () =>
		locals.db
			.select({ id: connections.id })
			.from(connections)
			.where(eq(connections.userId, user.id));
	const [counts, health] = await Promise.all([
		batchQueries(locals.db, [
			locals.db
				.select({ n: sql<number>`count(*)` })
				.from(drafts)
				.where(and(eq(drafts.userId, user.id), eq(drafts.status, 'draft'))),
			locals.db
				.select({ n: sql<number>`count(*)` })
				.from(publishTargets)
				.where(
					and(
						inArray(publishTargets.connectionId, ownedConnections()),
						inArray(publishTargets.status, ['scheduled', 'pending', 'publishing'])
					)
				),
			locals.db
				// Distinct drafts: the Failed tab renders one card per post, while a
				// post can have several failed destinations.
				.select({ n: sql<number>`count(distinct ${publishTargets.draftId})` })
				.from(publishTargets)
				.where(
					and(
						inArray(publishTargets.connectionId, ownedConnections()),
						inArray(publishTargets.status, ['failed'])
					)
				)
		]),
		schedulerHealth(locals.db)
	]);
	const [draftRows, scheduledRows, failedRows] = counts as [
		{ n: number }[],
		{ n: number }[],
		{ n: number }[]
	];
	return {
		user: locals.user,
		displayName: user.displayName ?? null,
		scheduledCount: scheduledRows[0]?.n ?? 0,
		draftCount: draftRows[0]?.n ?? 0,
		failedCount: failedRows[0]?.n ?? 0,
		schedulerOk: health.ok,
		schedulerNeverTicked: health.lastTickAt === null,
		schedulerError: health.error ?? null,
		stuckPublishing: health.stuckPublishing,
		overdue: health.overdue
	};
};

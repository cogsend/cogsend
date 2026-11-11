import type { PageServerLoad } from './$types';
import { loadDraftSummaries, loadQueueList } from '#lib/server/post-list.js';
import { requireUser } from '#lib/server/require.js';

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals.user);
	try {
		const [drafts, queue] = await Promise.all([
			loadDraftSummaries(locals.db, user.id),
			loadQueueList(locals.db, user.id)
		]);
		return {
			drafts: drafts.drafts,
			draftsHasMore: drafts.hasMore,
			draftsNext: drafts.next,
			targets: queue.targets,
			queueHasMore: queue.hasMore,
			queueNext: queue.next,
			waitingTotals: queue.waitingTotals ?? {},
			loadFailed: false
		};
	} catch (err) {
		console.error('[posts] list failed', err);
		return {
			drafts: [],
			draftsHasMore: false,
			draftsNext: null,
			targets: [],
			queueHasMore: false,
			queueNext: null,
			waitingTotals: {} as Record<string, number>,
			loadFailed: true
		};
	}
};

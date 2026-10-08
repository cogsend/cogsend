import type { PageServerLoad } from './$types';
import { listConnections } from '$lib/server/connection-list';
import { requireUser } from '$lib/server/require';

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals.user);
	try {
		return {
			...(await listConnections(locals.db, locals.env, user.id)),
			loadFailed: false
		};
	} catch (err) {
		// A transient D1 error must not turn the page into a 500: the client
		// keeps its retry path, which this flag arms.
		console.error('[accounts] list failed', err);
		return {
			connections: [],
			configured: { linkedin: false, threads: false, x: false },
			secrets: {},
			sources: { linkedin: null, threads: null, x: null },
			savedClientIds: { linkedin: null, threads: null, x: null },
			appUrl: locals.env.APP_URL,
			loadFailed: true
		};
	}
};

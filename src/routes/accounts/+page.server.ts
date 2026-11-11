import type { PageServerLoad } from './$types';
import { listConnections } from '#lib/server/connection-list.js';
import { requireUser } from '#lib/server/require.js';

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals.user);
	// A Deploy-button install has no checkout to run `secrets:put` from.
	const install = locals.bindings?.COGSEND_INSTALL === 'button' ? 'button' : 'other';
	try {
		return {
			...(await listConnections(locals.db, locals.env, user.id)),
			install,
			loadFailed: false
		};
	} catch (err) {
		// A transient D1 error must not turn the page into a 500: the client
		// keeps its retry path, which this flag arms.
		console.error('[accounts] list failed', err);
		return {
			connections: [],
			configured: { linkedin: false, threads: false, instagram: false, x: false },
			secrets: {},
			sources: { linkedin: null, threads: null, instagram: null, x: null },
			savedClientIds: { linkedin: null, threads: null, instagram: null, x: null },
			appUrl: locals.env.APP_URL,
			install,
			loadFailed: true
		};
	}
};

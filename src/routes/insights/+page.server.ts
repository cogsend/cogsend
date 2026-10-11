import type { PageServerLoad } from './$types';
import { loadInsights } from '#lib/server/insights-report.js';
import { requireUser } from '#lib/server/require.js';

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = requireUser(locals.user);
	try {
		return {
			insights: await loadInsights(locals.db, user.id, url.searchParams.get('days'), user.timezone)
		};
	} catch (err) {
		console.error('[insights] load failed', err);
		return { insights: null };
	}
};

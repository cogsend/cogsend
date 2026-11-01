import type { PageServerLoad } from './$types';
import { requireAdmin } from '#lib/server/require.js';

// The hook already sends members away from /admin; this keeps the page safe
// if it is ever reached another way.
export const load: PageServerLoad = async ({ locals }) => {
	const admin = requireAdmin(locals.user);
	return { selfId: admin.id };
};

import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { shareVersions } from '#lib/domain/draft-share.js';
import { resolveShare } from '#lib/server/draft-shares.js';
import { serializeMedia } from '#lib/server/serialize.js';

// Public: possession of the link is the authorization (see isPublicPath). Only
// the post's content leaves the server, never the accounts it is going to.
export const load: PageServerLoad = async ({ params, locals, setHeaders }) => {
	// Each visit reads the latest save, and a revoked link must stop showing
	// anything at once, so nothing may keep a copy.
	setHeaders({ 'cache-control': 'private, no-store' });
	const shared = await resolveShare(locals.db, params.token);
	if (!shared) error(404, 'This preview link has expired or was turned off.');
	const media = shared.media.map((m) => {
		const { id, storageKey, mime, width, height, altText, segmentIndex, meta } = serializeMedia(m);
		return { id, storageKey, mime, width, height, altText, segmentIndex, meta };
	});
	return {
		title: shared.draft.title,
		updatedAt: shared.draft.updatedAt,
		expiresAt: shared.expiresAt,
		mediaBase: `/p/${params.token}/media`,
		versions: shareVersions({
			baseBody: shared.draft.baseBody,
			variants: shared.variants,
			media,
			platforms: shared.platforms
		})
	};
};

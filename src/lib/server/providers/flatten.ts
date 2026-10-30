import { joinThreadTexts } from '#lib/domain/thread-segments.js';
import type { MediaAttachment, NormalizedPost } from './types';

/**
 * For a platform without threads, a multi-post draft is flattened into one
 * post — non-empty segment texts joined by a blank line, media combined in
 * segment order. Selecting such a platform on a thread draft therefore never
 * fails just because the draft threads elsewhere.
 */
export function singlePost(content: NormalizedPost): { text: string; media: MediaAttachment[] } {
	const segments = content.thread && content.thread.length > 0 ? content.thread : [content];
	return {
		text: joinThreadTexts(segments.map((s) => s.text)),
		media: segments.flatMap((s) => s.media ?? [])
	};
}

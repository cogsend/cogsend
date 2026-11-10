import { cardExcerptCut } from './excerpt';
import { safeHttpUrl } from './links';
import { findRichText } from './rich-text';

/** A run of a post's text, and where it links to if it is a link. */
export type TextPart = { text: string; href?: string };

/**
 * A post's text split into plain runs and links, found as the Bluesky post
 * would find them. Hashtags and mentions stay plain: where they lead depends on
 * the platform, and one post can go to several. With `cut`, the text was cut
 * short, and a link running into the cut is left plain rather than linking to
 * half an address.
 */
export function linkParts(text: string, { cut = false }: { cut?: boolean } = {}): TextPart[] {
	const parts: TextPart[] = [];
	let last = 0;
	for (const entity of findRichText(text)) {
		if (entity.type !== 'link' || (cut && entity.end === text.length)) continue;
		const href = safeHttpUrl(entity.uri);
		if (!href) continue;
		if (entity.start > last) parts.push({ text: text.slice(last, entity.start) });
		parts.push({ text: text.slice(entity.start, entity.end), href });
		last = entity.end;
	}
	if (last < text.length) parts.push({ text: text.slice(last) });
	return parts;
}

/** A post's text for a list card (`cardExcerpt`), with its links. */
export function cardParts(text: string | null | undefined): TextPart[] {
	const { text: shown, cut } = cardExcerptCut(text);
	const parts = linkParts(shown, { cut });
	return cut ? [...parts, { text: '…' }] : parts;
}

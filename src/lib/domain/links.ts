/**
 * Shared URL helpers for link-preview cards.
 *
 * The convention every client follows: each post/segment gets at most one card,
 * taken from the FIRST http(s) URL in its text. When the segment
 * has image/video attachments the card is suppressed — every target network
 * renders attachments instead of a link card in that case:
 * - Bluesky: one `embed` per post (images XOR external), official client
 *   drops the card when images are attached.
 * - Mastodon: server generates PreviewCard from OG tags; web UI hides the
 *   card when `media_attachments` is non-empty.
 * - Threads: no LINK attachment type; URL in `text` unfurls inline, image
 *   occupies the attachment slot.
 * - LinkedIn: `content` is a one-of (article XOR images/video); image posts
 *   must not attach an article.
 */

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

// Trailing punctuation is almost never part of the URL (typed `see this.`).
const TRAILING_PUNCT_RE = /[.,);:!?'\]"'`]+$/;

export function cleanUrl(raw: string): string {
	return raw.replace(TRAILING_PUNCT_RE, '');
}

/** All http(s) URLs in text, cleaned, in order. */
export function extractUrls(text: string): string[] {
	if (!text) return [];
	const out: string[] = [];
	URL_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = URL_RE.exec(text)) !== null) {
		const cleaned = cleanUrl(m[0]);
		if (cleaned) out.push(cleaned);
	}
	return out;
}

/** First URL in text, or null. This is the link-card candidate. */
export function extractFirstUrl(text: string): string | null {
	return extractUrls(text)[0] ?? null;
}

/** Whether this segment should show/attach a link card. */
export function shouldAttachLinkCard(text: string, hasMedia: boolean): boolean {
	if (hasMedia) return false;
	return extractFirstUrl(text) !== null;
}

/** Host for preview display (`example.com`), lowercased, no port. */
export function previewDomain(url: string): string | null {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return null;
	}
}

/**
 * A link that is safe to store and render as an `href`: http(s) only. A post's
 * permalink comes from the platform's own answer (a Mastodon instance, Zernio),
 * and a `javascript:` value there would run in this origin when clicked.
 */
export function safeHttpUrl(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	try {
		const { protocol } = new URL(trimmed);
		return protocol === 'https:' || protocol === 'http:' ? trimmed : null;
	} catch {
		return null;
	}
}

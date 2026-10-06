/**
 * Quote posts on X without the quote API.
 *
 * `quote_tweet_id` is Enterprise-only on X's pay-per-use plan, but a post whose
 * text ends with a link to another X post is still shown by X as a quote of
 * it. The composer draws that trailing link as a quote card and hides it from
 * the text box, while the stored text keeps it at the end, so publishing,
 * drafts and the API see exactly what they saw before.
 */

// Query strings are kept (`?s=20` from the share sheet) but stop at
// punctuation: a link followed by `.` is not "the last thing in the text".
const X_POST_URL = String.raw`https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(i\/web|[A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,19})(?:\?[\w\-=&%~]*)?`;

const FULL_RE = new RegExp(`^${X_POST_URL}$`);
const TRAILING_RE = new RegExp(`${X_POST_URL}\\s*$`);
const ANY_RE = new RegExp(`${X_POST_URL}(?![\\w/])`, 'g');

export type XPostRef = { id: string; handle: string | null };

export type XQuote = XPostRef & {
	/** The text without the link: what the text box shows. */
	visible: string;
	url: string;
	/** The one whitespace character that separated the text from the link. */
	sep: string;
};

function handleOf(segment: string): string | null {
	return /^i(\/web)?$/i.test(segment) ? null : segment;
}

/** The post a link points at, when the whole string is an X post link. */
export function parseXPostUrl(url: string): XPostRef | null {
	const m = FULL_RE.exec((url ?? '').trim());
	return m ? { id: m[2], handle: handleOf(m[1]) } : null;
}

/** The X post link that ends `text`, which X turns into a quote. */
export function trailingXQuote(text: string): XQuote | null {
	if (!text) return null;
	const m = TRAILING_RE.exec(text);
	if (!m) return null;
	// `foohttps://x.com/…` is not a link X recognises on its own.
	if (m.index > 0 && !/\s/.test(text[m.index - 1])) return null;
	let visible = text.slice(0, m.index);
	let sep = '';
	if (visible && /\s$/.test(visible)) {
		sep = visible.slice(-1);
		visible = visible.slice(0, -1);
	}
	return { visible, url: m[0].trimEnd(), id: m[2], handle: handleOf(m[1]), sep };
}

/**
 * The inverse of `trailingXQuote`: put the link back after the text box's
 * contents, with the separator it had, so editing never reshapes the text.
 */
export function attachXQuote(visible: string, url: string, sep = ''): string {
	if (visible === '' && sep === '') return url;
	return `${visible}${sep || '\n'}${url}`;
}

/** X post links in `text` that X will show as plain links: every one but the trailing one. */
export function strayXPostLinks(text: string): Array<{ url: string; index: number }> {
	if (!text) return [];
	const trailingEnd = trailingXQuote(text) ? text.trimEnd().length : -1;
	const out: Array<{ url: string; index: number }> = [];
	ANY_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = ANY_RE.exec(text)) !== null) {
		if (m.index > 0 && !/\s/.test(text[m.index - 1])) continue;
		if (m.index + m[0].length !== trailingEnd) out.push({ url: m[0], index: m.index });
	}
	return out;
}

/** Move the X post link found at `index` to the end of `text`, where X quotes it. */
export function moveXPostLinkToEnd(text: string, index: number): string {
	ANY_RE.lastIndex = index;
	const m = ANY_RE.exec(text);
	if (!m || m.index !== index) return text;
	let start = m.index;
	let end = m.index + m[0].length;
	if (text[start - 1] === ' ') start -= 1;
	else if (text[end] === ' ') end += 1;
	const rest = (text.slice(0, start) + text.slice(end)).trimEnd();
	return attachXQuote(rest, m[0], rest ? '\n' : '');
}

export type QuotableTarget = {
	status?: string;
	remoteUrl?: string | null;
	updatedAt?: string | Date | null;
	connection?: { platform?: string } | null;
	draft?: { baseBody?: string | null } | null;
};

/** Published X posts from the queue list that can be quoted, newest first, one per link. */
export function quotableXPosts(
	targets: QuotableTarget[],
	limit = 8
): Array<{ url: string; body: string; at: number }> {
	const seen = new Set<string>();
	const out: Array<{ url: string; body: string; at: number }> = [];
	for (const t of targets) {
		if (t.status !== 'published' || t.connection?.platform !== 'x') continue;
		const url = typeof t.remoteUrl === 'string' ? t.remoteUrl.trim() : '';
		if (!parseXPostUrl(url) || seen.has(url)) continue;
		seen.add(url);
		const at = t.updatedAt ? new Date(t.updatedAt).getTime() : 0;
		out.push({ url, body: t.draft?.baseBody ?? '', at: Number.isNaN(at) ? 0 : at });
	}
	return out.sort((a, b) => b.at - a.at).slice(0, limit);
}

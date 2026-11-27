/**
 * OpenGraph fetching for link-preview cards.
 *
 * Publish mapping (verified against lexicons/docs):
 * - Bluesky: client fetches OG itself → `app.bsky.embed.external`
 *   { uri, title, description, thumb(blob ≤1MB) }. One embed per post, so
 *   images XOR card; facets still required for the URL text.
 * - LinkedIn: Posts API does NOT scrape URLs. Caller must send
 *   `content.article { source, title, description, thumbnail? }`, thumbnail
 *   being an uploaded `urn:li:image:*`. Images/video XOR article.
 * - Mastodon: server scrapes OG into PreviewCard; client sends nothing.
 * - Threads: no LINK attachment; URL in `text` unfurls server-side.
 *
 * Security: every outbound fetch validates the host with
 * `isBlockedInstanceHost` (SSRF: localhost/metadata/wildcard-DNS blocked),
 * caps HTML at 2MB / image at 5MB, 10s timeout, max 3 redirects, and only
 * follows http(s).
 */

import { isBlockedInstanceHost } from '#lib/domain/instance-host.js';
import type { FetchLike } from './providers/types';

export interface OpenGraphData {
	url: string;
	title: string;
	description: string;
	image: string | null;
	siteName: string | null;
}

export const OG_HTML_MAX_BYTES = 2_000_000;
export const OG_IMAGE_MAX_BYTES = 5_000_000;
const OG_FETCH_TIMEOUT_MS = 10_000;
const OG_MAX_REDIRECTS = 3;

function assertPublicHttpUrl(raw: string): URL {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		throw Object.assign(new Error('Invalid URL'), { status: 400 });
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') {
		throw Object.assign(new Error('Only http(s) URLs are supported'), { status: 400 });
	}
	if (isBlockedInstanceHost(u.hostname)) {
		throw Object.assign(new Error('URL host not allowed'), { status: 400 });
	}
	return u;
}

export function decodeHtmlEntities(s: string): string {
	return s
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&#(\d+);/g, (_, n) => {
			try {
				return String.fromCodePoint(Math.min(0x10ffff, parseInt(n, 10)));
			} catch {
				return '';
			}
		})
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => {
			try {
				return String.fromCodePoint(Math.min(0x10ffff, parseInt(h, 16)));
			} catch {
				return '';
			}
		})
		.replace(/&amp;/gi, '&');
}

const MAX_META_TAGS = 250;
const MAX_TAG_LENGTH = 8_192;
const MAX_ATTRS_PER_TAG = 32;

function isAsciiSpace(code: number): boolean {
	return code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
}

function isAttrNameChar(code: number): boolean {
	return (
		(code >= 65 && code <= 90) ||
		(code >= 97 && code <= 122) ||
		(code >= 48 && code <= 57) ||
		code === 45 ||
		code === 95 ||
		code === 58
	);
}

/**
 * Single-pass linear scan for `<meta>` tags. Replaces per-key `dotAll` regexes
 * that backtrack quadratically on hostile/malformed HTML under the 10 ms
 * Workers Free CPU cap.
 */
function scanMetaTags(html: string): {
	property: Map<string, string>;
	name: Map<string, string>;
} {
	const property = new Map<string, string>();
	const name = new Map<string, string>();
	const lower = html.toLowerCase();
	const len = html.length;
	let pos = 0;
	let tags = 0;

	while (pos < len && tags < MAX_META_TAGS) {
		const lt = lower.indexOf('<', pos);
		if (lt === -1) break;
		if (lower.startsWith('<!--', lt)) {
			const end = lower.indexOf('-->', lt + 4);
			if (end === -1) break;
			pos = end + 3;
			continue;
		}
		if (
			lower.startsWith('<script', lt) &&
			(isAsciiSpace(lower.charCodeAt(lt + 7)) || lower.charCodeAt(lt + 7) === 62)
		) {
			const end = lower.indexOf('</script', lt + 7);
			if (end === -1) break;
			pos = end + 8;
			continue;
		}
		if (
			lower.startsWith('<style', lt) &&
			(isAsciiSpace(lower.charCodeAt(lt + 6)) || lower.charCodeAt(lt + 6) === 62)
		) {
			const end = lower.indexOf('</style', lt + 6);
			if (end === -1) break;
			pos = end + 7;
			continue;
		}
		if (!lower.startsWith('<meta', lt)) {
			pos = lt + 1;
			continue;
		}
		const after = lt + 5;
		if (after >= len) break;
		const nextCode = lower.charCodeAt(after);
		if (!isAsciiSpace(nextCode) && nextCode !== 47 && nextCode !== 62) {
			pos = after;
			continue;
		}
		tags++;

		const tagLimit = Math.min(len, after + MAX_TAG_LENGTH);
		let i = after;
		let attrs = 0;
		let propKey = '';
		let nameKey = '';
		let contentVal = '';
		let hasContent = false;
		let unclosed = false;

		while (i < tagLimit && attrs < MAX_ATTRS_PER_TAG) {
			while (i < tagLimit && (isAsciiSpace(html.charCodeAt(i)) || html.charCodeAt(i) === 47)) i++;
			if (i >= tagLimit || html.charCodeAt(i) === 62) {
				if (i < tagLimit && html.charCodeAt(i) === 62) i++;
				break;
			}
			const nameStart = i;
			while (i < tagLimit && isAttrNameChar(html.charCodeAt(i))) i++;
			if (i === nameStart) {
				i++;
				continue;
			}
			const attrName = lower.slice(nameStart, i);
			attrs++;

			while (i < tagLimit && isAsciiSpace(html.charCodeAt(i))) i++;
			if (i >= tagLimit || html.charCodeAt(i) !== 61) continue;
			i++; // skip '='
			while (i < tagLimit && isAsciiSpace(html.charCodeAt(i))) i++;
			if (i >= tagLimit) break;

			const quote = html.charCodeAt(i);
			let val: string;
			if (quote === 34 || quote === 39) {
				i++;
				const valStart = i;
				const close = html.indexOf(quote === 34 ? '"' : "'", valStart);
				if (close === -1 || close >= tagLimit) {
					unclosed = true;
					break;
				}
				val = html.slice(valStart, close);
				i = close + 1;
			} else {
				const valStart = i;
				while (i < tagLimit && !isAsciiSpace(html.charCodeAt(i)) && html.charCodeAt(i) !== 62) i++;
				val = html.slice(valStart, i);
			}

			if (attrName === 'property') propKey = val.trim().toLowerCase();
			else if (attrName === 'name') nameKey = val.trim().toLowerCase();
			else if (attrName === 'content') {
				contentVal = val.trim();
				hasContent = true;
			}
		}

		if (hasContent && contentVal) {
			const decoded = decodeHtmlEntities(contentVal);
			if (propKey && !property.has(propKey)) property.set(propKey, decoded);
			if (nameKey && !name.has(nameKey)) name.set(nameKey, decoded);
		}
		if (unclosed) {
			const nextGt = html.indexOf('>', after);
			pos = nextGt !== -1 && nextGt < tagLimit ? nextGt + 1 : after;
		} else {
			pos = Math.max(i, after);
		}
	}

	return { property, name };
}

function extractTitle(html: string): string {
	const lower = html.toLowerCase();
	let pos = 0;
	while (pos < lower.length) {
		const start = lower.indexOf('<title', pos);
		if (start === -1) return '';
		const after = start + 6;
		const nextCode = lower.charCodeAt(after);
		if (nextCode !== 62 && !isAsciiSpace(nextCode)) {
			pos = after;
			continue;
		}
		const gt = lower.indexOf('>', after);
		if (gt === -1 || gt - start > 512) return '';
		const end = lower.indexOf('</title>', gt + 1);
		if (end === -1 || end - (gt + 1) > 500) return '';
		const raw = html.slice(gt + 1, end);
		if (raw.includes('<')) return '';
		return raw.trim();
	}
	return '';
}

/**
 * The part of the page worth scanning. Tags live in `<head>`, and `</head>` is
 * optional in HTML so `<body` ends the head too. A head without any og:/twitter:
 * meta tag falls back to the whole page so misplaced tags still produce a card.
 */
function metaScope(html: string): string {
	const lower = html.toLowerCase();
	const headEnd = lower.indexOf('</head');
	const bodyStart = lower.indexOf('<body');
	const end =
		headEnd !== -1 && bodyStart !== -1
			? Math.min(headEnd, bodyStart)
			: headEnd !== -1
				? headEnd
				: bodyStart;
	if (end === -1) return html;
	const head = html.slice(0, end);
	const scanned = scanMetaTags(head);
	for (const key of scanned.property.keys()) {
		if (key.startsWith('og:') || key.startsWith('twitter:')) return head;
	}
	for (const key of scanned.name.keys()) {
		if (key.startsWith('og:') || key.startsWith('twitter:')) return head;
	}
	return html;
}

/**
 * Pure HTML → OG parser (no network). Exported for unit tests.
 * `baseUrl` resolves relative `og:image` values.
 */
export function parseOpenGraphHtml(page: string, baseUrl: string): OpenGraphData {
	const html = metaScope(page);
	const { property, name } = scanMetaTags(html);
	const title =
		property.get('og:title') ||
		name.get('twitter:title') ||
		decodeHtmlEntities(extractTitle(html)) ||
		'';
	const description =
		property.get('og:description') ||
		name.get('twitter:description') ||
		name.get('description') ||
		'';
	const siteName = property.get('og:site_name') || name.get('twitter:site') || null;
	let image =
		property.get('og:image') || property.get('og:image:url') || name.get('twitter:image') || null;
	if (image) {
		try {
			image = new URL(image, baseUrl).toString();
			const iu = new URL(image);
			if (iu.protocol !== 'http:' && iu.protocol !== 'https:') image = null;
			else if (isBlockedInstanceHost(iu.hostname)) image = null;
		} catch {
			image = null;
		}
	}
	return {
		url: baseUrl,
		title: title.slice(0, 300),
		description: description.slice(0, 1000),
		image,
		siteName: siteName?.slice(0, 200) ?? null
	};
}

/**
 * Read a response body up to `maxBytes`, stopping as soon as the limit is
 * crossed. `arrayBuffer()` buffered a hostile or endless response in full
 * before the size check could run, which can OOM the isolate (1102) instead of
 * returning a clean 400.
 */
export async function readCappedBody(res: Response, maxBytes: number): Promise<Uint8Array> {
	const tooLarge = () => Object.assign(new Error('Preview response too large'), { status: 400 });
	const declared = Number(res.headers.get('content-length') ?? '');
	if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
	if (!res.body) return new Uint8Array(await res.arrayBuffer());
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) throw tooLarge();
			chunks.push(value);
		}
	} finally {
		// Stop a host that keeps pushing bytes after we have given up.
		await reader.cancel().catch(() => {});
	}
	const bytes = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.byteLength;
	}
	return bytes;
}

async function fetchWithRedirects(
	url: string,
	fetchImpl: FetchLike,
	opts: { maxBytes: number; timeoutMs: number }
): Promise<{ finalUrl: string; bytes: Uint8Array; contentType: string }> {
	let current = url;
	for (let i = 0; i <= OG_MAX_REDIRECTS; i++) {
		assertPublicHttpUrl(current);
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
		let res: Response;
		try {
			res = await fetchImpl(current, {
				headers: {
					'User-Agent': 'cogsend/1.0 (+link-preview)',
					Accept: 'text/html,application/xhtml+xml'
				},
				redirect: 'manual',
				signal: ctrl.signal
			} as RequestInit);
		} catch (err) {
			clearTimeout(timer);
			if ((err as Error)?.name === 'AbortError' || (err as Error)?.name === 'TimeoutError') {
				throw Object.assign(new Error('Preview fetch timed out'), { status: 504 });
			}
			throw err;
		} finally {
			clearTimeout(timer);
		}
		if (
			res.status === 301 ||
			res.status === 302 ||
			res.status === 303 ||
			res.status === 307 ||
			res.status === 308
		) {
			const loc = res.headers.get('location');
			if (!loc)
				throw Object.assign(new Error('Preview redirect without location'), {
					status: 502
				});
			try {
				current = new URL(loc, current).toString();
			} catch {
				throw Object.assign(new Error('Preview redirect is not a valid URL'), {
					status: 502
				});
			}
			continue;
		}
		if (!res.ok) {
			throw Object.assign(new Error(`Preview fetch failed (${res.status})`), {
				status: res.status >= 500 ? 502 : 400
			});
		}
		const contentType = res.headers.get('content-type') || '';
		return { finalUrl: current, bytes: await readCappedBody(res, opts.maxBytes), contentType };
	}
	throw Object.assign(new Error('Too many redirects'), { status: 400 });
}

/** Fetch + parse OG tags for a URL. Throws 4xx/502/504, never 500. */
export async function fetchOpenGraph(
	rawUrl: string,
	fetchImpl: FetchLike = fetch
): Promise<OpenGraphData> {
	const start = assertPublicHttpUrl(rawUrl).toString();
	const { finalUrl, bytes, contentType } = await fetchWithRedirects(start, fetchImpl, {
		maxBytes: OG_HTML_MAX_BYTES,
		timeoutMs: OG_FETCH_TIMEOUT_MS
	});
	if (!/text\/html|application\/xhtml/i.test(contentType)) {
		throw Object.assign(new Error('URL did not return HTML'), { status: 400 });
	}
	const html = new TextDecoder().decode(bytes);
	const og = parseOpenGraphHtml(html, finalUrl);
	if (!og.title && !og.description && !og.image) {
		throw Object.assign(new Error('No preview found for this link'), { status: 404 });
	}
	return og;
}

export interface FetchedOgImage {
	bytes: Uint8Array;
	mime: string;
}

/** Fetch an OG image with host/size guards. Null = unusable (caller omits thumb). */
export async function fetchOgImage(
	rawUrl: string,
	fetchImpl: FetchLike = fetch
): Promise<FetchedOgImage | null> {
	let current: string;
	try {
		current = assertPublicHttpUrl(rawUrl).toString();
	} catch {
		return null;
	}
	try {
		let res: Response | null = null;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let endedOnRedirect = true;
		for (let i = 0; i <= OG_MAX_REDIRECTS; i++) {
			try {
				assertPublicHttpUrl(current);
			} catch {
				return null;
			}
			const ctrl = new AbortController();
			timer = setTimeout(() => ctrl.abort(), OG_FETCH_TIMEOUT_MS);
			try {
				res = await fetchImpl(current, {
					headers: { 'User-Agent': 'cogsend/1.0 (+link-preview)', Accept: 'image/*' },
					redirect: 'manual',
					signal: ctrl.signal
				} as RequestInit);
			} catch {
				clearTimeout(timer);
				return null;
			}
			if (
				res.status === 301 ||
				res.status === 302 ||
				res.status === 303 ||
				res.status === 307 ||
				res.status === 308
			) {
				clearTimeout(timer);
				timer = undefined;
				const loc = res.headers.get('location');
				if (!loc) return null;
				try {
					current = new URL(loc, current).toString();
				} catch {
					return null;
				}
				continue;
			}
			endedOnRedirect = false;
			break;
		}
		try {
			// A chain that never stopped redirecting has no image to read.
			if (endedOnRedirect || !res || !res.ok) return null;
			// Defense in depth: some fetch impls ignore `redirect: manual`.
			// Verify the post-redirect URL is still public before trusting bytes.
			if (res.url) assertPublicHttpUrl(res.url);
			const mime = (res.headers.get('content-type') || '').split(';')[0]!.trim().toLowerCase();
			if (!mime.startsWith('image/')) return null;
			// readCappedBody streams and stops at the cap. arrayBuffer() let a
			// hostile or endless response buffer in full before the size check,
			// which can OOM the isolate (1102). The timeout stays armed through
			// the body read because the signal aborts the stream.
			const bytes = await readCappedBody(res, OG_IMAGE_MAX_BYTES);
			if (!bytes.length) return null;
			return { bytes, mime };
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	} catch {
		return null;
	}
}

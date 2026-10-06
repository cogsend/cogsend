/**
 * Author and text of an X post, for the composer's quote card.
 *
 * x.com serves a server only "Name (@handle) on X", so the card asks X's
 * oEmbed endpoint instead: official, free and keyless, unlike the API's post
 * lookup, which spends credits on every preview. The request is built from the
 * parsed post id alone and always goes to publish.x.com, so a caller cannot
 * point it anywhere else.
 */

import { parseXPostUrl } from '$lib/domain/x-quote';
import { decodeHtmlEntities, readCappedBody, type OpenGraphData } from './opengraph';
import type { FetchLike } from './providers/types';

const OEMBED_ENDPOINT = 'https://publish.x.com/oembed';
const OEMBED_MAX_BYTES = 256_000;
const OEMBED_TIMEOUT_MS = 10_000;
const TEXT_MAX_CHARS = 1000;

export interface XPostDetails {
	id: string;
	name: string;
	handle: string;
	text: string;
	date: string;
}

export type XPostPreview = OpenGraphData & { xPost: XPostDetails };

type OEmbed = { author_name?: unknown; author_url?: unknown; html?: unknown };

function stripHtml(html: string): string {
	return decodeHtmlEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ''));
}

function handleFromAuthorUrl(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const m = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?$/.exec(value.trim());
	return m ? m[1] : null;
}

/** The post's text and date out of the embed's blockquote. */
export function parseOEmbedHtml(html: string): { text: string; date: string } {
	const p = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(html);
	const date = /<a\b[^>]*>([^<]*)<\/a>\s*<\/blockquote>/i.exec(html);
	return {
		text: p ? stripHtml(p[1]).trim().slice(0, TEXT_MAX_CHARS) : '',
		date: date ? stripHtml(date[1]).trim().slice(0, 40) : ''
	};
}

function failure(message: string, status: number): Error {
	return Object.assign(new Error(message), { status });
}

/** Throws 404 when X has no public post at that link, 502 for anything else it gets wrong. */
export async function fetchXPostPreview(
	rawUrl: string,
	fetchImpl: FetchLike
): Promise<XPostPreview> {
	const ref = parseXPostUrl(rawUrl);
	if (!ref) throw failure('Not an X post link', 400);
	const canonical = `https://x.com/${ref.handle ?? 'i'}/status/${ref.id}`;
	const endpoint = `${OEMBED_ENDPOINT}?${new URLSearchParams({
		url: canonical,
		omit_script: '1',
		dnt: 'true'
	})}`;
	let res: Response;
	try {
		res = await fetchImpl(endpoint, {
			headers: { Accept: 'application/json' },
			redirect: 'manual',
			signal: AbortSignal.timeout(OEMBED_TIMEOUT_MS)
		});
	} catch {
		throw failure('X did not answer', 502);
	}
	// A deleted post and a protected account's post both answer 404 or 403.
	if (res.status === 404 || res.status === 403) throw failure("This post can't be loaded", 404);
	if (res.status !== 200) throw failure(`X answered ${res.status}`, 502);
	let data: OEmbed;
	try {
		const bytes = await readCappedBody(res, OEMBED_MAX_BYTES);
		data = JSON.parse(new TextDecoder().decode(bytes)) as OEmbed;
	} catch {
		throw failure('X sent an unreadable answer', 502);
	}
	if (!data || typeof data !== 'object' || typeof data.html !== 'string') {
		throw failure('X sent an unreadable answer', 502);
	}
	const handle = handleFromAuthorUrl(data.author_url) ?? ref.handle ?? '';
	const name =
		typeof data.author_name === 'string' && data.author_name.trim()
			? data.author_name.trim().slice(0, 100)
			: handle;
	const { text, date } = parseOEmbedHtml(data.html);
	const url = `https://x.com/${handle || 'i'}/status/${ref.id}`;
	return {
		url,
		title: handle ? `${name} (@${handle})` : name,
		description: text,
		image: null,
		siteName: 'X',
		xPost: { id: ref.id, name, handle, text, date }
	};
}

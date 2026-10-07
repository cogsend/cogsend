import { describe, expect, it } from 'vitest';
import {
	attachXQuote,
	keepXQuoteOnX,
	moveXPostLinkToEnd,
	parseXPostUrl,
	quotableXPosts,
	quotedPostText,
	shareXQuote,
	strayXPostLinks,
	swapXQuote,
	trailingXQuote
} from '$lib/domain/x-quote';

const LINK = 'https://x.com/ada_builds/status/1974452871209381904';

describe('parseXPostUrl', () => {
	it('reads the post id and handle from every X post link shape', () => {
		expect(parseXPostUrl(LINK)).toEqual({ id: '1974452871209381904', handle: 'ada_builds' });
		expect(parseXPostUrl('https://twitter.com/jack/status/20')).toEqual({
			id: '20',
			handle: 'jack'
		});
		expect(parseXPostUrl('https://mobile.twitter.com/jack/status/20')?.id).toBe('20');
		expect(parseXPostUrl('http://www.x.com/jack/statuses/20')?.id).toBe('20');
		expect(parseXPostUrl('https://x.com/i/status/20')).toEqual({ id: '20', handle: null });
		expect(parseXPostUrl('https://x.com/i/web/status/20')).toEqual({ id: '20', handle: null });
		expect(parseXPostUrl(`${LINK}?s=20&t=abc-DEF_1`)?.id).toBe('1974452871209381904');
	});

	it('rejects anything that is not exactly one X post link', () => {
		expect(parseXPostUrl('https://x.com/ada_builds')).toBeNull();
		expect(parseXPostUrl('https://example.com/a/status/1')).toBeNull();
		expect(parseXPostUrl('https://notx.com/a/status/1')).toBeNull();
		expect(parseXPostUrl(`${LINK}/photo/1`)).toBeNull();
		expect(parseXPostUrl('x.com/ada_builds/status/1')).toBeNull();
		expect(parseXPostUrl(`see ${LINK}`)).toBeNull();
		expect(parseXPostUrl('')).toBeNull();
	});
});

describe('trailingXQuote', () => {
	it('finds the link that ends the text and what the text box shows without it', () => {
		expect(trailingXQuote(`So good.\n${LINK}`)).toEqual({
			visible: 'So good.',
			url: LINK,
			id: '1974452871209381904',
			handle: 'ada_builds',
			sep: '\n'
		});
		expect(trailingXQuote(`So good. ${LINK}`)?.sep).toBe(' ');
		expect(trailingXQuote(LINK)).toMatchObject({ visible: '', sep: '' });
		expect(trailingXQuote(`So good.\n${LINK}\n  `)?.url).toBe(LINK);
	});

	it('quotes the last link when there are two', () => {
		const other = 'https://x.com/jack/status/20';
		expect(trailingXQuote(`${other} and ${LINK}`)).toMatchObject({
			url: LINK,
			visible: `${other} and`
		});
	});

	it('ignores a link that is not the last thing in the text', () => {
		expect(trailingXQuote(`${LINK} so good`)).toBeNull();
		expect(trailingXQuote(`${LINK}.`)).toBeNull();
		expect(trailingXQuote(`${LINK}/photo/1`)).toBeNull();
		expect(trailingXQuote(`text${LINK}`)).toBeNull();
		expect(trailingXQuote('https://example.com/a/status/1')).toBeNull();
		expect(trailingXQuote('')).toBeNull();
	});

	it('round-trips through attachXQuote without reshaping the text', () => {
		const cases = [
			LINK,
			`a\n${LINK}`,
			`a ${LINK}`,
			`a\n\n${LINK}`,
			`a  ${LINK}`,
			`a\t${LINK}`,
			`\n${LINK}`,
			`line one\nline two\n${LINK}?s=20`,
			`https://x.com/jack/status/20 then ${LINK}`
		];
		for (const text of cases) {
			const q = trailingXQuote(text)!;
			expect(q, text).not.toBeNull();
			expect(attachXQuote(q.visible, q.url, q.sep), text).toBe(text);
		}
	});

	it('keeps text typed into the box stable after the link is put back', () => {
		// Typing a newline at the end of the box must not be swallowed.
		const q = trailingXQuote(`abc\n${LINK}`)!;
		const next = attachXQuote(`${q.visible}\n`, q.url, q.sep);
		expect(trailingXQuote(next)?.visible).toBe('abc\n');
		// Typing into an empty box after the link was the whole text.
		const only = trailingXQuote(LINK)!;
		const typed = attachXQuote('hi', only.url, only.sep);
		expect(typed).toBe(`hi\n${LINK}`);
		expect(trailingXQuote(typed)?.visible).toBe('hi');
	});
});

describe('strayXPostLinks', () => {
	it('lists X post links that X will show as plain links', () => {
		expect(strayXPostLinks(`${LINK} is great`)).toEqual([{ url: LINK, index: 0 }]);
		expect(strayXPostLinks(`see ${LINK}.`)).toEqual([{ url: LINK, index: 4 }]);
	});

	it('leaves out the trailing link and non-X links', () => {
		expect(strayXPostLinks(`see ${LINK}`)).toEqual([]);
		expect(strayXPostLinks('see https://example.com/a/status/1 now')).toEqual([]);
		const other = 'https://x.com/jack/status/20';
		expect(strayXPostLinks(`${other} then ${LINK}`)).toEqual([{ url: other, index: 0 }]);
	});
});

describe('moveXPostLinkToEnd', () => {
	it('moves the link to the end, where X quotes it', () => {
		const moved = moveXPostLinkToEnd(`see ${LINK} it is great`, 4);
		expect(moved).toBe(`see it is great\n${LINK}`);
		expect(trailingXQuote(moved)?.visible).toBe('see it is great');
		expect(moveXPostLinkToEnd(`${LINK} wow`, 0)).toBe(`wow\n${LINK}`);
		expect(moveXPostLinkToEnd(`${LINK}`, 0)).toBe(LINK);
	});

	it('leaves the text alone when no link starts at that index', () => {
		expect(moveXPostLinkToEnd(`see ${LINK}`, 2)).toBe(`see ${LINK}`);
	});
});

describe('quotableXPosts', () => {
	const target = (over: Record<string, unknown>) => ({
		status: 'published',
		remoteUrl: LINK,
		updatedAt: '2026-10-01T10:00:00Z',
		connection: { platform: 'x' },
		draft: { baseBody: 'hello' },
		...over
	});

	it('keeps published X posts with a post link, newest first, once each', () => {
		const older = 'https://x.com/you/status/10';
		const out = quotableXPosts([
			target({ remoteUrl: older, updatedAt: '2026-09-01T10:00:00Z', draft: { baseBody: 'old' } }),
			target({}),
			target({ updatedAt: '2026-08-01T10:00:00Z' })
		]);
		expect(out.map((p) => p.url)).toEqual([LINK, older]);
		expect(out[0].body).toBe('hello');
	});

	it('drops everything that cannot be quoted', () => {
		expect(
			quotableXPosts([
				target({ status: 'scheduled' }),
				target({ status: 'failed' }),
				target({ connection: { platform: 'bluesky' } }),
				target({ remoteUrl: null }),
				target({ remoteUrl: 'https://example.com/a/status/1' }),
				target({ remoteUrl: 'javascript:alert(1)' })
			])
		).toEqual([]);
	});

	it('stops at the limit', () => {
		const many = Array.from({ length: 12 }, (_, i) =>
			target({ remoteUrl: `https://x.com/you/status/${i + 1}` })
		);
		expect(quotableXPosts(many)).toHaveLength(8);
		expect(quotableXPosts(many, 3)).toHaveLength(3);
	});
});

describe('swapXQuote', () => {
	const other = 'https://x.com/jack/status/20';

	it('quotes the other link and keeps the old quote in its place', () => {
		const text = `Two posts ${other} ${LINK}`;
		const swapped = swapXQuote(text, 10);
		expect(swapped).toBe(`Two posts ${LINK} ${other}`);
		expect(trailingXQuote(swapped)?.url).toBe(other);
		expect(strayXPostLinks(swapped)).toEqual([{ url: LINK, index: 10 }]);
		// Swapping back restores the original text.
		expect(swapXQuote(swapped, 10)).toBe(text);
	});

	it('keeps the separator before the quote', () => {
		expect(swapXQuote(`${other} first\n${LINK}`, 0)).toBe(`${LINK} first\n${other}`);
	});

	it('moves the link to the end when nothing is quoted yet', () => {
		expect(swapXQuote(`${other} wow`, 0)).toBe(`wow\n${other}`);
	});

	it('leaves the text alone when no link starts at that index', () => {
		const text = `Two posts ${other} ${LINK}`;
		expect(swapXQuote(text, 3)).toBe(text);
	});
});

describe('quotedPostText', () => {
	it('drops the links X draws as a card or image', () => {
		expect(quotedPostText('Bento for all business emails https://t.co/IUFHHSpaEy')).toBe(
			'Bento for all business emails'
		);
		expect(quotedPostText('Look at this pic.twitter.com/AbC123')).toBe('Look at this');
		expect(quotedPostText('Two https://t.co/a1 https://t.co/b2\n')).toBe('Two');
		expect(quotedPostText('https://t.co/a1')).toBe('');
	});

	it('keeps links inside the text', () => {
		expect(quotedPostText('See https://t.co/a1 for more')).toBe('See https://t.co/a1 for more');
		expect(quotedPostText('Plain text')).toBe('Plain text');
	});
});

describe('keepXQuoteOnX', () => {
	it('keeps the whole text for X and drops the link from the others', () => {
		expect(keepXQuoteOnX(`Worth reading. ${LINK}`, 0)).toEqual({
			x: `Worth reading. ${LINK}`,
			global: 'Worth reading.'
		});
		expect(keepXQuoteOnX(`Line one\n\nLine two\n${LINK}`, 0)?.global).toBe('Line one\n\nLine two');
	});

	it('changes only the card it was asked about', () => {
		const body = `First ${LINK}\n---\nSecond ${LINK}`;
		expect(keepXQuoteOnX(body, 1)).toEqual({ x: body, global: `First ${LINK}\n---\nSecond` });
	});

	it('refuses a card that is only the quote, or has none', () => {
		expect(keepXQuoteOnX(LINK, 0)).toBeNull();
		expect(keepXQuoteOnX(`Intro\n---\n${LINK}`, 1)).toBeNull();
		expect(keepXQuoteOnX('No quote here', 0)).toBeNull();
		expect(keepXQuoteOnX(`Worth reading. ${LINK}`, 3)).toBeNull();
	});
});

describe('shareXQuote', () => {
	it('undoes keepXQuoteOnX exactly, so X can follow Global again', () => {
		for (const body of [
			`Worth reading. ${LINK}`,
			`Worth reading.\n${LINK}`,
			`Intro\n---\nSecond card\n\n${LINK}`
		]) {
			const index = body.includes('---') ? 1 : 0;
			const split = keepXQuoteOnX(body, index)!;
			expect(shareXQuote(split.global, split.x, index)).toEqual({ global: body, xFollows: true });
		}
	});

	it('adds the link but keeps X apart when the texts differ otherwise', () => {
		expect(shareXQuote('For everyone.', `Just for X. ${LINK}`, 0)).toEqual({
			global: `For everyone. ${LINK}`,
			xFollows: false
		});
	});

	it('gives an empty card just the link', () => {
		expect(shareXQuote('Intro\n---\n', `Intro\n---\n${LINK}`, 1)).toEqual({
			global: `Intro\n---\n${LINK}`,
			xFollows: true
		});
	});

	it('does nothing when the others already link to that post, or have no such card', () => {
		const other = 'https://twitter.com/ada_builds/status/1974452871209381904?s=20';
		expect(shareXQuote(`See ${other} first`, `See it. ${LINK}`, 0)).toBeNull();
		expect(shareXQuote('Only one card', `One\n---\nTwo ${LINK}`, 1)).toBeNull();
		expect(shareXQuote('Words', 'No quote on X', 0)).toBeNull();
	});
});

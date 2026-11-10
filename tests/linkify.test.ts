import { describe, expect, it } from 'vitest';
import { cardParts, linkParts } from '#lib/domain/linkify.js';

describe('linkParts', () => {
	it('returns plain text as one part', () => {
		expect(linkParts('just words #tag @alice.bsky.social')).toEqual([
			{ text: 'just words #tag @alice.bsky.social' }
		]);
		expect(linkParts('')).toEqual([]);
	});

	it('links http(s) and bare-domain links, keeping their text', () => {
		expect(linkParts('see https://x.com/a, and cogsend.com.')).toEqual([
			{ text: 'see ' },
			{ text: 'https://x.com/a', href: 'https://x.com/a' },
			{ text: ', and ' },
			{ text: 'cogsend.com', href: 'https://cogsend.com' },
			{ text: '.' }
		]);
	});

	it('never links anything but http(s)', () => {
		const parts = linkParts('javascript:alert(1) data:text/html,x ftp://x.com');
		expect(parts.filter((p) => p.href)).toEqual([]);
	});

	it('leaves a link running into a cut as plain text', () => {
		expect(linkParts('read https://x.com/long', { cut: true })).toEqual([
			{ text: 'read https://x.com/long' }
		]);
		expect(linkParts('https://x.com/a then more', { cut: true })[0]).toEqual({
			text: 'https://x.com/a',
			href: 'https://x.com/a'
		});
	});
});

describe('cardParts', () => {
	it('keeps the card excerpt, its line breaks and its links', () => {
		expect(cardParts('one\n\n\n\ncogsend.com')).toEqual([
			{ text: 'one\n\n' },
			{ text: 'cogsend.com', href: 'https://cogsend.com' }
		]);
		expect(cardParts('')).toEqual([{ text: 'Empty draft' }]);
	});

	it('does not link half an address cut off by the card', () => {
		const parts = cardParts(`${'a'.repeat(480)} https://example.com/${'b'.repeat(60)}`);
		expect(parts.some((p) => p.href)).toBe(false);
		expect(parts.at(-1)).toEqual({ text: '…' });
	});
});

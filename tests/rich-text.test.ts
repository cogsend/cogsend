import { describe, expect, it } from 'vitest';
import { findRichText, isValidDomain } from '#lib/domain/rich-text.js';

/** Each entity as [kind, the text it covers, its target]. */
function found(text: string) {
	return findRichText(text).map((e) => [
		e.type,
		text.slice(e.start, e.end),
		e.type === 'link' ? e.uri : e.type === 'tag' ? e.tag : e.handle
	]);
}

describe('isValidDomain', () => {
	it('takes a real top-level domain typed in lower case', () => {
		expect(isValidDomain('cogsend.com')).toBe(true);
		expect(isValidDomain('CogSend.com')).toBe(true);
		expect(isValidDomain('alice.bsky.social')).toBe(true);
		expect(isValidDomain('example.co.uk')).toBe(true);
	});

	it('refuses an unknown or capitalised ending, and anything without one', () => {
		expect(isValidDomain('node.js')).toBe(false);
		expect(isValidDomain('cogsend.notatld')).toBe(false);
		expect(isValidDomain('ends.It')).toBe(false);
		expect(isValidDomain('COGSEND.COM')).toBe(false);
		expect(isValidDomain('cogsend')).toBe(false);
		expect(isValidDomain('cogsend.')).toBe(false);
		expect(isValidDomain('.com')).toBe(false);
	});
});

describe('findRichText links', () => {
	it('finds http(s) links anywhere, as before', () => {
		expect(found('see https://cogsend.com/docs today')).toEqual([
			['link', 'https://cogsend.com/docs', 'https://cogsend.com/docs']
		]);
		expect(found('quote:https://x.com/a')).toEqual([
			['link', 'https://x.com/a', 'https://x.com/a']
		]);
	});

	it('leaves the sentence’s punctuation and quotes outside a link', () => {
		expect(found('(see https://x.com/a).')).toEqual([
			['link', 'https://x.com/a', 'https://x.com/a']
		]);
		expect(found('read "https://x.com/q", ok?')).toEqual([
			['link', 'https://x.com/q', 'https://x.com/q']
		]);
		expect(found('end https://x.com/a?!')).toEqual([
			['link', 'https://x.com/a', 'https://x.com/a']
		]);
	});

	it('keeps a bracket the link opened, as on Wikipedia', () => {
		const wiki = 'https://en.wikipedia.org/wiki/Foo_(bar)';
		expect(found(`go ${wiki} now`)).toEqual([['link', wiki, wiki]]);
		expect(found(`(${wiki})`)).toEqual([['link', wiki, wiki]]);
	});

	it('links a domain typed without https://, keeping the text as typed', () => {
		expect(found('see cogsend.com today')).toEqual([
			['link', 'cogsend.com', 'https://cogsend.com']
		]);
		expect(found('docs at cogsend.com/docs/posts, and more')).toEqual([
			['link', 'cogsend.com/docs/posts', 'https://cogsend.com/docs/posts']
		]);
		expect(found('(my-site.com:8080/x?y=1)')).toEqual([
			['link', 'my-site.com:8080/x?y=1', 'https://my-site.com:8080/x?y=1']
		]);
	});

	it('does not link what only looks like a domain', () => {
		for (const text of [
			'cogsend',
			'cogsend. com',
			'mail me@cogsend.com',
			'ends.It here',
			'v1.2.3 and 3.14',
			'node.js',
			'cogsend.notatld',
			'e.g. this'
		]) {
			expect(found(text), text).toEqual([]);
		}
	});

	it('measures ranges in UTF-16, after emoji', () => {
		const text = '👋🏽 नमस्ते cogsend.com';
		const [link] = findRichText(text);
		expect(text.slice(link.start, link.end)).toBe('cogsend.com');
	});
});

describe('findRichText hashtags', () => {
	it('finds tags as Bluesky does', () => {
		expect(found('#buildinpublic #100days #tag. ＃full #日本語')).toEqual([
			['tag', '#buildinpublic', 'buildinpublic'],
			['tag', '#100days', '100days'],
			['tag', '#tag', 'tag'],
			['tag', '＃full', 'full'],
			['tag', '#日本語', '日本語']
		]);
	});

	it('skips numbers, a # inside a word or a link, and tags over 64', () => {
		expect(found('#100 a#b https://x.com/#frag')).toEqual([
			['link', 'https://x.com/#frag', 'https://x.com/#frag']
		]);
		expect(found(`#${'a'.repeat(65)}`)).toEqual([]);
		expect(found(`#${'a'.repeat(64)}`)).toHaveLength(1);
	});
});

describe('findRichText mentions', () => {
	it('finds a handle that is a domain, lower-cased, without the full stop after it', () => {
		expect(found('hi @Alice.bsky.social. and (@bob.example.com)')).toEqual([
			['mention', '@Alice.bsky.social', 'alice.bsky.social'],
			['mention', '@bob.example.com', 'bob.example.com']
		]);
	});

	it('skips a bare @name, an email and a handle inside a link', () => {
		expect(found('@bob me@cogsend.com https://x.com/@alice.bsky.social')).toEqual([
			['link', 'https://x.com/@alice.bsky.social', 'https://x.com/@alice.bsky.social']
		]);
	});

	it('returns everything in order', () => {
		expect(found('#a @alice.bsky.social cogsend.com').map(([kind]) => kind)).toEqual([
			'tag',
			'mention',
			'link'
		]);
	});
});

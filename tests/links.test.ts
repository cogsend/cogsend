import { describe, expect, it } from 'vitest';
import {
	extractFirstUrl,
	extractUrls,
	previewDomain,
	safeHttpUrl,
	shouldAttachLinkCard
} from '$lib/domain/links';

describe('links', () => {
	it('extracts urls and strips trailing punctuation', () => {
		expect(extractUrls('see https://example.com/a, and this.')).toEqual(['https://example.com/a']);
		expect(extractUrls('no links')).toEqual([]);
	});

	it('takes the first url as card candidate', () => {
		expect(extractFirstUrl('a https://b.com/x b https://c.com')).toBe('https://b.com/x');
		expect(extractFirstUrl('plain')).toBeNull();
	});

	it('suppresses card when media attached', () => {
		expect(shouldAttachLinkCard('https://example.com', false)).toBe(true);
		expect(shouldAttachLinkCard('https://example.com', true)).toBe(false);
		expect(shouldAttachLinkCard('no url', false)).toBe(false);
	});

	it('parses preview domain', () => {
		expect(previewDomain('https://Example.COM/x')).toBe('example.com');
		expect(previewDomain('not a url')).toBeNull();
	});

	it('keeps only http(s) links for an href, exactly as given', () => {
		expect(safeHttpUrl('https://mastodon.test/@me/1')).toBe('https://mastodon.test/@me/1');
		expect(safeHttpUrl(' http://example.com/a ')).toBe('http://example.com/a');
		for (const bad of [
			'javascript:alert(1)',
			'JavaScript:alert(1)',
			'data:text/html,x',
			'/relative',
			'',
			null,
			42
		]) {
			expect(safeHttpUrl(bad)).toBeNull();
		}
	});
});

import { describe, expect, it } from 'vitest';
import {
	accountLabel,
	displayHandle,
	displayHost,
	isPlatformId,
	PLATFORM_ORDER,
	platformRank,
	PREVIEW_PRIORITY,
	supportsThreads
} from '#lib/domain/platforms.js';

describe('platforms', () => {
	it('recognizes the six platform ids', () => {
		expect(isPlatformId('mastodon')).toBe(true);
		expect(isPlatformId('bluesky')).toBe(true);
		expect(isPlatformId('linkedin')).toBe(true);
		expect(isPlatformId('threads')).toBe(true);
		expect(isPlatformId('instagram')).toBe(true);
		expect(isPlatformId('x')).toBe(true);
		expect(isPlatformId('twitter')).toBe(false);
	});

	it('mastodon, bluesky, x, and threads support threads', () => {
		expect(supportsThreads('mastodon')).toBe(true);
		expect(supportsThreads('bluesky')).toBe(true);
		expect(supportsThreads('x')).toBe(true);
		expect(supportsThreads('threads')).toBe(true);
		expect(supportsThreads('linkedin')).toBe(false);
		expect(supportsThreads('instagram')).toBe(false);
	});

	it('preview priority covers every platform exactly once', () => {
		expect([...PREVIEW_PRIORITY].sort()).toEqual([
			'bluesky',
			'instagram',
			'linkedin',
			'mastodon',
			'threads',
			'x'
		]);
	});

	it('orders X first, then threads, instagram, linkedin, mastodon, bluesky', () => {
		expect([...PLATFORM_ORDER]).toEqual([
			'x',
			'threads',
			'instagram',
			'linkedin',
			'mastodon',
			'bluesky'
		]);
		expect(platformRank('x')).toBe(0);
		expect(platformRank('bluesky')).toBe(5);
		expect(platformRank('unknown')).toBe(99);
	});
});

describe('displayHandle', () => {
	it('strips the generic .bsky.social suffix', () => {
		expect(displayHandle('testuser.bsky.social')).toBe('testuser');
		expect(displayHandle('TestUser.BSKY.SOCIAL')).toBe('TestUser');
	});

	it('leaves custom domains and other handles alone', () => {
		expect(displayHandle('name.com')).toBe('name.com');
		expect(displayHandle('@TestUsers')).toBe('@TestUsers');
		expect(displayHandle('testuser')).toBe('testuser');
	});

	it('handles empty values', () => {
		expect(displayHandle(null)).toBe('');
		expect(displayHandle(undefined)).toBe('');
		expect(displayHandle('')).toBe('');
	});
});

describe('displayHost', () => {
	it('strips protocol and trailing slash', () => {
		expect(displayHost('https://mastodon.social')).toBe('mastodon.social');
		expect(displayHost('http://mastodon.social/')).toBe('mastodon.social');
		expect(displayHost('mastodon.social')).toBe('mastodon.social');
	});

	it('handles empty values', () => {
		expect(displayHost(null)).toBe('');
		expect(displayHost(undefined)).toBe('');
	});
});

describe('accountLabel', () => {
	it('shows the full value once when name and handle match', () => {
		expect(accountLabel('testuser.bsky.social', 'testuser.bsky.social')).toBe(
			'testuser.bsky.social'
		);
	});

	it('joins distinct names and short handles', () => {
		expect(accountLabel('TestUser', '@testuser')).toBe('TestUser · @testuser');
		expect(accountLabel('Test User', 'test@example.com')).toBe('Test User · test@example.com');
	});

	it('omits a handle that repeats the name', () => {
		expect(accountLabel('testuser', 'testuser.bsky.social')).toBe('testuser');
		expect(accountLabel('TestUser', null)).toBe('TestUser');
	});

	it('falls back to handle or empty', () => {
		expect(accountLabel(null, 'testuser.bsky.social')).toBe('testuser');
		expect(accountLabel(null, null)).toBe('');
	});

	it('qualifies mastodon usernames to @user@host', () => {
		expect(accountLabel('TestUser', 'testuser', 'https://mastodon.social')).toBe(
			'TestUser · @testuser@mastodon.social'
		);
		expect(accountLabel('testuser', 'testuser', 'https://mastodon.social')).toBe(
			'@testuser@mastodon.social'
		);
	});

	it('leaves already-qualified handles alone', () => {
		expect(accountLabel('Name', 'user@remote.social', 'https://mastodon.social')).toBe(
			'Name · user@remote.social'
		);
	});
});

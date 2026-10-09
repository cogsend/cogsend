import { describe, expect, it } from 'vitest';
import {
	RELEASES_URL,
	highestVersionTag,
	isNewer,
	newestRelease,
	parseRelease,
	parseVersion,
	releaseCheckResult
} from '$lib/domain/release-check';

describe('version parsing', () => {
	it('reads tags with or without a leading v', () => {
		expect(parseVersion('v1.2.3')).toEqual([1, 2, 3]);
		expect(parseVersion('1.2.3')).toEqual([1, 2, 3]);
		expect(parseVersion('v10.0.11')).toEqual([10, 0, 11]);
		expect(parseVersion(' v0.0.1 ')).toEqual([0, 0, 1]);
	});

	it('refuses to guess', () => {
		expect(parseVersion('main')).toBe(null);
		expect(parseVersion('')).toBe(null);
		expect(parseVersion(null)).toBe(null);
		expect(parseVersion('1.2')).toBe(null);
	});
});

describe('newer-than', () => {
	it('compares numerically, not as strings', () => {
		expect(isNewer('1.10.0', '1.9.0')).toBe(true);
		expect(isNewer('2.0.0', '1.99.99')).toBe(true);
		expect(isNewer('1.0.1', '1.0.0')).toBe(true);
	});

	it('is false for equal, older or unparsable versions', () => {
		expect(isNewer('1.0.0', '1.0.0')).toBe(false);
		expect(isNewer('0.9.9', '1.0.0')).toBe(false);
		expect(isNewer('main', '1.0.0')).toBe(false);
		expect(isNewer('1.1.0', 'dev')).toBe(false);
	});

	it('orders pre-releases the semver way', () => {
		// "Should I update?" — yes: v1.1.0-rc.1 is ahead of v1.0.0, a release is
		// ahead of its own pre-releases, and a local build without a version
		// cannot be compared at all.
		expect(isNewer('v1.1.0-rc.1', '1.0.0')).toBe(true);
		expect(isNewer('v1.0.0-rc.1', '1.0.0')).toBe(false);
		expect(isNewer('v1.13.0', '1.13.0-rc.2')).toBe(true);
		expect(isNewer('v1.13.0-rc.3', '1.13.0-rc.2')).toBe(true);
		expect(isNewer('v1.13.0-rc.2', '1.13.0-rc.2')).toBe(false);
		// Build noise after the numbers: the numbers alone decide.
		expect(isNewer('1.13.1', '1.13.0+local')).toBe(true);
	});
});

describe('release documents', () => {
	it('reads the fields the app needs', () => {
		expect(
			parseRelease({
				tag_name: 'v1.2.0',
				html_url: 'https://github.com/cogsend/cogsend/releases/tag/v1.2.0',
				published_at: '2026-09-17T06:00:00Z'
			})
		).toEqual({
			tag: 'v1.2.0',
			version: '1.2.0',
			url: 'https://github.com/cogsend/cogsend/releases/tag/v1.2.0',
			publishedAt: '2026-09-17T06:00:00Z'
		});
	});

	it('falls back to the releases page, and rejects junk', () => {
		expect(parseRelease({ tag_name: 'v1.0.0' })?.url).toBe(RELEASES_URL);
		expect(parseRelease({ tag_name: '  ' })).toBe(null);
		expect(parseRelease({})).toBe(null);
		expect(parseRelease(null)).toBe(null);
		expect(parseRelease('v1.0.0')).toBe(null);
	});
});

describe('tags, when no release object exists', () => {
	it('picks the highest version, not the first one listed', () => {
		// The tags endpoint has no ordering guarantee, so compare rather than trust.
		expect(
			highestVersionTag([
				{ name: 'v1.0.0' },
				{ name: 'v1.10.0' },
				{ name: 'v1.9.9' },
				{ name: 'nightly' },
				{ name: 'v0.9.0' }
			])
		).toEqual({
			tag: 'v1.10.0',
			version: '1.10.0',
			url: `${RELEASES_URL}/tag/v1.10.0`,
			publishedAt: null
		});
	});

	it('ignores anything that is not a version, and junk input', () => {
		expect(highestVersionTag([{ name: 'main' }, { name: 'v2' }, {}])).toBe(null);
		expect(highestVersionTag([])).toBe(null);
		expect(highestVersionTag(null)).toBe(null);
		expect(highestVersionTag({ name: 'v1.0.0' })).toBe(null);
	});
});

describe('combined result', () => {
	const release = { tag: 'v1.2.0', version: '1.2.0', url: 'u', publishedAt: null };

	it('flags an available update', () => {
		expect(releaseCheckResult('1.0.0', release, '2026-09-17T06:00:00Z')).toEqual({
			current: '1.0.0',
			latest: release,
			updateAvailable: true,
			checkedAt: '2026-09-17T06:00:00Z'
		});
	});

	it('stays quiet when up to date, and when GitHub could not answer', () => {
		expect(releaseCheckResult('1.2.0', release, 'now').updateAvailable).toBe(false);
		const offline = releaseCheckResult('1.0.0', null, 'now', 'fetch failed');
		expect(offline.updateAvailable).toBe(false);
		expect(offline.error).toBe('fetch failed');
	});
});

describe('the newest release, pre-releases included', () => {
	it('goes by version, not by date, and leaves drafts out', () => {
		const list = [
			{ tag_name: 'v1.15.0', html_url: 'https://x/1.15.0' },
			{ tag_name: 'v1.16.0-rc.1', html_url: 'https://x/rc1' },
			{ tag_name: 'v1.16.0-rc.2', html_url: 'https://x/rc2' },
			{ tag_name: 'v1.17.0', html_url: 'https://x/draft', draft: true },
			{ tag_name: 'not-a-version' }
		];
		expect(newestRelease(list)?.tag).toBe('v1.16.0-rc.2');
		expect(newestRelease([...list, { tag_name: 'v1.16.0' }])?.tag).toBe('v1.16.0');
		expect(newestRelease([])).toBeNull();
		expect(newestRelease({ tag_name: 'v1.0.0' })).toBeNull();
	});
});

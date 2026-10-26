import { describe, expect, it } from 'vitest';
import { isPublicPath } from '../src/hooks.server';

describe('isPublicPath', () => {
	it('leaves publish-time media urls open and everything else gated', () => {
		expect(isPublicPath('/api/media/public/abc123.jpg?exp=1&sig=2')).toBe(true);
		expect(isPublicPath('/api/media/public/abc123.jpg')).toBe(true);
		expect(isPublicPath('/api/health')).toBe(true);
		expect(isPublicPath('/api/auth/claim')).toBe(true);
		expect(isPublicPath('/api/drafts')).toBe(false);
		expect(isPublicPath('/api/media/key-1')).toBe(false);
		expect(isPublicPath('/')).toBe(false);
	});

	it('opens draft preview links and their media, nothing else under the prefix', () => {
		expect(isPublicPath(`/p/${'a'.repeat(64)}`)).toBe(true);
		expect(isPublicPath(`/p/${'a'.repeat(64)}/media/1-aaaaaaaaaaaaaaaa.png`)).toBe(true);
		expect(isPublicPath('/posts')).toBe(false);
		expect(isPublicPath('/api/drafts/x/share')).toBe(false);
	});
});

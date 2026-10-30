import { describe, expect, it } from 'vitest';
import {
	fromZernioPlatform,
	isZernioConnection,
	toZernioPlatform,
	zernioRequestId
} from '#lib/domain/zernio.js';

describe('zernio platform mapping', () => {
	it('maps the five supported platforms both ways and refuses the rest', () => {
		expect(toZernioPlatform('x')).toBe('twitter');
		expect(toZernioPlatform('threads')).toBe('threads');
		expect(toZernioPlatform('instagram')).toBe('instagram');
		expect(toZernioPlatform('linkedin')).toBe('linkedin');
		expect(toZernioPlatform('bluesky')).toBe('bluesky');
		expect(toZernioPlatform('mastodon')).toBeNull();
		expect(fromZernioPlatform('twitter')).toBe('x');
		expect(fromZernioPlatform('bluesky')).toBe('bluesky');
		expect(fromZernioPlatform('instagram')).toBe('instagram');
		// Zernio also does TikTok, Facebook, …: CogSend has no editor for them.
		expect(fromZernioPlatform('tiktok')).toBeNull();
	});

	it('reads the provider marker from a JSON string or a parsed object', () => {
		expect(isZernioConnection('{"provider":"zernio"}')).toBe(true);
		expect(isZernioConnection({ provider: 'zernio' })).toBe(true);
		expect(isZernioConnection('{}')).toBe(false);
		expect(isZernioConnection('{"did":"did:plc:x"}')).toBe(false);
		expect(isZernioConnection(null)).toBe(false);
		expect(isZernioConnection('not json')).toBe(false);
	});

	it('turns the pipeline idempotency key into something Zernio accepts', () => {
		// Zernio validates x-request-id against /^[\w.-]{1,128}$/; the pipeline's
		// key is `${targetId}:${segmentIndex}`.
		const id = zernioRequestId('7b6c1d1e-1111-4222-8333-444455556666:0');
		expect(id).toMatch(/^[\w.-]{1,128}$/);
		expect(zernioRequestId('a:0')).not.toBe(zernioRequestId('a:1'));
		expect(zernioRequestId('a:0')).toBe(zernioRequestId('a:0'));
	});
});

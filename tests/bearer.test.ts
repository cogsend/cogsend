import { describe, expect, it } from 'vitest';
import {
	anySecretMatches,
	extractBearerToken,
	hasAllowedMutationOrigin,
	isInternalApiPath,
	secretMatches
} from '#lib/domain/bearer.js';

describe('extractBearerToken', () => {
	it('reads Authorization Bearer and alternate headers', () => {
		expect(extractBearerToken(new Headers({ authorization: 'Bearer abc.def' }))).toBe('abc.def');
		expect(extractBearerToken(new Headers({ 'x-cogsend-token': ' tok ' }))).toBe('tok');
		expect(extractBearerToken(new Headers({ 'x-cogsend-scheduler': 'sched' }))).toBe('sched');
		expect(extractBearerToken(new Headers())).toBeNull();
	});
});

describe('secretMatches', () => {
	it('accepts an exact match and rejects mismatches', () => {
		expect(secretMatches('same-token-value', 'same-token-value')).toBe(true);
		expect(secretMatches('same-token-value', 'other-token-value')).toBe(false);
		expect(secretMatches('short', 'much-longer-secret')).toBe(false);
		expect(secretMatches(null, 'secret')).toBe(false);
		expect(secretMatches('secret', undefined)).toBe(false);
	});

	it('matches any configured secret', () => {
		expect(anySecretMatches('beta', ['alpha', 'beta', 'gamma'])).toBe(true);
		expect(anySecretMatches('nope', ['alpha', 'beta'])).toBe(false);
		expect(anySecretMatches('token', [undefined, 'token'])).toBe(true);
	});
});

describe('internal paths and CORS', () => {
	it('allows only the two scheduler endpoints', () => {
		expect(isInternalApiPath('/api/internal/tick')).toBe(true);
		expect(isInternalApiPath('/api/internal/publish')).toBe(true);
		expect(isInternalApiPath('/api/drafts')).toBe(false);
		expect(isInternalApiPath('/api/internal/tick/extra')).toBe(false);
	});

	describe('hasAllowedMutationOrigin', () => {
		const req = (origin?: string, referer?: string) =>
			({
				headers: {
					get: (name: string) => {
						if (name === 'origin') return origin ?? null;
						if (name === 'referer') return referer ?? null;
						return null;
					}
				}
			}) as unknown as Request;
		const url = new URL('https://app.example.com/api/drafts');
		it('allows clients that assert no origin (curl, GH Actions)', () => {
			expect(hasAllowedMutationOrigin(req(), url)).toBe(true);
		});
		it('allows matching origin and referer', () => {
			expect(hasAllowedMutationOrigin(req('https://app.example.com'), url)).toBe(true);
			expect(hasAllowedMutationOrigin(req(undefined, 'https://app.example.com/compose'), url)).toBe(
				true
			);
		});
		it('rejects cross-origin mutations', () => {
			expect(hasAllowedMutationOrigin(req('https://evil.example.com'), url)).toBe(false);
			expect(hasAllowedMutationOrigin(req(undefined, 'https://evil.example.com/x'), url)).toBe(
				false
			);
			expect(hasAllowedMutationOrigin(req('not-a-url'), url)).toBe(false);
			// A matching Referer must not rescue a mismatched Origin: that is the
			// whole point of the header, and a browser cannot be made to send this
			// pair, but a request forger can.
			expect(
				hasAllowedMutationOrigin(
					req('https://evil.example.com', 'https://app.example.com/compose'),
					url
				)
			).toBe(false);
		});
	});
});

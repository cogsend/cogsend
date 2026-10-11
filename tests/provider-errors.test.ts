import { describe, expect, it } from 'vitest';
import {
	classifyProviderError,
	providerErrorForStatus,
	ProviderError
} from '#lib/server/providers/types.js';
import { getProvider } from '#lib/server/providers/index.js';
import { isAuthFailure, isFailureRetryable } from '#lib/server/publish.js';

describe('providerErrorForStatus', () => {
	it('keeps the legacy message shape', () => {
		const err = providerErrorForStatus('X post', 500, 'boom');
		expect(err.message).toBe('X post failed (500): boom');
		expect(err.status).toBe(500);
		expect(err.code).toBeUndefined();
	});

	it('codes 401 as auth and 403 as forbidden', () => {
		expect(providerErrorForStatus('X post', 401, 'no').code).toBe('auth');
		expect(providerErrorForStatus('X post', 403, 'policy').code).toBe('forbidden');
		expect(providerErrorForStatus('X post', 429, 'slow').code).toBe('rate_limited');
	});

	it('marks auth and forbidden non-retryable, rate limits retryable', () => {
		expect(providerErrorForStatus('p', 401, 'x').retryable).toBe(false);
		expect(providerErrorForStatus('p', 403, 'x').retryable).toBe(false);
		expect(providerErrorForStatus('p', 429, 'x').retryable).toBe(true);
	});
});

describe('classifyProviderError', () => {
	it('reads typed errors directly', () => {
		expect(classifyProviderError(new ProviderError('m', { status: 401, code: 'auth' }))).toEqual({
			status: 401,
			code: 'auth',
			retryable: false
		});
	});

	it('derives codes from legacy status-enriched errors', () => {
		expect(classifyProviderError(Object.assign(new Error('x'), { status: 401 })).code).toBe('auth');
		expect(classifyProviderError(Object.assign(new Error('x'), { status: 403 })).code).toBe(
			'forbidden'
		);
		expect(classifyProviderError(Object.assign(new Error('x'), { status: 429 })).code).toBe(
			'rate_limited'
		);
		expect(classifyProviderError(Object.assign(new Error('x'), { status: 500 }))).toEqual({
			status: 500
		});
	});

	it('returns no code for plain errors', () => {
		expect(classifyProviderError(new Error('boom'))).toEqual({});
		expect(classifyProviderError(null)).toEqual({});
	});
});

describe('refreshImpossibleReason', () => {
	it('x: fresh tokens pass, expired without refresh material fail', () => {
		const x = getProvider('x');
		expect(
			x.refreshImpossibleReason?.({
				accessToken: 'a',
				refreshToken: 'r',
				clientId: 'c',
				expiresAt: Date.now() - 1000
			})
		).toBeNull();
		expect(
			x.refreshImpossibleReason?.({
				accessToken: 'a',
				refreshToken: 'r',
				clientId: 'c',
				expiresAt: Date.now() + 60_000
			})
		).toBeNull();
		const reason = x.refreshImpossibleReason?.({
			accessToken: 'dead',
			expiresAt: Date.now() - 1000
		});
		expect(reason).toMatch(/reconnect/);
	});

	it('linkedin: requires the full refresh triple once stale', () => {
		const li = getProvider('linkedin');
		expect(
			li.refreshImpossibleReason?.({
				accessToken: 'a',
				refreshToken: 'r',
				clientId: 'c',
				clientSecret: 's',
				expiresAt: Date.now() - 1000
			})
		).toBeNull();
		expect(
			li.refreshImpossibleReason?.({ accessToken: 'dead', expiresAt: Date.now() - 1000 })
		).toMatch(/reconnect/);
	});

	it('a token without refresh material keeps publishing until it actually expires', () => {
		// Self-serve LinkedIn apps get no refresh token at all: a 60-day token
		// with days left must not be written off early.
		const threeDays = Date.now() + 3 * 24 * 60 * 60_000;
		expect(
			getProvider('linkedin').refreshImpossibleReason?.({ accessToken: 'a', expiresAt: threeDays })
		).toBeNull();
		expect(
			getProvider('x').refreshImpossibleReason?.({
				accessToken: 'a',
				expiresAt: Date.now() + 60_000
			})
		).toBeNull();
		expect(getProvider('linkedin').refreshImpossibleReason?.({ accessToken: 'a' })).toBeNull();
	});

	it('providers without refreshable tokens omit the check', () => {
		expect(getProvider('mastodon').refreshImpossibleReason).toBeUndefined();
		expect(getProvider('bluesky').refreshImpossibleReason).toBeUndefined();
	});
});

describe('publish failure decisions', () => {
	const err500 = 'Bluesky createRecord failed (500): x';
	const err403 = 'X post failed (403): policy';

	it('expires on 401 but never on 403', () => {
		expect(isAuthFailure(new Error('401 Unauthorized'), '401 Unauthorized')).toBe(true);
		const legacy403 = Object.assign(new Error(err403), { status: 403 });
		expect(isAuthFailure(legacy403, err403)).toBe(false);
		const auth = new ProviderError('no token', { code: 'auth' });
		expect(isAuthFailure(auth, 'no token')).toBe(true);
	});

	it('expires on Threads 400-permission shapes, typed or legacy', () => {
		const msg =
			"Threads container failed (400): Unsupported post request. Object with ID '1' does not exist, cannot be loaded due to missing permissions";
		expect(isAuthFailure(new ProviderError(msg, { code: 'auth' }), msg)).toBe(true);
		expect(isAuthFailure(new Error(msg), msg)).toBe(true);
		// Same wording without the Threads marker must not expire other platforms.
		expect(isAuthFailure(new Error('missing permissions'), 'missing permissions')).toBe(false);
		// 403 stays non-expiring even with permission wording.
		const forbidden = Object.assign(new ProviderError(msg, { code: 'forbidden' }), {
			status: 403
		});
		expect(isAuthFailure(forbidden, msg)).toBe(false);
	});

	it('does not auto-retry Threads client failures, but retries 429/5xx', () => {
		const denied = 'Threads container failed (400): {"error":{"message":"missing permissions"}}';
		expect(isFailureRetryable(new Error(denied), denied)).toBe(false);
		const badImage =
			'Threads container failed (400): {"error":{"message":"Invalid parameter","code":100}}';
		expect(isFailureRetryable(new Error(badImage), badImage)).toBe(false);
		const busy = 'Threads publish failed (429): slow';
		expect(isFailureRetryable(new Error(busy), busy)).toBe(true);
		const broken = 'Threads container failed (500): boom';
		expect(isFailureRetryable(new Error(broken), broken)).toBe(true);
	});

	it('gates Threads expiry on the meta marker when present', () => {
		// Code-100 envelope with permission boilerplate: marker gates auth off.
		const invalid =
			"Threads container failed (400): Unsupported post request. Object with ID '1' does not exist, cannot be loaded due to missing permissions [meta 100.33]";
		expect(isAuthFailure(new Error(invalid), invalid)).toBe(false);
		expect(isFailureRetryable(new Error(invalid), invalid)).toBe(false);
		// No marker (legacy rows): permission text still expires.
		const legacy = invalid.replace(' [meta 100.33]', '');
		expect(isAuthFailure(new Error(legacy), legacy)).toBe(true);
		expect(isFailureRetryable(new Error(legacy), legacy)).toBe(false);
		// Marker auth codes expire even without the boilerplate text.
		const coded = 'Threads publish failed (400): x [meta 200]';
		expect(isAuthFailure(new Error(coded), coded)).toBe(true);
		expect(isAuthFailure(new Error('Threads boom (500): x'), 'Threads boom (500): x')).toBe(false);
	});

	it('keeps Meta media-crawl failures retryable, never auth', () => {
		// The one Threads 4xx that must stay retryable: Meta's downloader
		// hiccups (byte-identical media fetched fine seconds later).
		const mediaFetch =
			'Threads container failed (400): {"error":{"code":1,"error_subcode":2207052,"error_user_title":"Media download has failed."}} [meta 1.2207052]';
		expect(isFailureRetryable(new Error(mediaFetch), mediaFetch)).toBe(true);
		expect(isAuthFailure(new Error(mediaFetch), mediaFetch)).toBe(false);
	});

	it('never expires an account for carousel children Meta calls "expired"', () => {
		// 4279004 says the children are "invalid, non-existent or expired" —
		// the bare word matched the legacy auth regex and expired healthy
		// Threads accounts. The marker must win; the failure stays retryable.
		const carousel =
			'Threads container failed (400): {"error":{"message":"Invalid parameter","code":100,"error_subcode":4279004,"error_user_title":"Invalid carousel children","error_user_msg":"The children with IDs 1 are invalid, non-existent or expired."}} [meta 100.4279004]';
		expect(isAuthFailure(new Error(carousel), carousel)).toBe(false);
		expect(isFailureRetryable(new Error(carousel), carousel)).toBe(true);
		const mediaNotFound =
			'Threads publish failed (400): {"error":{"code":24,"error_subcode":4279009}} [meta 24.4279009]';
		expect(isAuthFailure(new Error(mediaNotFound), mediaNotFound)).toBe(false);
		expect(isFailureRetryable(new Error(mediaNotFound), mediaNotFound)).toBe(true);
		// An EXPIRED container status carries the word too, and refers to the
		// media container — never to the credential.
		const expiredContainer = 'Threads media container expired: EXPIRED';
		expect(isAuthFailure(new Error(expiredContainer), expiredContainer)).toBe(false);
	});

	it('keeps legacy retryability for unclassified errors', () => {
		expect(isFailureRetryable(new Error(err500), err500)).toBe(true);
		const typed500 = new ProviderError(err500, { status: 500 });
		expect(isFailureRetryable(typed500, err500)).toBe(true);
		const legacy403 = Object.assign(new Error(err403), { status: 403 });
		expect(isFailureRetryable(legacy403, err403)).toBe(false);
		expect(isFailureRetryable(new Error('429 slow'), '429 slow')).toBe(true);
		const e401 = new Error('401 Unauthorized');
		expect(isFailureRetryable(e401, '401 Unauthorized')).toBe(false);
		// Permanent app-level host policy (SSRF allowlist): no auto-retry.
		expect(isFailureRetryable(new Error('PDS host not allowed'), 'PDS host not allowed')).toBe(
			false
		);
		expect(
			isFailureRetryable(new Error('Instance host not allowed'), 'Instance host not allowed')
		).toBe(false);
	});
});

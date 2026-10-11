import { describe, expect, it } from 'vitest';
import {
	formatThreadsMetaMarker,
	hasThreadsPermissionText,
	isThreadsAuthFailure,
	isThreadsMediaFetchFailure,
	parseThreadsMetaMarker
} from '#lib/domain/threads-error.js';

describe('threads meta marker', () => {
	it('formats and parses codes with and without subcodes', () => {
		expect(formatThreadsMetaMarker(200)).toBe(' [meta 200]');
		expect(formatThreadsMetaMarker(100, 33)).toBe(' [meta 100.33]');
		expect(parseThreadsMetaMarker('Threads container failed (400): x [meta 100.33]')).toEqual({
			code: 100,
			subcode: 33
		});
		expect(parseThreadsMetaMarker('y [meta 200]')).toEqual({ code: 200 });
		expect(parseThreadsMetaMarker('no marker here')).toBeNull();
		expect(parseThreadsMetaMarker('Threads failed (400): plain')).toBeNull();
	});
});

describe('isThreadsAuthFailure', () => {
	const boilerplate =
		"Threads container failed (400): Unsupported post request. Object with ID '1' does not exist, cannot be loaded due to missing permissions";

	it('treats a present marker code as ground truth', () => {
		expect(isThreadsAuthFailure(`${boilerplate} [meta 200]`)).toBe(true);
		expect(isThreadsAuthFailure(`${boilerplate} [meta 190]`)).toBe(true);
		// Code 100 carries the same boilerplate but is NOT auth.
		expect(isThreadsAuthFailure(`${boilerplate} [meta 100.33]`)).toBe(false);
		expect(isThreadsAuthFailure('Threads publish failed (400): x [meta 100]')).toBe(false);
	});

	it('falls back to scoped permission text without a marker', () => {
		expect(isThreadsAuthFailure(boilerplate)).toBe(true);
		expect(isThreadsAuthFailure('Threads publish failed (400): permission denied')).toBe(true);
		expect(
			isThreadsAuthFailure('Threads container failed (400): {"message":"Invalid parameter"}')
		).toBe(false);
		// Same wording outside Threads must not match.
		expect(hasThreadsPermissionText('missing permissions')).toBe(false);
		expect(isThreadsAuthFailure('missing permissions')).toBe(false);
	});
});

describe('isThreadsMediaFetchFailure', () => {
	it('matches Meta media-crawl failures, however they are worded', () => {
		expect(
			isThreadsMediaFetchFailure(
				'Threads container failed (400): {"error":{"code":1,"error_subcode":2207052,"error_user_title":"Media download has failed."}} [meta 1.2207052]'
			)
		).toBe(true);
		expect(
			isThreadsMediaFetchFailure('The media could not be fetched from this URI: https://x/img.png')
		).toBe(true);
	});

	it('ignores unrelated failures', () => {
		expect(isThreadsMediaFetchFailure('Threads container failed (400): Invalid parameter')).toBe(
			false
		);
		expect(isThreadsMediaFetchFailure('Threads images must be JPEG or PNG')).toBe(false);
	});

	it('treats carousel child/publish failures as retryable media problems', () => {
		const carouselChildren =
			'Threads container failed (400): {"error":{"message":"Invalid parameter","code":100,"error_subcode":4279004,"error_user_msg":"The children with IDs 1 are invalid, non-existent or expired."}} [meta 100.4279004]';
		expect(isThreadsMediaFetchFailure(carouselChildren)).toBe(true);
		const mediaNotFound =
			'Threads publish failed (400): {"error":{"message":"Media not found","code":24,"error_subcode":4279009}} [meta 24.4279009]';
		expect(isThreadsMediaFetchFailure(mediaNotFound)).toBe(true);
	});
});

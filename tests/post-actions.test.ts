import { describe, expect, it } from 'vitest';
import {
	cancelTargetIds,
	emptyPostsBody,
	emptyPostsHeading,
	isAuthError,
	needsReconnect,
	rescheduleTargetIds,
	retryTargetIds
} from '#lib/domain/post-actions.js';

const platforms = [
	{ status: 'scheduled', targetId: 's1' },
	{ status: 'failed', targetId: 'f1' },
	{ status: 'published', targetId: 'p1' },
	{ status: 'pending', targetId: 's2' },
	{ status: 'failed' },
	{ status: 'publishing', targetId: 's3' }
];

describe('post-actions', () => {
	it('picks failed ids for retry', () => {
		expect(retryTargetIds(platforms)).toEqual(['f1']);
	});

	it('picks scheduled/pending/publishing ids for reschedule', () => {
		expect(rescheduleTargetIds(platforms)).toEqual(['s1', 's2', 's3']);
	});

	it('cancels every target with an id', () => {
		expect(cancelTargetIds(platforms)).toEqual(['s1', 'f1', 'p1', 's2', 's3']);
	});

	it('detects auth errors needing reconnect instead of retry', () => {
		expect(isAuthError('401 Unauthorized')).toBe(true);
		expect(isAuthError('Account needs reconnect')).toBe(true);
		expect(isAuthError('Rate limited — try again in a minute')).toBe(false);
		expect(isAuthError(null)).toBe(false);
		expect(needsReconnect({ status: 'failed', error: '401 Unauthorized' })).toBe(true);
		expect(
			needsReconnect({ status: 'failed', error: 'timeout', connectionStatus: 'expired' })
		).toBe(true);
		expect(needsReconnect({ status: 'failed', error: 'timeout', connectionStatus: 'active' })).toBe(
			false
		);
	});

	it('suggests reconnect for Threads permission-shaped 400s only', () => {
		expect(
			needsReconnect({
				status: 'failed',
				error:
					"Threads container failed (400): Unsupported post request. Object with ID '1' does not exist, cannot be loaded due to missing permissions"
			})
		).toBe(true);
		expect(
			needsReconnect({
				status: 'failed',
				error: 'Threads container failed (400): {"error":{"message":"Invalid parameter"}}'
			})
		).toBe(false);
		expect(needsReconnect({ status: 'failed', error: 'missing permissions' })).toBe(false);
		expect(
			needsReconnect({
				status: 'failed',
				error: 'Threads container failed (400): Unsupported post request [meta 100.33]'
			})
		).toBe(false);
	});

	it('formats empty headings and body copy', () => {
		expect(emptyPostsHeading('all')).toBe('No posts');
		expect(emptyPostsHeading('scheduled')).toBe('No scheduled posts');
		expect(emptyPostsHeading('published')).toBe('No published posts');
		expect(emptyPostsHeading('failed')).toBe('No failed posts');
		expect(emptyPostsHeading('drafts')).toBe('No drafts');
		expect(emptyPostsBody('scheduled')).toMatch(/scheduled posts/);
		expect(emptyPostsBody('failed')).toMatch(/Nothing failed/);
		expect(emptyPostsBody('all')).not.toMatch(/all posts/);
	});
});

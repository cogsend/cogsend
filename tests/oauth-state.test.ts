import { describe, expect, it } from 'vitest';
import { bindOAuthState, splitOAuthState, verifyOAuthState } from '#lib/server/oauth-state.js';

const SECRET = 'test-oauth-binding-secret';

describe('oauth state binding', () => {
	it('round-trips for the same session', async () => {
		const state = await bindOAuthState({
			secret: SECRET,
			pendingId: 'abc123',
			sessionId: 'sess-1'
		});
		expect(state.startsWith('abc123.')).toBe(true);
		await expect(verifyOAuthState({ secret: SECRET, state, sessionId: 'sess-1' })).resolves.toBe(
			'abc123'
		);
	});

	it('rejects a different session', async () => {
		const state = await bindOAuthState({
			secret: SECRET,
			pendingId: 'abc123',
			sessionId: 'sess-1'
		});
		await expect(
			verifyOAuthState({ secret: SECRET, state, sessionId: 'sess-2' })
		).resolves.toBeNull();
	});

	it('rejects tampered signatures and ids', async () => {
		const state = await bindOAuthState({
			secret: SECRET,
			pendingId: 'abc123',
			sessionId: 'sess-1'
		});
		await expect(
			verifyOAuthState({ secret: SECRET, state: state.slice(0, -1) + '0', sessionId: 'sess-1' })
		).resolves.toBeNull();
		await expect(
			verifyOAuthState({
				secret: SECRET,
				state: `other.${state.split('.')[1]}`,
				sessionId: 'sess-1'
			})
		).resolves.toBeNull();
	});

	it('rejects malformed or missing values', async () => {
		await expect(
			verifyOAuthState({ secret: SECRET, state: 'nosig', sessionId: 's' })
		).resolves.toBeNull();
		await expect(
			verifyOAuthState({ secret: SECRET, state: null, sessionId: 's' })
		).resolves.toBeNull();
		await expect(
			verifyOAuthState({ secret: SECRET, state: 'a.b', sessionId: null })
		).resolves.toBeNull();
		await expect(
			verifyOAuthState({ secret: SECRET, state: 'a.b', sessionId: undefined })
		).resolves.toBeNull();
	});

	it('machine bindings verify with the same machine id only', async () => {
		const state = await bindOAuthState({
			secret: SECRET,
			pendingId: 'abc123',
			sessionId: 'machine:user-9'
		});
		await expect(
			verifyOAuthState({ secret: SECRET, state, sessionId: 'machine:user-9' })
		).resolves.toBe('abc123');
		await expect(
			verifyOAuthState({ secret: SECRET, state, sessionId: 'machine:user-10' })
		).resolves.toBeNull();
	});

	it('splitOAuthState extracts the candidate id without verifying', () => {
		expect(splitOAuthState('abc123.deadbeef')).toBe('abc123');
		expect(splitOAuthState('nosig')).toBeNull();
		expect(splitOAuthState(null)).toBeNull();
	});
});

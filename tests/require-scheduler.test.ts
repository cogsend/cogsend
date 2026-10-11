import { describe, expect, it } from 'vitest';
import { assertScheduler } from '#lib/server/require.js';

const env = {
	AUTH_SECRET: 'auth-secret-value',
	SCHEDULER_SECRET: 'sched-secret-value-0123456789abcdef',
	API_TOKEN: 'api-token-value-16'
};

function req(header: string, value: string) {
	return new Request('https://cogsend.internal/api/internal/tick', {
		headers: { [header]: value }
	});
}

describe('assertScheduler', () => {
	it('accepts SCHEDULER_SECRET or API_TOKEN, never AUTH_SECRET', () => {
		// AUTH_SECRET signs sessions/challenges and must never travel as a
		// bearer credential (least privilege).
		expect(() =>
			assertScheduler(req('authorization', 'Bearer sched-secret-value-0123456789abcdef'), env)
		).not.toThrow();
		expect(() =>
			assertScheduler(req('authorization', 'Bearer api-token-value-16'), env)
		).not.toThrow();
		expect(() =>
			assertScheduler(req('x-cogsend-scheduler', 'sched-secret-value-0123456789abcdef'), env)
		).not.toThrow();
		expect(() => assertScheduler(req('authorization', 'Bearer auth-secret-value'), env)).toThrow(
			/Unauthorized/
		);
	});

	it('rejects a missing or wrong token', () => {
		expect(() =>
			assertScheduler(new Request('https://cogsend.internal/api/internal/tick'), env)
		).toThrow(/Unauthorized/);
		expect(() => assertScheduler(req('authorization', 'Bearer nope'), env)).toThrow(/Unauthorized/);
	});
});

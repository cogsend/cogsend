import { describe, expect, it } from 'vitest';
import { handleError } from '#lib/server/http.js';
import { ApiOperationError } from '#lib/server/api/operation-error.js';
import { captureConsole, loggedLines } from './console-spy';

describe('handleError', () => {
	it('keeps the 401 message from the thrown error', async () => {
		const res = handleError(
			Object.assign(new Error('Setup expired — sign in again'), { status: 401 })
		);
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: 'Setup expired — sign in again' });
	});

	it('returns 400 body without rewriting as reconnect', async () => {
		const res = handleError(Object.assign(new Error('Invalid code'), { status: 400 }));
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'Invalid code' });
	});

	it('returns details from typed operation errors but not arbitrary errors', async () => {
		const safe = handleError(
			new ApiOperationError('Already publishing', 409, { inFlight: ['target-1'] })
		);
		expect(safe.status).toBe(409);
		expect(await safe.json()).toEqual({ error: 'Already publishing', inFlight: ['target-1'] });

		const untyped = handleError(
			Object.assign(new Error('Conflict'), { status: 409, details: { secret: 'must not leak' } })
		);
		expect(await untyped.json()).toEqual({ error: 'Conflict' });
	});

	it('keeps the fixed copy for a failure it recognises', async () => {
		// A provider timeout is a 5xx, but "check your connection" is the useful
		// thing to say — only unrecognised text (SQL, response bodies) is hidden.
		const logged = captureConsole();
		const res = handleError(
			Object.assign(new Error('Provider request timed out'), { status: 504 })
		);
		// The cause is logged for the operator and kept out of the response.
		expect(loggedLines(logged).join('\n')).toContain('Provider request timed out');
		expect(res.status).toBe(504);
		expect((await res.json()) as { error: string }).toEqual({
			error: 'Could not reach the network — check connection and try again'
		});
	});

	it('never echoes a 5xx cause to the client', async () => {
		const logged = captureConsole();
		const res = handleError(new Error('D1_ERROR: no such table: publish_targets at offset 42'));
		expect(loggedLines(logged).join('\n')).toContain('D1_ERROR: no such table: publish_targets');
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string };
		expect(body.error).not.toMatch(/D1_ERROR|publish_targets/);
		expect(body.error).toBe('Something went wrong on the server');
	});
});

import { json } from '@sveltejs/kit';
import { humanizedCause } from '#lib/domain/human-error.js';
import { ApiOperationError } from '#lib/server/api/operation-error.js';

export function ok(data: unknown, status = 200) {
	return json(data, { status });
}

export function fail(message: string, status = 400, extra?: Record<string, unknown>) {
	return json({ error: message, ...extra }, { status });
}

export function handleError(err: unknown) {
	const status = (err as { status?: number })?.status ?? 500;
	const message = err instanceof Error ? err.message : 'Server error';
	if (status === 401)
		return fail(message && message !== 'Server error' ? message : 'Unauthorized', 401);
	if (status < 500) {
		const details = err instanceof ApiOperationError ? err.details : undefined;
		return fail(message, status >= 400 && status < 600 ? status : 400, details);
	}
	console.error(err);
	// 5xx messages are ours to log, not to publish: a driver error carries SQL
	// and table detail, and an upstream one carries response bodies. The raw
	// text is in the log above. Failures we recognise still get their fixed
	// copy — "check your connection" is worth saying when a provider timed out.
	return fail(
		humanizedCause(message) ?? 'Something went wrong on the server',
		status >= 400 && status < 600 ? status : 500
	);
}

export function unauthorized(): never {
	throw Object.assign(new Error('Unauthorized'), { status: 401 });
}

import { describe, expect, it } from 'vitest';
import { findExistingConnection } from '#lib/server/oauth-callback.js';

describe('findExistingConnection', () => {
	const rows = [
		{ id: 'a', handle: '@old_name', metaJson: JSON.stringify({ xUserId: '42' }) },
		{ id: 'b', handle: '@someone', metaJson: JSON.stringify({ xUserId: '7' }) },
		{ id: 'legacy', handle: '@legacy', metaJson: '{}' }
	];

	it('finds the account by its platform id after a handle change', () => {
		expect(findExistingConnection(rows, '@new_name', '42', 'xUserId')?.id).toBe('a');
	});

	it('falls back to the handle for rows stored without the id', () => {
		expect(findExistingConnection(rows, '@legacy', '99', 'xUserId')?.id).toBe('legacy');
	});

	it('prefers the id over a handle another row now holds', () => {
		// @someone renamed away and our account 42 took the name: 42 is still `a`.
		expect(findExistingConnection(rows, '@someone', '42', 'xUserId')?.id).toBe('a');
	});

	it('matches on handle alone when the flow has no id key, as before', () => {
		expect(findExistingConnection(rows, '@someone', undefined, undefined)?.id).toBe('b');
		expect(findExistingConnection(rows, '@nobody', undefined, undefined)).toBeUndefined();
	});

	it('tolerates unreadable meta', () => {
		const broken = [{ id: 'x', handle: '@h', metaJson: 'not json' }];
		expect(findExistingConnection(broken, '@h', '42', 'xUserId')?.id).toBe('x');
	});
});

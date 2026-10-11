import { describe, expect, it } from 'vitest';
import { hasApiScope, normalizeApiScopes, parseApiScopes } from '#lib/domain/api-scopes.js';
import { requireScope } from '#lib/server/require.js';

describe('parseApiScopes', () => {
	it('grants full access to legacy keys', () => {
		expect(parseApiScopes(null)).toEqual(['read', 'write']);
		expect(parseApiScopes(undefined)).toEqual(['read', 'write']);
	});
	it('fails closed on malformed rows', () => {
		// The app never writes these; only corruption can produce them, so a
		// damaged row must not become a full-access key.
		expect(parseApiScopes('garbage')).toEqual([]);
		expect(parseApiScopes('[]')).toEqual([]);
		expect(parseApiScopes('{}')).toEqual([]);
		expect(parseApiScopes('')).toEqual([]);
		expect(parseApiScopes('["admin"]')).toEqual([]);
	});
	it('keeps known scopes', () => {
		expect(parseApiScopes('["read"]')).toEqual(['read']);
		expect(parseApiScopes('["read","write"]')).toEqual(['read', 'write']);
		expect(parseApiScopes('["read","admin"]')).toEqual(['read']);
	});
});

describe('hasApiScope', () => {
	it('lets write imply read', () => {
		expect(hasApiScope(['write'], 'read')).toBe(true);
		expect(hasApiScope(['write'], 'write')).toBe(true);
		expect(hasApiScope(['read'], 'write')).toBe(false);
	});
	it('passes when no scopes are attached (session / operator key)', () => {
		expect(hasApiScope(null, 'write')).toBe(true);
		expect(hasApiScope(undefined, 'read')).toBe(true);
	});
});

describe('normalizeApiScopes', () => {
	it('drops unknown entries and dedupes', () => {
		expect(normalizeApiScopes(['read', 'read', 'root'])).toEqual(['read']);
		expect(normalizeApiScopes([])).toEqual(['read', 'write']);
		expect(normalizeApiScopes(undefined)).toEqual(['read', 'write']);
	});
});

describe('requireScope', () => {
	it('passes sessions and operator keys through', () => {
		expect(() => requireScope({ apiKeyScopes: null }, 'write')).not.toThrow();
		expect(() => requireScope({}, 'write')).not.toThrow();
	});
	it('blocks a read-only key from mutating', () => {
		expect(() => requireScope({ apiKeyScopes: ['read'] }, 'read')).not.toThrow();
		expect(() => requireScope({ apiKeyScopes: ['read'] }, 'write')).toThrow(/scope/i);
	});
});

describe('route enforcement', () => {
	it('lets a read-only key list but not create drafts', async () => {
		const { createTestDb } = await import('#lib/server/db/test.js');
		const { users } = await import('#lib/server/db/schema.js');
		const { newId } = await import('#lib/server/db/client.js');
		const { GET, POST } = await import('../src/routes/api/drafts/+server');
		const { db, close } = await createTestDb();
		try {
			const now = new Date();
			const userId = newId();
			await db.insert(users).values({
				id: userId,
				email: 'scopes@localhost',
				passwordHash: 'x',
				timezone: 'UTC',
				createdAt: now,
				updatedAt: now
			});
			const user = {
				id: userId,
				email: 'scopes@localhost',
				timezone: 'UTC',
				totpEnabled: true,
				mfaVerified: true
			};
			const listed = (await GET({
				locals: { db, user, apiKeyScopes: ['read'] }
			} as never)) as Response;
			expect(listed.status).toBe(200);
			const denied = (await POST({
				request: new Request('http://localhost/api/drafts', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ baseBody: 'nope' })
				}),
				locals: { db, user, apiKeyScopes: ['read'] }
			} as never)) as Response;
			expect(denied.status).toBe(403);
			const allowed = (await POST({
				request: new Request('http://localhost/api/drafts', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ baseBody: 'yes' })
				}),
				locals: { db, user, apiKeyScopes: ['read', 'write'] }
			} as never)) as Response;
			expect(allowed.status).toBe(201);
		} finally {
			close();
		}
	});
});

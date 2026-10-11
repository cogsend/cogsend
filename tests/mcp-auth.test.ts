import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '#lib/server/db/client.js';
import { createTestDb } from '#lib/server/db/test.js';
import { rotateApiKey } from '#lib/server/api-keys.js';
import { users } from '#lib/server/db/schema.js';
import { authorizeMcpRequest } from '#lib/server/mcp-auth.js';

const verifiedUser = (id: string) => ({
	id,
	email: 'mcp@localhost',
	timezone: 'UTC',
	totpEnabled: true,
	mfaVerified: true
});

describe('MCP authentication', () => {
	let db: Awaited<ReturnType<typeof createTestDb>>['db'];
	let close: () => void;
	let userId: string;
	let rawKey: string;
	beforeAll(async () => {
		({ db, close } = await createTestDb());
		userId = newId();
		const now = new Date();
		await db.insert(users).values({
			id: userId,
			email: 'mcp@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
		rawKey = (await rotateApiKey(db, userId)).raw;
	});
	afterAll(() => close());

	const call = (headers: HeadersInit = {}, stateOverrides: Record<string, unknown> = {}) => {
		const request = new Request('https://cogsend.example/api/mcp', { method: 'POST', headers });
		return authorizeMcpRequest(request, new URL(request.url), db, {
			authMethod: 'bearer',
			authCredential: 'personal_api_key',
			user: verifiedUser(userId),
			...stateOverrides
		} as never);
	};

	it('accepts only an active cog key from the standard Authorization bearer header', async () => {
		expect(await call({ Authorization: `Bearer ${rawKey}` })).toEqual({ ok: true });
		expect(await call()).toEqual({ ok: false, status: 401 });
		expect(await call({ Authorization: 'Bearer invalid' })).toEqual({ ok: false, status: 401 });
		expect(await call({ 'X-API-Key': rawKey })).toEqual({ ok: false, status: 401 });
		expect(await call({ Authorization: 'Bearer scheduler-secret' })).toEqual({
			ok: false,
			status: 401
		});
		expect(await call({ 'X-API-Key': rawKey }, { authCredential: 'api_token' })).toEqual({
			ok: false,
			status: 401
		});
		expect(await call({ Authorization: `Bearer ${rawKey}` }, { authMethod: 'session' })).toEqual({
			ok: false,
			status: 401
		});
		expect(
			await call({ Authorization: `Bearer ${rawKey}` }, { authCredential: 'api_token' })
		).toEqual({
			ok: false,
			status: 401
		});
		expect(await call({ 'X-API-Key': rawKey, Authorization: 'Bearer invalid' })).toEqual({
			ok: false,
			status: 401
		});
	});

	it('rejects revoked keys and ignores query credentials', async () => {
		const oldKey = rawKey;
		rawKey = (await rotateApiKey(db, userId)).raw;
		expect(await call({ Authorization: `Bearer ${oldKey}` })).toEqual({ ok: false, status: 401 });
		const request = new Request(`https://cogsend.example/api/mcp?token=${rawKey}`, {
			method: 'POST'
		});
		expect(
			await authorizeMcpRequest(request, new URL(request.url), db, {
				authMethod: 'bearer',
				authCredential: 'personal_api_key',
				user: verifiedUser(userId)
			})
		).toEqual({ ok: false, status: 401 });
	});

	it('allows missing origins and validates every present Origin and Referer', async () => {
		const authorization = `Bearer ${rawKey}`;
		expect(await call({ Authorization: authorization })).toEqual({ ok: true });
		expect(await call({ Authorization: authorization, Origin: 'https://cogsend.example' })).toEqual(
			{
				ok: true
			}
		);
		expect(
			await call({
				Authorization: authorization,
				Origin: 'https://cogsend.example',
				Referer: 'https://other.example/page'
			})
		).toEqual({ ok: false, status: 403 });
		expect(await call({ Authorization: authorization, Origin: 'not an origin' })).toEqual({
			ok: false,
			status: 403
		});
	});
});

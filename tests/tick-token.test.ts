import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashApiKey } from '#lib/server/api-keys.js';
import type { AppDb } from '#lib/server/db/client.js';
import { createTestDb } from '#lib/server/db/test.js';
import {
	TICK_TOKEN_PREFIX,
	hashTickToken,
	isTickTokenFormat,
	readTickToken,
	revokeTickToken,
	rotateTickToken,
	verifyTickToken
} from '#lib/server/tick-token.js';

describe('tick token', () => {
	let db: AppDb;
	let close: () => void;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
	});
	afterAll(() => close());

	it('is absent until one is generated', async () => {
		expect(await readTickToken(db)).toEqual({ configured: false, prefix: null, createdAt: null });
		expect(await verifyTickToken(db, 'tick_deadbeef')).toBe(false);
	});

	it('generates a token, stores only its hash, and verifies it', async () => {
		const { token, prefix, createdAt } = await rotateTickToken(db);
		expect(isTickTokenFormat(token)).toBe(true);
		expect(token.startsWith(TICK_TOKEN_PREFIX)).toBe(true);
		expect(prefix.length).toBeLessThan(token.length);
		expect(token.startsWith(prefix)).toBe(true);
		expect(createdAt).toBeInstanceOf(Date);

		const status = await readTickToken(db);
		expect(status.configured).toBe(true);
		expect(status.prefix).toBe(prefix);
		expect(status.createdAt?.getTime()).toBe(createdAt.getTime());

		expect(await verifyTickToken(db, token)).toBe(true);
		// The raw value is not in the database, so a leak of the row is inert.
		const rows = await db.select().from((await import('#lib/server/db/schema.js')).appSettings);
		expect(rows.map((row) => row.value).join('|')).not.toContain(token);
	});

	it('rejects wrong, malformed and truncated values', async () => {
		const { token } = await rotateTickToken(db);
		// Rotating keeps exactly one live token: the older one stops working.
		const { token: current } = await rotateTickToken(db);
		expect(await verifyTickToken(db, current)).toBe(true);
		expect(await verifyTickToken(db, token)).toBe(false);
		expect(await verifyTickToken(db, null)).toBe(false);
		expect(await verifyTickToken(db, '')).toBe(false);
		expect(await verifyTickToken(db, 'cog_' + 'a'.repeat(64))).toBe(false);
		expect(await verifyTickToken(db, `tick_${'a'.repeat(63)}`)).toBe(false);
		expect(await verifyTickToken(db, current.slice(0, -1))).toBe(false);
	});

	it('keeps its hash domain separate from API keys', async () => {
		const raw = `tick_${'b'.repeat(64)}`;
		expect(await hashTickToken(raw)).not.toBe(await hashApiKey(raw));
		expect(await hashTickToken(raw)).toHaveLength(64);
	});

	it('rotates: exactly one token works at a time', async () => {
		const first = await rotateTickToken(db);
		const second = await rotateTickToken(db);
		expect(await verifyTickToken(db, first.token)).toBe(false);
		expect(await verifyTickToken(db, second.token)).toBe(true);
		expect((await readTickToken(db)).prefix).toBe(second.prefix);
	});

	it('revokes, and reports whether there was anything to revoke', async () => {
		await rotateTickToken(db);
		expect(await revokeTickToken(db)).toBe(true);
		expect((await readTickToken(db)).configured).toBe(false);
		expect(await revokeTickToken(db)).toBe(false);
	});
});

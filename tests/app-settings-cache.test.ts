import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AppDb } from '#lib/server/db/client.js';
import { createTestDb } from '#lib/server/db/test.js';
import {
	APP_SETTING_CACHE_MS,
	readStoredAppName,
	rememberAppName
} from '#lib/server/app-settings.js';
import { appSettings } from '#lib/server/db/schema.js';
import { revokeTickToken, rotateTickToken, verifyTickToken } from '#lib/server/tick-token.js';

/**
 * A Worker runs many isolates and each keeps its own copy of these values. A
 * write through another isolate is simulated here by changing the row directly,
 * which is all this isolate would ever see of it.
 */
describe('app settings across isolates', () => {
	let db: AppDb;
	let close: () => void;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
	});
	afterAll(() => close());
	afterEach(() => vi.restoreAllMocks());

	it('picks up a rename made elsewhere once the cached copy expires', async () => {
		await rememberAppName(db, 'Old name');
		await db.update(appSettings).set({ value: 'New name' }).where(eq(appSettings.key, 'app_name'));
		expect(await readStoredAppName(db)).toBe('Old name');
		const now = Date.now();
		vi.spyOn(Date, 'now').mockReturnValue(now + APP_SETTING_CACHE_MS + 1);
		expect(await readStoredAppName(db)).toBe('New name');
	});

	it('still writes a value this isolate last saw, once its copy is stale', async () => {
		await rememberAppName(db, 'Mine');
		await db.update(appSettings).set({ value: 'Theirs' }).where(eq(appSettings.key, 'app_name'));
		const now = Date.now();
		vi.spyOn(Date, 'now').mockReturnValue(now + APP_SETTING_CACHE_MS + 1);
		await rememberAppName(db, 'Mine');
		const [row] = await db.select().from(appSettings).where(eq(appSettings.key, 'app_name'));
		expect(row.value).toBe('Mine');
	});

	it('stops accepting a revoked tick token immediately, whoever revoked it', async () => {
		const { token } = await rotateTickToken(db);
		expect(await verifyTickToken(db, token)).toBe(true);
		// Revoked through another isolate: only the row changes.
		await db.update(appSettings).set({ value: '' }).where(eq(appSettings.key, 'tick_token_hash'));
		expect(await verifyTickToken(db, token)).toBe(false);
	});

	it('accepts a token rotated elsewhere without waiting for the cache', async () => {
		const first = await rotateTickToken(db);
		expect(await verifyTickToken(db, first.token)).toBe(true);
		const second = await rotateTickToken(db);
		expect(await verifyTickToken(db, first.token)).toBe(false);
		expect(await verifyTickToken(db, second.token)).toBe(true);
		expect(await revokeTickToken(db)).toBe(true);
		expect(await verifyTickToken(db, second.token)).toBe(false);
	});
});

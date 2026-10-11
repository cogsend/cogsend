import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppDb } from '#lib/server/db/client.js';
import { createTestDb } from '#lib/server/db/test.js';
import {
	readStoredAppUrl,
	rememberAppUrl,
	readStoredAppName,
	rememberAppName,
	APP_URL_SETTING
} from '#lib/server/app-settings.js';
import { appSettings } from '#lib/server/db/schema.js';

/**
 * The remembered origin is what a scheduled invocation has instead of a
 * request: the cron tick builds absolute links (media URLs, the failure
 * digest) from it, and nothing else can tell it where the deployment lives.
 */
describe('remembered app URL', () => {
	let db: AppDb;
	let close: () => void;
	let count: () => number;
	let reset: () => void;

	beforeAll(async () => {
		({ db, close, count, reset } = await createTestDb());
	});
	afterAll(() => close());

	it('is empty until a visit records it', async () => {
		expect(await readStoredAppUrl(db)).toBeNull();
	});

	it('records an origin, and reads it back from the cache', async () => {
		await rememberAppUrl(db, 'https://cogsend.acct.workers.dev');
		reset();
		expect(await readStoredAppUrl(db)).toBe('https://cogsend.acct.workers.dev');
		expect(count()).toBe(0);
	});

	it('updates the stored value when the instance moves', async () => {
		await rememberAppUrl(db, 'https://cogsend.example.com');
		reset();
		expect(await readStoredAppUrl(db)).toBe('https://cogsend.example.com');
		const rows = await db.select().from(appSettings);
		expect(rows.filter((row) => row.key === APP_URL_SETTING)).toHaveLength(1);
		expect(rows[0]?.value).toBe('https://cogsend.example.com');
	});

	it('ignores an empty origin', async () => {
		await rememberAppUrl(db, '');
		expect(await readStoredAppUrl(db)).toBe('https://cogsend.example.com');
	});
});

describe('remembered instance name', () => {
	let db: AppDb;
	let close: () => void;
	let count: () => number;
	let reset: () => void;

	beforeAll(async () => {
		({ db, close, count, reset } = await createTestDb());
	});
	afterAll(() => close());

	it('is empty until the settings form sets it', async () => {
		expect(await readStoredAppName(db)).toBeNull();
	});

	it('stores a name and serves later reads from the cache', async () => {
		await rememberAppName(db, 'My Scheduler');
		reset();
		expect(await readStoredAppName(db)).toBe('My Scheduler');
		expect(count()).toBe(0);
	});

	it('trims, and treats a blank name as "use the default"', async () => {
		await rememberAppName(db, '  Spaced  ');
		expect(await readStoredAppName(db)).toBe('Spaced');
		await rememberAppName(db, '');
		expect(await readStoredAppName(db)).toBeNull();
	});
});

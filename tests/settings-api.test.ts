import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { users } from '$lib/server/db/schema';
import { newId, type AppDb } from '$lib/server/db/client';
import { createTestDb, TEST_ENV } from '$lib/server/db/test';
import { GET as settingsGET, PATCH as settingsPATCH } from '../src/routes/api/settings/+server';

describe('settings api', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;
	const localsFor = (id: string) => ({
		db,
		env: TEST_ENV,
		user: { id, email: 'settings@localhost', timezone: 'UTC', totpEnabled: true, mfaVerified: true }
	});

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'settings@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
	});
	afterAll(() => close());

	it('returns defaults then persists valid patches', async () => {
		const first = (await settingsGET({ locals: localsFor(userId) } as never)) as Response;
		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({
			settings: { mastoVisibility: 'public', defaultAccountIds: [], profilePictureUrl: '' },
			displayName: null,
			instanceName: TEST_ENV.APP_NAME,
			offerPrereleases: false
		});

		const bad = (await settingsPATCH({
			locals: localsFor(userId),
			request: new Request('http://localhost/api/settings', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ mastoVisibility: 'everywhere' })
			})
		} as never)) as Response;
		expect(bad.status).toBe(400);

		const patched = (await settingsPATCH({
			locals: localsFor(userId),
			request: new Request('http://localhost/api/settings', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ mastoVisibility: 'private', defaultAccountIds: ['c1'] })
			})
		} as never)) as Response;
		expect(patched.status).toBe(200);
		expect(await patched.json()).toEqual({
			settings: { mastoVisibility: 'private', defaultAccountIds: ['c1'], profilePictureUrl: '' },
			displayName: null,
			instanceName: TEST_ENV.APP_NAME,
			offerPrereleases: false
		});

		const again = (await settingsGET({ locals: localsFor(userId) } as never)) as Response;
		expect(await again.json()).toEqual({
			settings: { mastoVisibility: 'private', defaultAccountIds: ['c1'], profilePictureUrl: '' },
			displayName: null,
			instanceName: TEST_ENV.APP_NAME,
			offerPrereleases: false
		});

		const named = (await settingsPATCH({
			locals: localsFor(userId),
			request: new Request('http://localhost/api/settings', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mastoVisibility: 'private',
					defaultAccountIds: ['c1'],
					displayName: 'Bikash'
				})
			})
		} as never)) as Response;
		expect(named.status).toBe(200);
		expect(await named.json()).toEqual({
			settings: { mastoVisibility: 'private', defaultAccountIds: ['c1'], profilePictureUrl: '' },
			displayName: 'Bikash',
			instanceName: TEST_ENV.APP_NAME,
			offerPrereleases: false
		});

		const badName = (await settingsPATCH({
			locals: localsFor(userId),
			request: new Request('http://localhost/api/settings', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mastoVisibility: 'private',
					defaultAccountIds: ['c1'],
					displayName: 'x'.repeat(81)
				})
			})
		} as never)) as Response;
		expect(badName.status).toBe(400);
	});

	it('validates profile picture URLs and preserves them on partial patches', async () => {
		const bad = (await settingsPATCH({
			locals: localsFor(userId),
			request: new Request('http://localhost/api/settings', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ profilePictureUrl: 'javascript:alert(1)' })
			})
		} as never)) as Response;
		expect(bad.status).toBe(400);

		const okPic = (await settingsPATCH({
			locals: localsFor(userId),
			request: new Request('http://localhost/api/settings', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ profilePictureUrl: 'https://example.com/me.png' })
			})
		} as never)) as Response;
		expect(okPic.status).toBe(200);
		expect((await okPic.json()).settings.profilePictureUrl).toBe('https://example.com/me.png');

		const partial = (await settingsPATCH({
			locals: localsFor(userId),
			request: new Request('http://localhost/api/settings', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ mastoVisibility: 'unlisted' })
			})
		} as never)) as Response;
		expect(partial.status).toBe(200);
		const body = await partial.json();
		expect(body.settings.mastoVisibility).toBe('unlisted');
		expect(body.settings.profilePictureUrl).toBe('https://example.com/me.png');
	});

	// Each settings card saves only its own fields. A name-only patch must leave
	// the picture and the new-post defaults alone, and a picture-only patch must
	// leave the name alone — otherwise saving one card commits the other's drafts.
	it('keeps one card from committing another card fields', async () => {
		const patch = (body: Record<string, unknown>) =>
			settingsPATCH({
				locals: localsFor(userId),
				request: new Request('http://localhost/api/settings', {
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body)
				})
			} as never) as Promise<Response>;

		const setup = await patch({
			displayName: 'Sudhir',
			profilePictureUrl: 'https://example.com/sudhir.png',
			mastoVisibility: 'direct',
			defaultAccountIds: ['c9']
		});
		expect(setup.status).toBe(200);

		// Profile details card: name only.
		const renamed = await patch({ displayName: 'Sudhir R' });
		expect(renamed.status).toBe(200);
		const renamedBody = await renamed.json();
		expect(renamedBody.displayName).toBe('Sudhir R');
		expect(renamedBody.settings).toEqual({
			mastoVisibility: 'direct',
			defaultAccountIds: ['c9'],
			profilePictureUrl: 'https://example.com/sudhir.png'
		});

		// Picture dialog: URL only, and clearing it keeps the name.
		const cleared = await patch({ profilePictureUrl: '' });
		expect(cleared.status).toBe(200);
		const clearedBody = await cleared.json();
		expect(clearedBody.displayName).toBe('Sudhir R');
		expect(clearedBody.settings.profilePictureUrl).toBe('');
		expect(clearedBody.settings.mastoVisibility).toBe('direct');
	});

	it('stores and clears the instance name', async () => {
		const patch = (body: Record<string, unknown>) =>
			settingsPATCH({
				locals: localsFor(userId),
				request: new Request('http://localhost/api/settings', {
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body)
				})
			} as never) as Promise<Response>;
		const named = await patch({ instanceName: '  My Sent  ' });
		expect(named.status).toBe(200);
		expect((await named.json()).instanceName).toBe('My Sent');
		const read = (await settingsGET({ locals: localsFor(userId) } as never)) as Response;
		expect((await read.json()).instanceName).toBe('My Sent');
		const tooLong = await patch({ instanceName: 'x'.repeat(61) });
		expect(tooLong.status).toBe(400);
		// Blank clears the override and the APP_NAME default comes back.
		const cleared = await patch({ instanceName: '' });
		expect((await cleared.json()).instanceName).toBe(TEST_ENV.APP_NAME);
	});

	it('turns offering pre-releases on and off, for the instance', async () => {
		const patch = (body: Record<string, unknown>) =>
			settingsPATCH({
				locals: localsFor(userId),
				request: new Request('http://localhost/api/settings', {
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body)
				})
			} as never) as Promise<Response>;
		expect((await (await patch({ offerPrereleases: true })).json()).offerPrereleases).toBe(true);
		const read = (await settingsGET({ locals: localsFor(userId) } as never)) as Response;
		expect((await read.json()).offerPrereleases).toBe(true);
		expect((await patch({ offerPrereleases: 'yes' })).status).toBe(400);
		expect((await (await patch({ offerPrereleases: false })).json()).offerPrereleases).toBe(false);
	});
});

describe('settings api: time zone', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;
	const locals = () => ({
		db,
		env: TEST_ENV,
		user: {
			id: userId,
			email: 'tz@localhost',
			timezone: 'UTC',
			totpEnabled: true,
			mfaVerified: true
		}
	});
	const patch = (body: unknown) =>
		settingsPATCH({
			locals: locals(),
			request: new Request('http://localhost/api/settings', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			})
		} as never) as Promise<Response>;
	const stored = async () => {
		const [row] = await db.select().from(users).where(eq(users.id, userId));
		return row;
	};

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'tz@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
	});
	afterAll(() => close());

	it('records the browser’s zone and leaves the settings column alone', async () => {
		const res = await patch({ timezone: 'Asia/Kolkata' });
		expect(res.status).toBe(200);
		const row = await stored();
		expect(row.timezone).toBe('Asia/Kolkata');
		// Never saved before, still never saved: the zone is not a setting.
		expect(row.settingsJson).toBeNull();
	});

	it('refuses a zone the runtime does not know', async () => {
		const res = await patch({ timezone: 'Not/AZone' });
		expect(res.status).toBe(400);
		expect((await stored()).timezone).toBe('Asia/Kolkata');
	});

	it('still writes settings when the request carries one', async () => {
		const res = await patch({ mastoVisibility: 'unlisted', timezone: 'Europe/Berlin' });
		expect(res.status).toBe(200);
		const row = await stored();
		expect(row.timezone).toBe('Europe/Berlin');
		expect(JSON.parse(row.settingsJson ?? '{}').mastoVisibility).toBe('unlisted');
	});
});

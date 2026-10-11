import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { createTestDb, createTestMedia, TEST_ENV } from '#lib/server/db/test.js';
import { draftMedia, drafts, users } from '#lib/server/db/schema.js';
import { signPublicMediaUrl, verifyPublicMediaSig } from '#lib/server/public-media.js';
import { publicMediaUrlFor } from '#lib/server/publish.js';
import { readAppEnv } from '#lib/server/env.js';
import { GET as publicMediaGET } from '../src/routes/api/media/public/[key]/+server';

describe('publicMediaUrlFor', () => {
	it('uses the configured media origin when set', () => {
		const env = { ...TEST_ENV, MEDIA_PUBLIC_BASE_URL: 'https://media.test/' };
		expect(publicMediaUrlFor(env, '1700000000000-0123456789abcdef.png')).toBe(
			'https://media.test/1700000000000-0123456789abcdef.png'
		);
	});

	it('falls back to the signed Worker route', async () => {
		const url = await publicMediaUrlFor(TEST_ENV, '1700000000000-0123456789abcdef.png');
		expect(url).toContain('/api/media/public/1700000000000-0123456789abcdef.png?exp=');
		expect(url).toContain('&sig=');
	});

	it('degrades a bad media origin to the signed route instead of throwing', async () => {
		const base = {
			APP_URL: 'https://app.test',
			APP_ENCRYPTION_KEY: TEST_ENV.APP_ENCRYPTION_KEY,
			AUTH_SECRET: 'a-secret-at-least-16'
		};
		expect(
			readAppEnv({ ...base, MEDIA_PUBLIC_BASE_URL: 'http://media.test' }).MEDIA_PUBLIC_BASE_URL
		).toBe('http://media.test');
		for (const bad of ['http://media.test', 'not a url', '', '  ']) {
			const url = await publicMediaUrlFor(
				{ ...TEST_ENV, MEDIA_PUBLIC_BASE_URL: bad },
				'1700000000000-0123456789abcdef.png'
			);
			expect(url).toContain('/api/media/public/');
			expect(url).toContain('&sig=');
		}
	});
});

describe('public media urls', () => {
	let db: AppDb;
	let close: () => void;
	const media = createTestMedia();
	const user = {
		id: 'u',
		email: 'media@localhost',
		timezone: 'UTC',
		totpEnabled: true,
		mfaVerified: true
	};

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		await db.insert(users).values({
			id: newId(),
			email: user.email,
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
		const draftId = newId();
		await db.insert(drafts).values({
			id: draftId,
			userId: (await db.select({ id: users.id }).from(users))[0].id,
			baseBody: 'pic',
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
		await db.insert(draftMedia).values({
			id: newId(),
			draftId,
			storageKey: '1700000000000-0123456789abcdef.png',
			mime: 'image/png',
			size: 4,
			createdAt: now
		});
		await media.put(
			'1700000000000-0123456789abcdef.png',
			new Uint8Array([1, 2, 3, 4]),
			'image/png'
		);
	});
	afterAll(() => close());

	it('signs and verifies round-trip', async () => {
		const url = await signPublicMediaUrl(
			TEST_ENV.APP_ENCRYPTION_KEY,
			'https://app.test',
			'1700000000000-0123456789abcdef.png'
		);
		const u = new URL(url);
		expect(u.pathname).toBe('/api/media/public/1700000000000-0123456789abcdef.png');
		const ok = await verifyPublicMediaSig(
			TEST_ENV.APP_ENCRYPTION_KEY,
			'1700000000000-0123456789abcdef.png',
			Number(u.searchParams.get('exp')),
			u.searchParams.get('sig') ?? ''
		);
		expect(ok).toEqual({ ok: true });
		expect(
			await verifyPublicMediaSig(
				TEST_ENV.APP_ENCRYPTION_KEY,
				'1700000000000-0123456789abcdef.png',
				Date.now() - 1,
				'x'
			)
		).toEqual({ ok: false, error: 'URL expired' });
		expect(
			await verifyPublicMediaSig(
				TEST_ENV.APP_ENCRYPTION_KEY,
				'1700000000000-0123456789abcdef.png',
				Date.now() + 1000,
				'tampered'
			)
		).toEqual({ ok: false, error: 'Bad signature' });
	});

	it('serves bytes to signed urls and rejects the rest', async () => {
		const url = await signPublicMediaUrl(
			TEST_ENV.APP_ENCRYPTION_KEY,
			'https://app.test',
			'1700000000000-0123456789abcdef.png'
		);
		const locals = { db, media, user, env: TEST_ENV } as never;
		const good = (await publicMediaGET({
			params: { key: '1700000000000-0123456789abcdef.png' },
			url: new URL(url),
			locals
		} as never)) as Response;
		expect(good.status).toBe(200);
		expect(good.headers.get('Content-Type')).toBe('image/png');
		// Not cached: a deleted object stops being reachable immediately.
		expect(good.headers.get('Cache-Control')).toBe('no-store');
		expect(new Uint8Array(await good.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));

		const bad = (await publicMediaGET({
			params: { key: '1700000000000-0123456789abcdef.png' },
			url: new URL(
				'https://app.test/api/media/public/1700000000000-0123456789abcdef.png?exp=999&sig=nope'
			),
			locals
		} as never)) as Response;
		expect(bad.status).toBe(403);
	});
});

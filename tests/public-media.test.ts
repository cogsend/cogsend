import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { createTestDb, createTestMedia, TEST_ENV } from '#lib/server/db/test.js';
import { draftMedia, drafts, users } from '#lib/server/db/schema.js';
import { signPublicMediaUrl, verifyPublicMediaSig } from '#lib/server/public-media.js';
import { jpegKey } from '#lib/server/media.js';
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

	it('names a kept JPEG beside the original under the media origin', () => {
		const env = { ...TEST_ENV, MEDIA_PUBLIC_BASE_URL: 'https://media.test/' };
		expect(publicMediaUrlFor(env, '1700000000000-0123456789abcdef.png', 'jpeg')).toBe(
			'https://media.test/jpeg/1700000000000-0123456789abcdef.png'
		);
	});

	it('sends a cover through the uncached route, since a new one replaces it in place', async () => {
		const env = { ...TEST_ENV, MEDIA_PUBLIC_BASE_URL: 'https://media.test/' };
		const url = new URL(
			await publicMediaUrlFor(env, '1700000000000-0123456789abcdef.mp4', 'cover')
		);
		expect(url.origin).toBe(TEST_ENV.APP_URL);
		expect(url.pathname).toBe('/api/media/public/1700000000000-0123456789abcdef.mp4');
		expect(url.searchParams.get('v')).toBe('cover');
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

	it('serves the JPEG copy only to a URL signed for it', async () => {
		const key = '1700000000000-0123456789abcdef.png';
		const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9]);
		await media.put(jpegKey(key), jpeg, 'image/jpeg');
		const locals = { db, media, user, env: TEST_ENV } as never;
		const get = (url: URL) =>
			publicMediaGET({ params: { key }, url, locals } as never) as Promise<Response>;

		const signed = new URL(
			await signPublicMediaUrl(
				TEST_ENV.APP_ENCRYPTION_KEY,
				'https://app.test',
				key,
				Date.now(),
				'jpeg'
			)
		);
		expect(signed.searchParams.get('v')).toBe('jpeg');
		const copy = await get(signed);
		expect(copy.status).toBe(200);
		expect(copy.headers.get('Content-Type')).toBe('image/jpeg');
		expect(new Uint8Array(await copy.arrayBuffer())).toEqual(jpeg);

		// A URL signed for the original cannot be turned into one for the copy,
		// nor the other way round, nor pointed at something else kept beside it.
		const plain = new URL(
			await signPublicMediaUrl(TEST_ENV.APP_ENCRYPTION_KEY, 'https://app.test', key)
		);
		plain.searchParams.set('v', 'jpeg');
		expect((await get(plain)).status).toBe(403);
		const dropped = new URL(signed);
		dropped.searchParams.delete('v');
		expect((await get(dropped)).status).toBe(403);
		const cover = new URL(signed);
		cover.searchParams.set('v', 'cover');
		expect((await get(cover)).status).toBe(403);
		const unknown = new URL(signed);
		unknown.searchParams.set('v', 'preview');
		expect((await get(unknown)).status).toBe(400);
	});
});

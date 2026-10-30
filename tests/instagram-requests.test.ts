import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { connections, draftMedia, drafts, publishTargets, users } from '#lib/server/db/schema.js';
import { createTestDb, createTestMedia, TEST_ENV } from '#lib/server/db/test.js';
import { makeStoredJpegCopy } from '#lib/server/media.js';
import { POST as publishPOST } from '../src/routes/api/drafts/[id]/publish/+server';
import { POST as schedulePOST } from '../src/routes/api/drafts/[id]/schedule/+server';

/**
 * Instagram refuses a post without a photo or video. That is known the moment
 * someone asks, so an API client is told then — not at the scheduled time —
 * and nothing is queued for it. Other platforms are not held to it.
 */
describe('Instagram in schedule and publish requests', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;
	let instagram: string;
	let mastodon: string;
	const media = createTestMedia();

	let bindings: Record<string, unknown> = {};
	const locals = () => ({
		db,
		env: TEST_ENV,
		media,
		bindings,
		waitUntil: () => {},
		user: {
			id: userId,
			email: 'ig@localhost',
			timezone: 'UTC',
			totpEnabled: true,
			mfaVerified: true
		}
	});

	async function send(
		handler: typeof schedulePOST | typeof publishPOST,
		draftId: string,
		body: Record<string, unknown>
	) {
		const res = (await handler({
			params: { id: draftId },
			request: new Request(`http://localhost/api/drafts/${draftId}/x`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			}),
			locals: locals()
		} as never)) as Response;
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	}

	async function account(platform: string) {
		const now = new Date();
		const id = newId();
		await db.insert(connections).values({
			id,
			userId,
			platform,
			handle: `${id}@${platform}.test`,
			credentialsEncrypted: '{}',
			metaJson: '{}',
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
		return id;
	}

	async function draft(photo?: { mime: string; metaJson?: string; storageKey?: string }) {
		const now = new Date();
		const id = newId();
		await db.insert(drafts).values({
			id,
			userId,
			baseBody: 'ig probe',
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
		if (photo) {
			await db.insert(draftMedia).values({
				id: newId(),
				draftId: id,
				storageKey: photo.storageKey ?? `${Date.now()}-0123456789abcdef.jpg`,
				mime: photo.mime,
				size: 1000,
				width: 1080,
				height: 1080,
				metaJson: photo.metaJson ?? null,
				createdAt: now
			});
		}
		return id;
	}

	const targetsOf = (draftId: string) =>
		db.select().from(publishTargets).where(eq(publishTargets.draftId, draftId));
	const inAnHour = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'ig@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
		instagram = await account('instagram');
		mastodon = await account('mastodon');
	});
	afterAll(() => close());

	it('refuses to schedule a text-only post to Instagram, for any account on it', async () => {
		const id = await draft();
		const res = await send(schedulePOST, id, {
			connectionIds: [mastodon, instagram],
			runAt: inAnHour()
		});
		expect(res.status).toBe(400);
		expect(res.body.error).toBe('Instagram: Instagram needs a photo or video');
		expect(res.body.platform).toBe('instagram');
		expect(await targetsOf(id)).toHaveLength(0);
	});

	it('refuses to publish one, before anything is sent', async () => {
		const id = await draft();
		const res = await send(publishPOST, id, { connectionIds: [instagram] });
		expect(res.status).toBe(400);
		expect(res.body.error).toBe('Instagram: Instagram needs a photo or video');
		expect(await targetsOf(id)).toHaveLength(0);
	});

	it('names what else Instagram cannot take', async () => {
		const png = await draft({ mime: 'image/png' });
		const res = await send(schedulePOST, png, { connectionIds: [instagram], runAt: inAnHour() });
		expect(res.status).toBe(400);
		expect(res.body.error).toBe(
			'Instagram: Instagram takes JPEG only — attach this image again, or as a JPEG'
		);
	});

	it('schedules a post with a photo, and holds no other platform to the rule', async () => {
		const withPhoto = await draft({ mime: 'image/png', metaJson: '{"jpeg":{"v":1}}' });
		const ok = await send(schedulePOST, withPhoto, {
			connectionIds: [instagram, mastodon],
			runAt: inAnHour()
		});
		expect(ok.status).toBe(200);
		expect(await targetsOf(withPhoto)).toHaveLength(2);

		const textOnly = await draft();
		const elsewhere = await send(schedulePOST, textOnly, {
			connectionIds: [mastodon],
			runAt: inAnHour()
		});
		expect(elsewhere.status).toBe(200);
	});

	describe('with the Images binding', () => {
		const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
		const resizer = (answer: () => Response) => ({
			input: () => ({
				transform: () => ({
					output: async () => ({ response: answer })
				})
			})
		});
		const pngDraft = async (name: string) => {
			const storageKey = `${Date.now()}-${name}0123456789.png`;
			await media.put(
				storageKey,
				new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
				'image/png'
			);
			return { id: await draft({ mime: 'image/png', storageKey }), storageKey };
		};
		const mediaOf = async (draftId: string) =>
			(await db.select().from(draftMedia).where(eq(draftMedia.draftId, draftId)))[0];

		it('makes the JPEG copy a PNG arrived without, keeps it, and schedules', async () => {
			bindings = { IMAGES: resizer(() => new Response(JPEG)) };
			try {
				const { id, storageKey } = await pngDraft('aaaa');
				const res = await send(schedulePOST, id, {
					connectionIds: [instagram],
					runAt: inAnHour()
				});
				expect(res.status).toBe(200);
				expect(await media.get(`jpeg/${storageKey}`)).toEqual(JPEG);
				expect(JSON.parse((await mediaOf(id)).metaJson ?? '{}')).toEqual({ jpeg: { v: 1 } });
			} finally {
				bindings = {};
			}
		});

		it('still refuses when the copy cannot be made', async () => {
			bindings = { IMAGES: resizer(() => new Response('no', { status: 500 })) };
			try {
				const { id, storageKey } = await pngDraft('bbbb');
				const res = await send(publishPOST, id, { connectionIds: [instagram] });
				expect(res.status).toBe(400);
				expect(res.body.error).toBe(
					'Instagram: Instagram takes JPEG only — attach this image again, or as a JPEG'
				);
				expect(await media.get(`jpeg/${storageKey}`)).toBeNull();
				expect(await targetsOf(id)).toHaveLength(0);
			} finally {
				bindings = {};
			}
		});
	});
});

describe('makeStoredJpegCopy', () => {
	it('leaves an animated WebP alone, as the browser does', async () => {
		const media = createTestMedia();
		const webp = new Uint8Array(32);
		webp.set(
			[...'RIFF'].map((c) => c.charCodeAt(0)),
			0
		);
		webp.set(
			[...'WEBPVP8X'].map((c) => c.charCodeAt(0)),
			8
		);
		webp[20] = 0x02;
		await media.put('a.webp', webp, 'image/webp');
		let called = false;
		const images = {
			input: () => {
				called = true;
				throw new Error('not expected');
			}
		};
		expect(await makeStoredJpegCopy(media, 'a.webp', 100, images as never)).toBe(false);
		expect(called).toBe(false);
		expect(await media.get('jpeg/a.webp')).toBeNull();
	});
});

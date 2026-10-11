import { afterAll, describe, expect, it } from 'vitest';
import { encryptJson } from '#lib/server/crypto.js';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { draftMedia, drafts, users } from '#lib/server/db/schema.js';
import { createTestDb, createTestMedia, TEST_ENV } from '#lib/server/db/test.js';
import { readAppEnv } from '#lib/server/env.js';
import { connections, publishTargets } from '#lib/server/db/schema.js';
import { publishTarget } from '#lib/server/publish.js';
import { POST as mediaPOST } from '../src/routes/api/drafts/[id]/media/+server';

/**
 * Video uploads are wired for LinkedIn but not verified against the live API,
 * so the feature is off unless an instance sets ENABLE_VIDEO_UPLOAD. While it
 * is off the affordance is hidden *and* the API refuses video, because an
 * upload would otherwise park up to 95MB in R2 for a draft that cannot publish.
 */
// A minimal mp4 header: box size, `ftyp` at offset 4, then the `isom` brand.
// The sniffer wants at least 12 bytes, so a shorter stub is correctly refused.
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

describe('ENABLE_VIDEO_UPLOAD', () => {
	it('is off by default and for the explicit off values', () => {
		const required = {
			APP_URL: 'https://social.example',
			APP_ENCRYPTION_KEY: 'a'.repeat(64),
			AUTH_SECRET: 'b'.repeat(32)
		};
		expect(readAppEnv(required).videoUploadEnabled).toBe(false);
		for (const off of ['', '0', 'false', 'no', 'off']) {
			expect(readAppEnv({ ...required, ENABLE_VIDEO_UPLOAD: off }).videoUploadEnabled).toBe(false);
		}
		expect(readAppEnv({ ...required, ENABLE_VIDEO_UPLOAD: '1' }).videoUploadEnabled).toBe(true);
	});

	it('refuses a video upload while it is off', async () => {
		const { db, close } = await createTestDb();
		const owner = await seed(db);
		const res = await upload(db, owner.draftId, owner.userId, { video: true });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toMatch(/not enabled/i);
		// Nothing was stored, so no orphaned bytes and no unpublishable row.
		expect(await db.select().from(draftMedia)).toHaveLength(0);
		close();
	});

	it('accepts a video upload once it is enabled', async () => {
		const { db, close } = await createTestDb();
		const owner = await seed(db);
		const env = { ...TEST_ENV, videoUploadEnabled: true };
		const res = await upload(db, owner.draftId, owner.userId, { video: true, env });
		expect(res.status).toBe(201);
		const rows = await db.select().from(draftMedia);
		expect(rows).toHaveLength(1);
		expect(rows[0].mime).toBe('video/mp4');
		close();
	});

	it('still accepts images with the feature off', async () => {
		const { db, close } = await createTestDb();
		const owner = await seed(db);
		const res = await upload(db, owner.draftId, owner.userId, { video: false });
		expect(res.status).toBe(201);
		close();
	});

	it('fails a publish that carries a video row, with a message that says why', async () => {
		const { db, close } = await createTestDb();
		const owner = await seed(db);
		const now = new Date();
		const connectionId = newId();
		await db.insert(connections).values({
			id: connectionId,
			userId: owner.userId,
			platform: 'bluesky',
			handle: 'video.bsky.social',
			credentialsEncrypted: await encryptJson(
				{
					handle: 'video.bsky.social',
					appPassword: 'xxxx',
					did: 'did:plc:video',
					pdsHost: 'https://bsky.social'
				},
				TEST_ENV.APP_ENCRYPTION_KEY
			),
			metaJson: JSON.stringify({ did: 'did:plc:video' }),
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
		const targetId = newId();
		await db.insert(publishTargets).values({
			id: targetId,
			draftId: owner.draftId,
			connectionId,
			status: 'pending',
			attemptCount: 0,
			createdAt: now,
			updatedAt: now
		});
		// A row that predates the flag being switched off on this instance.
		await db.insert(draftMedia).values({
			id: newId(),
			draftId: owner.draftId,
			storageKey: 'media/clip.mp4',
			mime: 'video/mp4',
			size: MP4.length,
			segmentIndex: 0,
			createdAt: now
		});

		const result = await publishTarget(db, TEST_ENV, createTestMedia(), targetId, {
			fetchImpl: async () => new Response('unmocked', { status: 404 })
		});
		// Terminal, not retryable: only the operator can turn the feature on, so a
		// backoff would burn the attempt budget and bury the reason.
		expect(result.status).toBe('failed');
		expect(result.error).toMatch(/not enabled/i);

		const [row] = await db.select().from(publishTargets);
		expect(row.status).toBe('failed');
		expect(row.errorMessage).toMatch(/not enabled/i);
		close();
	});

	// ---- helpers ----------------------------------------------------------
	async function seed(db: AppDb) {
		const now = new Date();
		const userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'video@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
		const draftId = newId();
		await db.insert(drafts).values({
			id: draftId,
			userId,
			baseBody: 'video probe',
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
		return { userId, draftId };
	}

	function upload(
		db: AppDb,
		draftId: string,
		userId: string,
		opts: { video: boolean; env?: typeof TEST_ENV }
	) {
		const form = new FormData();
		form.set('segmentIndex', '0');
		if (opts.video) {
			form.append('files', new File([MP4], 'clip.mp4', { type: 'video/mp4' }));
		} else {
			form.append(
				'files',
				new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'p.png', {
					type: 'image/png'
				})
			);
		}
		return mediaPOST({
			params: { id: draftId },
			request: new Request('http://localhost/api/drafts/x/media', { method: 'POST', body: form }),
			locals: {
				db,
				media: createTestMedia(),
				env: opts.env ?? TEST_ENV,
				user: {
					id: userId,
					email: 'video@localhost',
					timezone: 'UTC',
					totpEnabled: true,
					mfaVerified: true
				}
			}
		} as never) as Promise<Response>;
	}
	afterAll(() => {
		/* each case closes its own database */
	});
});

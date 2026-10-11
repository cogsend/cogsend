import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { draftMedia, draftVariants, drafts, users } from '#lib/server/db/schema.js';
import { createTestDb, createTestMedia } from '#lib/server/db/test.js';
import { POST as mediaPOST } from '../src/routes/api/drafts/[id]/media/+server';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('POST /api/drafts/[id]/media quotas', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;
	let draftId: string;
	const media = createTestMedia();

	const localsFor = () => ({
		db,
		media,
		user: {
			id: userId,
			email: 'quota@localhost',
			timezone: 'UTC',
			totpEnabled: true,
			mfaVerified: true
		}
	});

	function upload(toDraft: string, files: number, segmentIndex = '0') {
		const form = new FormData();
		form.set('segmentIndex', segmentIndex);
		for (let i = 0; i < files; i++) {
			form.append('files', new File([PNG], `q${i}.png`, { type: 'image/png' }));
		}
		return mediaPOST({
			params: { id: toDraft },
			request: new Request('http://localhost/api/drafts/x/media', {
				method: 'POST',
				body: form
			}),
			locals: localsFor()
		} as never) as Promise<Response>;
	}

	async function freshDraft() {
		const now = new Date();
		const id = newId();
		await db.insert(drafts).values({
			id,
			userId,
			baseBody: 'quota probe',
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
		return id;
	}

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'quota@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
		draftId = newId();
		await db.insert(drafts).values({
			id: draftId,
			userId,
			baseBody: 'quota probe',
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
	});

	afterAll(() => close());

	it('accepts a normal upload', async () => {
		const res = await upload(draftId, 1);
		expect(res.status).toBe(201);
	});

	it('rejects past the per-draft cap', async () => {
		const now = new Date();
		for (let i = 0; i < 31; i++) {
			await db.insert(draftMedia).values({
				id: newId(),
				draftId,
				storageKey: `seed-${i}`,
				mime: 'image/png',
				size: 8,
				sortOrder: 10 + i,
				segmentIndex: 1,
				createdAt: now
			});
		}
		const res = await upload(draftId, 1);
		expect(res.status).toBe(413);
		expect(await res.json()).toMatchObject({ error: expect.stringMatching(/per draft/) });
	});

	it('rejects past the per-account cap', async () => {
		const spill = await freshDraft();
		const now = new Date();
		for (let i = 0; i < 1000; i++) {
			await db.insert(draftMedia).values({
				id: newId(),
				draftId: spill,
				storageKey: `bulk-${i}`,
				mime: 'image/png',
				size: 8,
				sortOrder: 100 + i,
				segmentIndex: 2,
				createdAt: now
			});
		}
		const res = await upload(await freshDraft(), 1);
		expect(res.status).toBe(413);
		expect(await res.json()).toMatchObject({ error: expect.stringMatching(/per account/) });
	});
});

describe('POST /api/drafts/[id]/media request ceiling', () => {
	it('refuses an oversized body before parsing the multipart', async () => {
		let parsed = false;
		const request = {
			headers: new Headers({ 'content-length': '100000001' }),
			formData: async () => {
				parsed = true;
				throw new Error('formData must not run for an oversized body');
			}
		} as unknown as Request;
		const res = (await mediaPOST({
			params: { id: 'irrelevant' },
			request,
			locals: {
				db: null,
				user: {
					id: 'u1',
					email: 'ceiling@localhost',
					timezone: 'UTC',
					totpEnabled: true,
					mfaVerified: true
				}
			}
		} as never)) as Response;
		// Rejected before the ownership query too: nothing here may touch D1.
		expect(res.status).toBe(413);
		expect(parsed).toBe(false);
	});
});

describe('POST /api/drafts/[id]/media segment bounds', () => {
	it('refuses a segment the draft does not have, instead of losing the image at publish', async () => {
		// `resolvePublishSegments` walks the same `splitThreadSegments` the
		// composer renders, so a row parked past the last card is never attached
		// to a post — the upload would look fine and the image would vanish.
		const { db, close } = await createTestDb();
		try {
			const now = new Date();
			const userId = newId();
			await db.insert(users).values({
				id: userId,
				email: 'bounds@localhost',
				passwordHash: 'x',
				timezone: 'UTC',
				createdAt: now,
				updatedAt: now
			});
			const makeDraft = async (baseBody: string) => {
				const id = newId();
				await db.insert(drafts).values({
					id,
					userId,
					baseBody,
					status: 'draft',
					createdAt: now,
					updatedAt: now
				});
				return id;
			};
			const upload = (toDraft: string, segmentIndex: string) => {
				const form = new FormData();
				form.set('segmentIndex', segmentIndex);
				form.append('files', new File([PNG], 'one.png', { type: 'image/png' }));
				return mediaPOST({
					params: { id: toDraft },
					request: new Request('http://localhost/api/drafts/x/media', {
						method: 'POST',
						body: form
					}),
					locals: {
						db,
						media: createTestMedia(),
						user: {
							id: userId,
							email: 'bounds@localhost',
							timezone: 'UTC',
							totpEnabled: true,
							mfaVerified: true
						}
					}
				} as never) as Promise<Response>;
			};

			const single = await makeDraft('one card');
			expect((await upload(single, '0')).status).toBe(201);
			const past = await upload(single, '5');
			expect(past.status).toBe(400);
			expect((await past.json()).error).toMatch(/past the last segment/);

			// An empty draft is still one card: `splitThreadSegments('')` answers
			// `['']`, and a card holding only an image publishes.
			const empty = await makeDraft('');
			expect((await upload(empty, '0')).status).toBe(201);
			expect((await upload(empty, '1')).status).toBe(400);

			// Two cards accept index 1 and refuse 2.
			const two = await makeDraft('first\n---\nsecond');
			expect((await upload(two, '1')).status).toBe(201);
			expect((await upload(two, '2')).status).toBe(400);

			// A per-platform variant can add posts of its own, and media on one of
			// those is attached at publish — so the bound is the longest body the
			// draft can publish, not the shared one.
			const variant = await makeDraft('only one card');
			await db.insert(draftVariants).values({
				id: newId(),
				draftId: variant,
				platform: 'mastodon',
				body: 'one\n---\ntwo\n---\nthree',
				optionsJson: '{}',
				createdAt: now,
				updatedAt: now
			});
			expect((await upload(variant, '2')).status).toBe(201);
			expect((await upload(variant, '3')).status).toBe(400);
		} finally {
			close();
		}
	});
});

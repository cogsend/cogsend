import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { createTestDb, createTestMedia, TEST_ENV } from '#lib/server/db/test.js';
import {
	connections,
	draftMedia,
	drafts,
	draftShares,
	draftVariants,
	publishTargets,
	users
} from '#lib/server/db/schema.js';
import {
	hasGoneOut,
	isShareTokenFormat,
	shareLifetimeMs,
	shareVersions,
	type ShareMedia
} from '#lib/domain/draft-share.js';
import { mediaUrl, imageUrl, coverUrl } from '#lib/domain/media-layout.js';
import {
	DELETE as shareDELETE,
	GET as shareGET,
	POST as sharePOST
} from '../src/routes/api/drafts/[id]/share/+server';
import { DELETE as draftDELETE } from '../src/routes/api/drafts/[id]/+server';
import { load as sharePageLoad } from '../src/routes/p/[token]/+page.server';
import { GET as sharedMediaGET } from '../src/routes/p/[token]/media/[key]/+server';

const DAY = 24 * 60 * 60_000;

function media(segmentIndex: number, id = `m${segmentIndex}`): ShareMedia {
	return {
		id,
		storageKey: `${id}.png`,
		mime: 'image/png',
		width: 10,
		height: 10,
		altText: null,
		segmentIndex,
		meta: null
	};
}

describe('what a preview link shows', () => {
	it('shows the main text as its thread, media on the card it belongs to', () => {
		const [post] = shareVersions({
			baseBody: 'first\n---\nsecond',
			variants: [],
			media: [media(1)]
		});
		expect(post!.key).toBe('post');
		expect(post!.cards).toEqual([
			{ text: 'first', media: [] },
			{ text: 'second', media: [media(1)] }
		]);
	});

	it('adds a version per platform whose text differs, in platform order', () => {
		const versions = shareVersions({
			baseBody: 'main',
			variants: [
				{ platform: 'bluesky', body: 'short one' },
				// Options only (a Mastodon poll, visibility): publishes the main text.
				{ platform: 'mastodon', body: null },
				{ platform: 'x', body: 'for x' }
			],
			media: []
		});
		expect(versions.map((v) => [v.key, v.label])).toEqual([
			['post', 'Post'],
			['x', 'X'],
			['bluesky', 'Bluesky']
		]);
		expect(versions[1]!.cards).toEqual([{ text: 'for x', media: [] }]);
	});

	it('flattens a thread into one post for a platform without threads', () => {
		const all = [media(0), media(1)];
		const linkedin = shareVersions({
			baseBody: 'main',
			variants: [{ platform: 'linkedin', body: 'one\n---\ntwo' }],
			media: all
		})[1]!;
		expect(linkedin.cards).toEqual([{ text: 'one\n\ntwo', media: all }]);
	});

	it('still shows a card for a draft with nothing written', () => {
		expect(shareVersions({ baseBody: '', variants: [], media: [] })[0]!.cards).toEqual([
			{ text: '', media: [] }
		]);
	});
});

describe('the rules a link lives by', () => {
	it('lasts 14 days unless asked otherwise, never past 30', () => {
		expect(shareLifetimeMs()).toBe(14 * DAY);
		expect(shareLifetimeMs(1)).toBe(DAY);
		expect(shareLifetimeMs(30)).toBe(30 * DAY);
		for (const bad of [0, 31, 1.5, '7', null]) expect(shareLifetimeMs(bad)).toBeNull();
	});

	it('stops once anything has gone out, not for a cancelled or waiting account', () => {
		expect(hasGoneOut([])).toBe(false);
		expect(hasGoneOut([{ status: 'scheduled' }, { status: 'failed' }])).toBe(false);
		expect(hasGoneOut([{ status: 'cancelled', remotePostId: 'old' }])).toBe(false);
		expect(hasGoneOut([{ status: 'failed' }, { status: 'published' }])).toBe(true);
		expect(hasGoneOut([{ status: 'publishing', remotePostId: 'r1' }])).toBe(true);
	});

	it('takes only the shape a token has', () => {
		expect(isShareTokenFormat('a'.repeat(64))).toBe(true);
		expect(isShareTokenFormat('A'.repeat(64))).toBe(false);
		expect(isShareTokenFormat('a'.repeat(63))).toBe(false);
		expect(isShareTokenFormat(undefined)).toBe(false);
	});

	it('builds media urls on whichever route serves them', () => {
		const m = { storageKey: 'k.png', meta: { preview: { v: 2 }, cover: { v: 3 } } };
		expect(mediaUrl(m)).toBe('/api/media/k.png');
		expect(imageUrl(m, '/p/t/media')).toBe('/p/t/media/k.png?preview=2');
		expect(coverUrl(m, '/p/t/media')).toBe('/p/t/media/k.png?cover=3');
	});
});

describe('preview links, end to end', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;
	let otherId: string;
	const store = createTestMedia();
	const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

	const userObj = (id: string) => ({
		id,
		email: `${id}@localhost`,
		timezone: 'UTC',
		totpEnabled: true,
		mfaVerified: true
	});
	const locals = (id = userId) => ({ db, user: userObj(id), env: TEST_ENV, media: store });
	const share = async (
		method: 'GET' | 'POST' | 'DELETE',
		draftId: string,
		opts: { as?: string; body?: unknown } = {}
	) => {
		const handler = method === 'GET' ? shareGET : method === 'POST' ? sharePOST : shareDELETE;
		const request = new Request('http://localhost/api', {
			method,
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
		});
		const res = (await handler({
			params: { id: draftId },
			locals: locals(opts.as),
			request
		} as never)) as Response;
		return { status: res.status, body: await res.json() };
	};
	const tokenOf = (url: string) => new URL(url).pathname.split('/').pop()!;
	const view = (token: string) =>
		sharePageLoad({
			params: { token },
			locals: { db, env: TEST_ENV },
			setHeaders: () => {}
		} as never) as Promise<Record<string, unknown>>;
	const viewStatus = (token: string) =>
		view(token).then(
			() => 200,
			(err: { status?: number }) => err.status
		);
	const fetchMedia = async (token: string, key: string) => {
		const url = new URL(`http://localhost/p/${token}/media/${key}`);
		return (await sharedMediaGET({
			params: { token, key },
			locals: { db, media: store },
			request: new Request(url),
			url
		} as never)) as Response;
	};

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		otherId = newId();
		for (const id of [userId, otherId]) {
			await db.insert(users).values({
				id,
				email: `${id}@localhost`,
				passwordHash: 'x',
				timezone: 'UTC',
				createdAt: now,
				updatedAt: now
			});
		}
	});
	afterAll(() => close());

	async function seedDraft(owner = userId, body = 'hello\n---\nworld') {
		const now = new Date();
		const id = newId();
		await db.insert(drafts).values({
			id,
			userId: owner,
			title: 'Launch post',
			baseBody: body,
			createdAt: now,
			updatedAt: now
		});
		const key = `${Date.now()}-${id.slice(0, 16).replace(/-/g, 'a')}.png`;
		await store.put(key, PNG, 'image/png');
		await db.insert(draftMedia).values({
			id: newId(),
			draftId: id,
			storageKey: key,
			mime: 'image/png',
			size: PNG.length,
			sortOrder: 0,
			segmentIndex: 1,
			createdAt: now
		});
		return { id, key };
	}

	async function addTarget(draftId: string, status: string, remotePostId: string | null = null) {
		const now = new Date();
		const connectionId = newId();
		await db.insert(connections).values({
			id: connectionId,
			userId,
			platform: 'mastodon',
			handle: 'secret-handle@example.social',
			displayName: 'Secret Name',
			credentialsEncrypted: 'enc',
			createdAt: now,
			updatedAt: now
		});
		await db.insert(publishTargets).values({
			id: newId(),
			draftId,
			connectionId,
			status,
			remotePostId,
			createdAt: now,
			updatedAt: now
		});
	}

	it('makes a link anyone can open, showing the saved draft and no account', async () => {
		const { id, key } = await seedDraft();
		await addTarget(id, 'scheduled');
		await db.insert(draftVariants).values({
			id: newId(),
			draftId: id,
			platform: 'bluesky',
			body: 'bluesky words',
			createdAt: new Date(),
			updatedAt: new Date()
		});
		const made = await share('POST', id);
		expect(made.status).toBe(201);
		expect(made.body.share.url).toMatch(/^http:\/\/localhost:5173\/p\/[0-9a-f]{64}$/);
		const expires = new Date(made.body.share.expiresAt).getTime();
		expect(expires - Date.now()).toBeGreaterThan(14 * DAY - 60_000);
		expect(expires - Date.now()).toBeLessThanOrEqual(14 * DAY);

		const page = await view(tokenOf(made.body.share.url));
		expect(page.title).toBe('Launch post');
		const versions = page.versions as Array<{ key: string; cards: Array<{ text: string }> }>;
		expect(versions.map((v) => v.key)).toEqual(['post', 'bluesky']);
		expect(versions[0]!.cards.map((c) => c.text)).toEqual(['hello', 'world']);
		const serialized = JSON.stringify(page);
		expect(serialized).not.toContain('secret-handle');
		expect(serialized).not.toContain('Secret Name');
		expect(serialized).not.toContain(userId);

		const res = await fetchMedia(tokenOf(made.body.share.url), key);
		expect(res.status).toBe(200);
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
	});

	it('stores only a hash of the token', async () => {
		const { id } = await seedDraft();
		const token = tokenOf((await share('POST', id)).body.share.url);
		const [row] = await db.select().from(draftShares).where(eq(draftShares.draftId, id));
		expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
		expect(row!.tokenHash).not.toBe(token);
		expect(JSON.stringify(row)).not.toContain(token);
	});

	it('gives the owner the same link again, and edits show on the next visit', async () => {
		const { id } = await seedDraft();
		const made = await share('POST', id);
		const again = await share('GET', id);
		expect(again.status).toBe(200);
		expect(again.body.share.url).toBe(made.body.share.url);

		await db.update(drafts).set({ baseBody: 'rewritten' }).where(eq(drafts.id, id));
		const page = await view(tokenOf(made.body.share.url));
		const versions = page.versions as Array<{ cards: Array<{ text: string }> }>;
		expect(versions[0]!.cards.map((c) => c.text)).toEqual(['rewritten']);
	});

	it('turns off when revoked, and a new link replaces the old one', async () => {
		const { id } = await seedDraft();
		const first = tokenOf((await share('POST', id)).body.share.url);
		const second = tokenOf((await share('POST', id)).body.share.url);
		expect(second).not.toBe(first);
		expect(await viewStatus(first)).toBe(404);
		expect(await viewStatus(second)).toBe(200);

		expect((await share('DELETE', id)).body).toEqual({ share: null });
		expect(await viewStatus(second)).toBe(404);
		expect((await share('GET', id)).body).toEqual({ share: null });
	});

	it('expires', async () => {
		const { id, key } = await seedDraft();
		const token = tokenOf((await share('POST', id, { body: { expiresInDays: 1 } })).body.share.url);
		await db
			.update(draftShares)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(draftShares.draftId, id));
		expect(await viewStatus(token)).toBe(404);
		expect((await fetchMedia(token, key)).status).toBe(404);
		expect((await share('GET', id)).body).toEqual({ share: null });
	});

	it('refuses a length it does not offer', async () => {
		const { id } = await seedDraft();
		const res = await share('POST', id, { body: { expiresInDays: 90 } });
		expect(res.status).toBe(400);
		expect(res.body.error).toContain('1 to 30');
	});

	it('stops working once the post goes out, and cannot be made after', async () => {
		const { id, key } = await seedDraft();
		const token = tokenOf((await share('POST', id)).body.share.url);
		await addTarget(id, 'published', 'remote-1');
		expect(await viewStatus(token)).toBe(404);
		expect((await fetchMedia(token, key)).status).toBe(404);
		const again = await share('POST', id);
		expect(again.status).toBe(409);
	});

	it('goes with the draft when the draft is deleted', async () => {
		const { id } = await seedDraft();
		const token = tokenOf((await share('POST', id)).body.share.url);
		const res = (await draftDELETE({ params: { id }, locals: locals() } as never)) as Response;
		expect(res.status).toBe(200);
		expect(await viewStatus(token)).toBe(404);
		expect(await db.select().from(draftShares).where(eq(draftShares.draftId, id))).toEqual([]);
	});

	it("is the owner's alone to make, read or revoke", async () => {
		const { id } = await seedDraft();
		const token = tokenOf((await share('POST', id)).body.share.url);
		for (const method of ['GET', 'POST', 'DELETE'] as const) {
			expect((await share(method, id, { as: otherId })).status).toBe(404);
		}
		expect(await viewStatus(token)).toBe(200);
	});

	it("serves only the shared draft's own media", async () => {
		const shared = await seedDraft();
		const other = await seedDraft();
		const token = tokenOf((await share('POST', shared.id)).body.share.url);
		expect((await fetchMedia(token, shared.key)).status).toBe(200);
		expect((await fetchMedia(token, other.key)).status).toBe(404);
		expect((await fetchMedia('f'.repeat(64), shared.key)).status).toBe(404);
	});

	it('answers a malformed or unknown token with the same 404', async () => {
		expect(await viewStatus('not-a-token')).toBe(404);
		expect(await viewStatus('0'.repeat(64))).toBe(404);
	});
});

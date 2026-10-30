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
			media: [media(1)],
			platforms: []
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
			media: [],
			platforms: ['bluesky', 'mastodon', 'x']
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
			media: all,
			platforms: ['linkedin']
		})[1]!;
		expect(linkedin.cards).toEqual([{ text: 'one\n\ntwo', media: all }]);
	});

	it('still shows a card for a draft with nothing written', () => {
		expect(
			shareVersions({ baseBody: '', variants: [], media: [], platforms: [] })[0]!.cards
		).toEqual([{ text: '', media: [] }]);
	});

	it('leaves out a variant whose platform the post is not going to', () => {
		// Deselecting a platform in the composer keeps its stored variant.
		const versions = shareVersions({
			baseBody: 'main',
			variants: [
				{ platform: 'x', body: 'for x' },
				{ platform: 'bluesky', body: 'for bluesky' }
			],
			media: [],
			platforms: ['bluesky']
		});
		expect(versions.map((v) => v.key)).toEqual(['post', 'bluesky']);
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
		opts: { as?: string; body?: unknown; env?: typeof TEST_ENV } = {}
	) => {
		const handler = method === 'GET' ? shareGET : method === 'POST' ? sharePOST : shareDELETE;
		const request = new Request('http://localhost/api', {
			method,
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
		});
		const res = (await handler({
			params: { id: draftId },
			locals: { ...locals(opts.as), ...(opts.env ? { env: opts.env } : {}) },
			request
		} as never)) as Response;
		return { status: res.status, body: await res.json() };
	};
	const tokenOf = (url: string) => new URL(url).pathname.split('/').pop()!;
	const view = (token: string, env = TEST_ENV) =>
		sharePageLoad({
			params: { token },
			locals: { db, env },
			setHeaders: () => {}
		} as never) as Promise<Record<string, unknown>>;
	const viewStatus = (token: string, env = TEST_ENV) =>
		view(token, env).then(
			() => 200,
			(err: { status?: number }) => err.status
		);
	const fetchMedia = async (token: string, key: string, env = TEST_ENV) => {
		const url = new URL(`http://localhost/p/${token}/media/${key}`);
		return (await sharedMediaGET({
			params: { token, key },
			locals: { db, media: store, env },
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

	async function addAccount(platform = 'mastodon', status = 'active') {
		const now = new Date();
		const id = newId();
		await db.insert(connections).values({
			id,
			userId,
			platform,
			handle: 'secret-handle@example.social',
			displayName: 'Secret Name',
			credentialsEncrypted: 'enc',
			status,
			createdAt: now,
			updatedAt: now
		});
		return id;
	}

	async function addVariant(draftId: string, platform: string) {
		await db.insert(draftVariants).values({
			id: newId(),
			draftId,
			platform,
			body: `${platform} words`,
			createdAt: new Date(),
			updatedAt: new Date()
		});
	}

	const selectAccounts = (draftId: string, ids: string[]) =>
		db
			.update(drafts)
			.set({ selectedConnectionIds: JSON.stringify(ids) })
			.where(eq(drafts.id, draftId));

	const versionKeys = async (draftId: string) => {
		const token = tokenOf((await share('POST', draftId)).body.share.url);
		return ((await view(token)).versions as Array<{ key: string }>).map((v) => v.key);
	};

	async function addTarget(
		draftId: string,
		status: string,
		remotePostId: string | null = null,
		platform = 'mastodon'
	) {
		const now = new Date();
		const connectionId = await addAccount(platform);
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
		await addVariant(id, 'bluesky');
		await selectAccounts(id, [await addAccount('bluesky')]);
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

	it('shows a version only for a platform the draft is going to', async () => {
		const { id } = await seedDraft();
		await addVariant(id, 'x');
		await addVariant(id, 'bluesky');
		// Deselecting X in the composer keeps its variant row.
		await selectAccounts(id, [await addAccount('bluesky'), await addAccount('x', 'disconnected')]);
		expect(await versionKeys(id)).toEqual(['post', 'bluesky']);

		await selectAccounts(id, []);
		expect(await versionKeys(id)).toEqual(['post']);
	});

	it('falls back to the publish targets when the draft never saved a selection', async () => {
		const { id } = await seedDraft();
		await addVariant(id, 'x');
		await addVariant(id, 'bluesky');
		await addTarget(id, 'scheduled', null, 'x');
		await addTarget(id, 'cancelled', null, 'bluesky');
		expect(await versionKeys(id)).toEqual(['post', 'x']);
	});

	it('hides a link made under an earlier encryption key, so the owner can make a new one', async () => {
		const { id } = await seedDraft();
		const old = tokenOf((await share('POST', id)).body.share.url);
		const rotated = { ...TEST_ENV, APP_ENCRYPTION_KEY: 'beef'.repeat(16) };
		expect((await share('GET', id, { env: rotated })).body).toEqual({ share: null });

		const fresh = await share('POST', id, { env: rotated });
		expect(tokenOf(fresh.body.share.url)).not.toBe(old);
		expect((await share('GET', id, { env: rotated })).body.share.url).toBe(fresh.body.share.url);
		expect(await viewStatus(old)).toBe(404);
	});

	it('ends a link and its media as soon as the encryption key changes', async () => {
		const { id, key } = await seedDraft();
		const token = tokenOf((await share('POST', id)).body.share.url);
		const rotated = { ...TEST_ENV, APP_ENCRYPTION_KEY: 'beef'.repeat(16) };
		expect(await viewStatus(token)).toBe(200);
		expect((await fetchMedia(token, key)).status).toBe(200);

		expect(await viewStatus(token, rotated)).toBe(404);
		expect((await fetchMedia(token, key, rotated)).status).toBe(404);
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

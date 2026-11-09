import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { draftMedia, drafts, users } from '#lib/server/db/schema.js';
import { createTestDb, createTestMedia } from '#lib/server/db/test.js';
import { GET as libraryGET } from '../src/routes/api/media/+server';

const keyOf = (n: number, ext = 'png') =>
	`${1_700_000_000_000 + n}-${n.toString(16).padStart(16, '0')}.${ext}`;

describe('your media', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;
	let otherUserId: string;
	const store = createTestMedia();

	const localsFor = (id = userId) => ({
		db,
		media: store,
		user: { id, email: 'lib@localhost', timezone: 'UTC', totpEnabled: true, mfaVerified: true }
	});

	async function addUser(email: string) {
		const id = newId();
		const now = new Date();
		await db
			.insert(users)
			.values({ id, email, passwordHash: 'x', timezone: 'UTC', createdAt: now, updatedAt: now });
		return id;
	}

	async function addDraft(owner = userId, body = 'one\n\n---\n\ntwo') {
		const id = newId();
		const now = new Date();
		await db.insert(drafts).values({
			id,
			userId: owner,
			baseBody: body,
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
		return id;
	}

	async function attach(
		draftId: string,
		storageKey: string,
		opts: { at: number; alt?: string | null; mime?: string; segmentIndex?: number; meta?: object }
	) {
		await db.insert(draftMedia).values({
			id: newId(),
			draftId,
			storageKey,
			mime: opts.mime ?? 'image/png',
			size: 8,
			width: 10,
			height: 10,
			altText: opts.alt ?? null,
			metaJson: opts.meta ? JSON.stringify(opts.meta) : null,
			sortOrder: 0,
			segmentIndex: opts.segmentIndex ?? 0,
			createdAt: new Date(opts.at)
		});
	}

	async function list(query = '', id = userId) {
		const url = new URL(`http://localhost/api/media${query}`);
		const res = (await libraryGET({
			url,
			request: new Request(url),
			locals: localsFor(id)
		} as never)) as Response;
		return { status: res.status, body: await res.json() };
	}

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		userId = await addUser('lib@localhost');
		otherUserId = await addUser('other@localhost');
	});

	afterAll(() => close());

	describe('listing', () => {
		it('shows a file shared by several posts once, with its newest alt text', async () => {
			const first = await addDraft();
			const copy = await addDraft();
			await attach(first, keyOf(1), { at: 1_000, alt: 'old words' });
			await attach(copy, keyOf(1), { at: 2_000, alt: 'new words' });
			await attach(first, keyOf(2), { at: 1_500, alt: 'second file', meta: { preview: { v: 7 } } });

			const { status, body } = await list();
			expect(status).toBe(200);
			expect(body.items.map((i: { storageKey: string }) => i.storageKey)).toEqual([
				keyOf(1),
				keyOf(2)
			]);
			expect(body.items[0]).toMatchObject({ altText: 'new words', mime: 'image/png' });
			expect(body.items[1]).toMatchObject({ altText: 'second file', meta: { preview: { v: 7 } } });
			expect(body.next).toBeNull();
		});

		it("never shows another account's files", async () => {
			const theirs = await addDraft(otherUserId);
			await attach(theirs, keyOf(3), { at: 9_000 });
			const mine = await list();
			expect(mine.body.items.map((i: { storageKey: string }) => i.storageKey)).not.toContain(
				keyOf(3)
			);
			const other = await list('', otherUserId);
			expect(other.body.items.map((i: { storageKey: string }) => i.storageKey)).toEqual([keyOf(3)]);
		});

		it('leaves out a key the app never minted', async () => {
			const draft = await addDraft();
			await attach(draft, 'seed-not-a-real-key', { at: 3_000 });
			const { body } = await list();
			expect(body.items.map((i: { storageKey: string }) => i.storageKey)).not.toContain(
				'seed-not-a-real-key'
			);
		});

		it('pages through files used at the same moment without skipping any', async () => {
			const draft = await addDraft();
			for (let n = 10; n < 15; n++) await attach(draft, keyOf(n), { at: 5_000 });
			const seen: string[] = [];
			let query = '?limit=2';
			for (let page = 0; page < 10; page++) {
				const { body } = await list(query);
				seen.push(...body.items.map((i: { storageKey: string }) => i.storageKey));
				if (!body.next) break;
				query = `?limit=2&before=${encodeURIComponent(body.next)}`;
			}
			const expected = [14, 13, 12, 11, 10].map((n) => keyOf(n));
			expect(seen.slice(0, 5)).toEqual(expected);
			expect(new Set(seen).size).toBe(seen.length);
			// Everything older than those five follows them.
			expect(seen).toContain(keyOf(1));
		});

		it('pages past a key the app never minted', async () => {
			const owner = await addUser('paging@localhost');
			const draft = await addDraft(owner);
			await attach(draft, keyOf(30), { at: 3 });
			await attach(draft, 'legacy-key', { at: 2 });
			await attach(draft, keyOf(31), { at: 1 });
			const seen: string[] = [];
			let query = '?limit=1';
			for (let page = 0; page < 5; page++) {
				const { status, body } = await list(query, owner);
				expect(status).toBe(200);
				seen.push(...body.items.map((i: { storageKey: string }) => i.storageKey));
				if (!body.next) break;
				query = `?limit=1&before=${encodeURIComponent(body.next)}`;
			}
			expect(seen).toEqual([keyOf(30), keyOf(31)]);
		});

		it('refuses a cursor it did not make', async () => {
			expect((await list('?before=nonsense')).status).toBe(400);
			expect((await list('?before=12%3A')).status).toBe(400);
			expect((await list('?before=x%3Aabc')).status).toBe(400);
		});

		it('drops a file once the last post using it is deleted', async () => {
			const only = await addDraft();
			await attach(only, keyOf(20), { at: 20_000 });
			expect((await list()).body.items[0].storageKey).toBe(keyOf(20));
			const { eq } = await import('drizzle-orm');
			await db.delete(drafts).where(eq(drafts.id, only));
			expect(
				(await list()).body.items.map((i: { storageKey: string }) => i.storageKey)
			).not.toContain(keyOf(20));
		});
	});
});

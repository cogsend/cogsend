import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { connections, drafts, users } from '#lib/server/db/schema.js';
import { createTestDb, createTestMedia, TEST_ENV } from '#lib/server/db/test.js';
import { GET as draftGET, PATCH as draftPATCH } from '../src/routes/api/drafts/[id]/+server';
import { POST as draftsPOST } from '../src/routes/api/drafts/+server';
import { POST as duplicatePOST } from '../src/routes/api/drafts/[id]/duplicate/+server';

describe('draft selected accounts', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;
	let connA: string;
	let connB: string;
	const media = createTestMedia();

	const localsFor = () => ({
		db,
		env: TEST_ENV,
		media,
		user: {
			id: userId,
			email: 'selection@localhost',
			timezone: 'UTC',
			totpEnabled: true,
			mfaVerified: true
		}
	});

	async function createDraft(body: Record<string, unknown>) {
		const res = (await draftsPOST({
			request: new Request('http://localhost/api/drafts', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			}),
			locals: localsFor()
		} as never)) as Response;
		return {
			res,
			body: (await res.json()) as { draft: { id: string; selectedConnectionIds: unknown } }
		};
	}

	async function patchDraft(id: string, body: Record<string, unknown>) {
		const res = (await draftPATCH({
			params: { id },
			request: new Request(`http://localhost/api/drafts/${id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			}),
			locals: localsFor()
		} as never)) as Response;
		return res;
	}

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'selection@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
		connA = newId();
		connB = newId();
		await db.insert(connections).values([
			{
				id: connA,
				userId,
				platform: 'x',
				handle: '@a',
				credentialsEncrypted: '{}',
				metaJson: '{}',
				status: 'active',
				createdAt: now,
				updatedAt: now
			},
			{
				id: connB,
				userId,
				platform: 'mastodon',
				handle: 'b@test',
				credentialsEncrypted: '{}',
				metaJson: '{}',
				status: 'active',
				createdAt: now,
				updatedAt: now
			}
		]);
	});

	afterAll(() => close());

	it('stores the selection when a draft is created', async () => {
		const { res, body } = await createDraft({
			baseBody: 'hello',
			selectedConnectionIds: [connA, connB, connA]
		});
		expect(res.status).toBe(201);
		expect(body.draft.selectedConnectionIds).toEqual([connA, connB]);
	});

	it('stores an explicit empty selection as [] and omits null', async () => {
		const empty = await createDraft({ baseBody: 'none', selectedConnectionIds: [] });
		expect(empty.body.draft.selectedConnectionIds).toEqual([]);
		const omitted = await createDraft({ baseBody: 'legacy' });
		expect(omitted.body.draft.selectedConnectionIds).toBeNull();
	});

	it('accepts more accounts than one publish may target', async () => {
		// Publish caps destinations at 10, but autosaving a larger selection
		// must not fail: the account list itself can be bigger.
		const { res, body } = await createDraft({
			baseBody: 'many',
			selectedConnectionIds: Array.from({ length: 12 }, (_, i) => `conn-${i}`)
		});
		expect(res.status).toBe(201);
		expect(body.draft.selectedConnectionIds).toHaveLength(12);
	});

	it('rejects malformed or oversized selections without creating a draft', async () => {
		const notArray = await createDraft({ baseBody: 'x', selectedConnectionIds: 'nope' });
		expect(notArray.res.status).toBe(400);
		const mixed = await createDraft({ baseBody: 'x', selectedConnectionIds: [1] });
		expect(mixed.res.status).toBe(400);
		const many = await createDraft({
			baseBody: 'x',
			selectedConnectionIds: Array.from({ length: 51 }, (_, i) => `conn-${i}`)
		});
		expect(many.res.status).toBe(400);
		const rows = await db.select().from(drafts).where(eq(drafts.userId, userId));
		expect(rows.some((r) => r.baseBody === 'x')).toBe(false);
	});

	it('updates the selection on PATCH and leaves it alone when omitted', async () => {
		const { body } = await createDraft({ baseBody: 'patch me', selectedConnectionIds: [connA] });
		const id = body.draft.id;
		await patchDraft(id, { selectedConnectionIds: [connB] });
		let [row] = await db.select().from(drafts).where(eq(drafts.id, id));
		expect(row?.selectedConnectionIds).toBe(JSON.stringify([connB]));
		// Body-only autosave must not clobber the stored selection.
		await patchDraft(id, { baseBody: 'patched' });
		[row] = await db.select().from(drafts).where(eq(drafts.id, id));
		expect(row?.selectedConnectionIds).toBe(JSON.stringify([connB]));
		expect(row?.baseBody).toBe('patched');
	});

	it('returns 400 for an invalid PATCH selection and writes nothing', async () => {
		const { body } = await createDraft({ baseBody: 'before', selectedConnectionIds: [connA] });
		const id = body.draft.id;
		const res = await patchDraft(id, { baseBody: 'after', selectedConnectionIds: 'nope' });
		expect(res.status).toBe(400);
		const [row] = await db.select().from(drafts).where(eq(drafts.id, id));
		expect(row?.baseBody).toBe('before');
		expect(row?.selectedConnectionIds).toBe(JSON.stringify([connA]));
	});

	it('exposes the selection on GET and copies it on duplicate', async () => {
		const { body } = await createDraft({ baseBody: 'clone me', selectedConnectionIds: [connA] });
		const id = body.draft.id;
		const getRes = (await draftGET({
			params: { id },
			locals: localsFor()
		} as never)) as Response;
		const getBody = (await getRes.json()) as { draft: { selectedConnectionIds: unknown } };
		expect(getBody.draft.selectedConnectionIds).toEqual([connA]);

		const dupRes = (await duplicatePOST({
			params: { id },
			locals: localsFor()
		} as never)) as Response;
		expect(dupRes.status).toBe(201);
		const dupBody = (await dupRes.json()) as { draft: { selectedConnectionIds: unknown } };
		expect(dupBody.draft.selectedConnectionIds).toEqual([connA]);
	});
});

describe('draft field validation', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;
	let draftId: string;

	async function seed() {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'fields@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
		draftId = newId();
		await db.insert(drafts).values({
			id: draftId,
			userId,
			title: 'kept',
			baseBody: 'original body',
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
	}

	const localsFor = () => ({
		db,
		media: createTestMedia(),
		user: {
			id: userId,
			email: 'fields@localhost',
			timezone: 'UTC',
			totpEnabled: true,
			mfaVerified: true
		}
	});

	function patch(body: string, contentType = 'application/json') {
		return draftPATCH({
			params: { id: draftId },
			request: new Request(`http://localhost/api/drafts/${draftId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': contentType },
				body
			}),
			locals: localsFor()
		} as never) as Promise<Response>;
	}

	it('answers malformed JSON with 400, not 500', async () => {
		await seed();
		const res = await patch('{"baseBody": ');
		expect(res.status).toBe(400);
		const [row] = await db.select().from(drafts).where(eq(drafts.id, draftId));
		expect(row.baseBody).toBe('original body');
		close();
	});

	it('rejects a non-string field instead of binding it to the driver', async () => {
		await seed();
		const res = await patch(JSON.stringify({ title: { evil: true } }));
		expect(res.status).toBe(400);
		const [row] = await db.select().from(drafts).where(eq(drafts.id, draftId));
		expect(row.title).toBe('kept');
		close();
	});

	it('rejects an unbounded body and keeps the stored copy', async () => {
		await seed();
		const res = await patch(JSON.stringify({ baseBody: 'x'.repeat(100_001) }));
		expect(res.status).toBe(400);
		const [row] = await db.select().from(drafts).where(eq(drafts.id, draftId));
		expect(row.baseBody).toBe('original body');
		close();
	});

	it('creates a draft from an empty body and rejects malformed JSON', async () => {
		await seed();
		const post = (body?: string) =>
			draftsPOST({
				request: new Request('http://localhost/api/drafts', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					...(body === undefined ? {} : { body })
				}),
				locals: localsFor()
			} as never) as Promise<Response>;

		// Every field is optional, so no body at all means "create a draft".
		expect((await post()).status).toBe(201);
		expect((await post('{}')).status).toBe(201);
		expect((await post('{"baseBody":')).status).toBe(400);
	});

	it('still accepts a normal patch', async () => {
		await seed();
		const res = await patch(JSON.stringify({ title: '  new title  ', baseBody: 'fresh' }));
		expect(res.status).toBe(200);
		const [row] = await db.select().from(drafts).where(eq(drafts.id, draftId));
		expect(row.title).toBe('new title');
		expect(row.baseBody).toBe('fresh');
		close();
	});
});

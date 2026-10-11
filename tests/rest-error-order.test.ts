import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { connections, drafts, publishTargets, users } from '#lib/server/db/schema.js';
import { createTestDb, createTestMedia, TEST_ENV } from '#lib/server/db/test.js';
import { PATCH as draftPATCH } from '../src/routes/api/drafts/[id]/+server';
import { POST as schedulePOST } from '../src/routes/api/drafts/[id]/schedule/+server';
import { POST as reschedulePOST } from '../src/routes/api/targets/[id]/reschedule/+server';

// A client that sends a bad body to a missing or busy resource learns about the
// resource first: the body is only judged once there is something to apply it to.
describe('REST error precedence over a malformed body', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;
	let busyDraftId: string;
	let cancelledTargetId: string;
	const media = createTestMedia();

	const locals = () => ({
		db,
		env: TEST_ENV,
		media,
		user: {
			id: userId,
			email: 'order@localhost',
			timezone: 'UTC',
			totpEnabled: true,
			mfaVerified: true
		}
	});

	const call = async (handler: (event: never) => unknown, id: string, method: string) => {
		const res = (await handler({
			params: { id },
			request: new Request(`http://localhost/api/x/${id}`, {
				method,
				headers: { 'Content-Type': 'application/json' },
				body: 'not json'
			}),
			locals: locals()
		} as never)) as Response;
		return { status: res.status, body: (await res.json()) as { error: string } };
	};

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'order@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
		const connId = newId();
		await db.insert(connections).values({
			id: connId,
			userId,
			platform: 'x',
			handle: '@order',
			credentialsEncrypted: '{}',
			metaJson: '{}',
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
		busyDraftId = newId();
		const cancelledDraftId = newId();
		await db.insert(drafts).values([
			{
				id: busyDraftId,
				userId,
				baseBody: 'busy',
				status: 'draft',
				createdAt: now,
				updatedAt: now
			},
			{
				id: cancelledDraftId,
				userId,
				baseBody: 'cancelled',
				status: 'draft',
				createdAt: now,
				updatedAt: now
			}
		]);
		cancelledTargetId = newId();
		await db.insert(publishTargets).values([
			{
				id: newId(),
				draftId: busyDraftId,
				connectionId: connId,
				status: 'publishing',
				attemptCount: 1,
				createdAt: now,
				updatedAt: now
			},
			{
				id: cancelledTargetId,
				draftId: cancelledDraftId,
				connectionId: connId,
				status: 'cancelled',
				attemptCount: 0,
				createdAt: now,
				updatedAt: now
			}
		]);
	});

	afterAll(() => close());

	it('PATCH a draft: 404 when missing, 409 while publishing', async () => {
		expect(await call(draftPATCH, newId(), 'PATCH')).toEqual({
			status: 404,
			body: { error: 'Not found' }
		});
		expect(await call(draftPATCH, busyDraftId, 'PATCH')).toEqual({
			status: 409,
			body: { error: 'Publishing in progress — try again shortly' }
		});
	});

	it('schedule a draft: 404 when missing', async () => {
		expect(await call(schedulePOST, newId(), 'POST')).toEqual({
			status: 404,
			body: { error: 'Not found' }
		});
	});

	it('reschedule a delivery: 404 when missing, the cancelled message when cancelled', async () => {
		expect(await call(reschedulePOST, newId(), 'POST')).toEqual({
			status: 404,
			body: { error: 'Not found' }
		});
		expect(await call(reschedulePOST, cancelledTargetId, 'POST')).toEqual({
			status: 400,
			body: { error: 'Cancelled — retry instead' }
		});
	});
});

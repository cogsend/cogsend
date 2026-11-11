import { describe, expect, it } from 'vitest';
import { newId } from '#lib/server/db/client.js';
import { connections, drafts, publishTargets, users } from '#lib/server/db/schema.js';
import { createTestDb } from '#lib/server/db/test.js';
import { loadQueueList, QUEUE_LIST_LIMIT } from '#lib/server/post-list.js';

describe('loadQueueList keeps its id lists inside the D1 cap', () => {
	it('reads a full page of posts that each went to one account', async () => {
		const harness = await createTestDb();
		try {
			const now = Date.now();
			const stamp = { createdAt: new Date(now), updatedAt: new Date(now) };
			const userId = 'cap-user';
			await harness.db.insert(users).values({
				id: userId,
				email: 'cap@localhost',
				passwordHash: 'x',
				timezone: 'UTC',
				...stamp
			});
			const connectionId = newId();
			await harness.db.insert(connections).values({
				id: connectionId,
				userId,
				platform: 'bluesky',
				credentialsEncrypted: 'x',
				status: 'active',
				...stamp
			});
			// One draft per delivery, so the page names as many drafts as it can.
			const draftIds = Array.from({ length: QUEUE_LIST_LIMIT + 5 }, () => newId());
			for (const chunk of [draftIds.slice(0, 50), draftIds.slice(50)]) {
				await harness.db.insert(drafts).values(
					chunk.map((id) => ({
						id,
						userId,
						baseBody: `post ${id}`,
						status: 'published',
						...stamp
					}))
				);
				await harness.db.insert(publishTargets).values(
					chunk.map((draftId, i) => ({
						id: newId(),
						draftId,
						connectionId,
						status: 'published',
						remotePostId: `remote-${draftId}`,
						attemptCount: 1,
						createdAt: new Date(now - i * 1000),
						updatedAt: new Date(now - i * 1000)
					}))
				);
			}
			// Seeding is not what is under test.
			harness.reset();
			const page = await loadQueueList(harness.db, userId);
			expect(page.targets).toHaveLength(QUEUE_LIST_LIMIT);
			expect(page.targets.every((t) => t.draft?.baseBody.startsWith('post '))).toBe(true);
			// D1 refuses a statement with more than 100 bound parameters; the
			// lower bound keeps the probe honest.
			expect(harness.maxParams()).toBeGreaterThan(50);
			expect(harness.maxParams()).toBeLessThanOrEqual(100);
		} finally {
			harness.close();
		}
	});
});

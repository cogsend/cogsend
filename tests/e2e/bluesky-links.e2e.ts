import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { d1, waitForLiveComposer } from './e2e-env';

/**
 * A link on Bluesky counts as the short text Bluesky's own app posts for it, so
 * a post that fits there fits here. Nothing is published.
 */

const PREFIX = 'bluesky-links';
const LINK =
	'https://example.com/blog/2026/11/a-very-long-article-title-that-goes-on?utm_source=newsletter';
const BODY = `${PREFIX} ${'a'.repeat(200)} ${LINK}`;
const connIds: string[] = [];

test.afterEach(() => {
	const ids = connIds.splice(0);
	d1(
		`DELETE FROM drafts WHERE base_body LIKE '${PREFIX}%'` +
			(ids.length
				? `; DELETE FROM connections WHERE id IN (${ids.map((id) => `'${id}'`).join(', ')})`
				: '')
	);
});

/** d1() wraps the SQL in double quotes for the shell, so JSON's own are escaped. */
const sqlJson = (value: unknown) => JSON.stringify(value).replace(/"/g, '\\"');

async function openBlueskyDraft(page: Page, meta: Record<string, unknown>) {
	const me = await page.request.get('/api/auth/me').then((r) => r.json());
	const userId = me.user.id as string;
	const connId = randomUUID();
	const draftId = randomUUID();
	const now = Date.now();
	connIds.push(connId);
	d1(
		`INSERT INTO connections (id, user_id, platform, handle, credentials_encrypted, meta_json, status, created_at, updated_at) VALUES ('${connId}', '${userId}', 'bluesky', 'bl-${connId.slice(0, 8)}', 'enc', '${sqlJson(meta)}', 'active', ${now}, ${now}); ` +
			`INSERT INTO drafts (id, user_id, title, base_body, selected_connection_ids, status, created_at, updated_at) VALUES ('${draftId}', '${userId}', NULL, '${BODY}', '${sqlJson([connId])}', 'draft', ${now}, ${now})`
	);
	await page.goto(`/compose?id=${draftId}`);
	await expect(page.getByTestId('segment-input-0')).toHaveValue(BODY, { timeout: 20000 });
	await waitForLiveComposer(page);
}

test('a direct Bluesky account counts a link as Bluesky posts it', async ({ page }) => {
	await openBlueskyDraft(page, {});
	const shortened = 'example.com/blog/2026/11...';
	const expected = PREFIX.length + 1 + 200 + 1 + shortened.length;
	await expect(page.getByTestId('segment-count-0')).toHaveText(`${expected}/300`);
});

test('a Zernio Bluesky account counts the link as typed', async ({ page }) => {
	await openBlueskyDraft(page, { provider: 'zernio' });
	await expect(page.getByTestId('segment-count-0')).toHaveText(`${BODY.length}/300`);
});

import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { clickUntilVisible, d1, fillUntilKept, waitForLiveComposer } from './e2e-env';

/**
 * Rules the composer holds a post to before it goes out, the same way the
 * publish check does: Threads counts links per post, Mastodon counts the
 * content warning, X takes one cashtag and Instagram 30 hashtags. Publishing
 * and scheduling are refused at the network, so no provider is contacted.
 */

const PREFIX = 'composer-rules';
const connIds: string[] = [];

test.afterEach(() => {
	const ids = connIds.splice(0);
	const drafts = `SELECT id FROM drafts WHERE base_body LIKE '${PREFIX}%'`;
	d1(
		`DELETE FROM draft_variants WHERE draft_id IN (${drafts}); ` +
			`DELETE FROM drafts WHERE base_body LIKE '${PREFIX}%'` +
			(ids.length
				? `; DELETE FROM connections WHERE id IN (${ids.map((id) => `'${id}'`).join(', ')})`
				: '')
	);
});

type Platform = 'threads' | 'mastodon' | 'x' | 'instagram';

/** d1() wraps the SQL in double quotes for the shell, so JSON's own are escaped. */
const sqlJson = (value: unknown) => JSON.stringify(value).replace(/"/g, '\\"');

async function openDraftFor(page: Page, platform: Platform) {
	const me = await page.request.get('/api/auth/me').then((r) => r.json());
	const userId = me.user.id as string;
	const connId = randomUUID();
	connIds.push(connId);
	const draftId = randomUUID();
	const body = `${PREFIX} ${draftId.slice(0, 8)}`;
	const now = Date.now();
	d1(
		`INSERT INTO connections (id, user_id, platform, handle, credentials_encrypted, meta_json, status, created_at, updated_at) VALUES ('${connId}', '${userId}', '${platform}', 'cr-${connId.slice(0, 8)}', 'enc', '{}', 'active', ${now}, ${now}); ` +
			`INSERT INTO drafts (id, user_id, title, base_body, selected_connection_ids, status, created_at, updated_at) VALUES ('${draftId}', '${userId}', NULL, '${body}', '${sqlJson([connId])}', 'draft', ${now}, ${now})`
	);
	const sent: string[] = [];
	await page.route('**/api/drafts/*/{publish,schedule}', async (route) => {
		sent.push(route.request().url());
		await route.abort();
	});
	// The links are made up; a preview card for one has nothing to fetch.
	await page.route('**/api/link-preview**', (route) =>
		route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
	);
	await page.goto(`/compose?id=${draftId}`);
	await expect(page.getByTestId('segment-input-0')).toHaveValue(body, { timeout: 20000 });
	await waitForLiveComposer(page);
	return { body, sent };
}

async function scheduleIsRefused(page: Page, message: string) {
	await clickUntilVisible(
		page,
		page.getByTestId('schedule-toggle'),
		page.getByTestId('schedule-panel')
	);
	await page.getByTestId('schedule-confirm').click();
	await expect(page.getByTestId('publish-toast')).toContainText(message);
}

const links = (prefix: string, n: number) =>
	Array.from({ length: n }, (_, i) => `https://${prefix}${i}.example`).join(' ');

test('Threads takes five links on each post of a thread, not five in all', async ({ page }) => {
	const { body, sent } = await openDraftFor(page, 'threads');
	await fillUntilKept(
		page.getByTestId('segment-input-0'),
		`${body} ${links('one', 5)}\n---\n${links('two', 5)}`
	);
	await page.getByTestId('publish-now').click();
	await expect(page.getByTestId('publish-confirm-destinations')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('publish-confirm-destinations')).toHaveCount(0);

	await fillUntilKept(
		page.getByTestId('segment-input-0'),
		`${body} ${links('one', 6)}\n---\n${links('two', 1)}`
	);
	await page.getByTestId('publish-now').click();
	await expect(page.getByTestId('publish-toast')).toContainText(
		'Threads allows max 5 links per post (6 in one post)'
	);
	await expect(page.getByTestId('publish-confirm-destinations')).toHaveCount(0);
	await scheduleIsRefused(page, 'Threads allows max 5 links per post');
	expect(sent).toEqual([]);
});

test('the Mastodon counter counts the content warning, as the instance does', async ({ page }) => {
	const { body } = await openDraftFor(page, 'mastodon');
	await fillUntilKept(
		page.getByTestId('segment-input-0'),
		`${body} ${'a'.repeat(494 - body.length)}`
	);
	await expect(page.getByTestId('segment-count-0')).toHaveText('495/500');
	await clickUntilVisible(
		page,
		page.getByTestId('post-options-toggle'),
		page.getByTestId('masto-cw')
	);
	await fillUntilKept(page.getByTestId('masto-cw'), 'spoiler');
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('segment-count-0')).toHaveText('503/500');
});

test('X takes one cashtag a post', async ({ page }) => {
	const { body, sent } = await openDraftFor(page, 'x');
	await fillUntilKept(page.getByTestId('segment-input-0'), `${body} $AAPL and $TSLA`);
	await page.getByTestId('publish-now').click();
	await expect(page.getByTestId('publish-toast')).toContainText(
		'X allows max 1 cashtag (e.g. $AAPL) per post'
	);
	await expect(page.getByTestId('publish-confirm-destinations')).toHaveCount(0);
	await scheduleIsRefused(page, 'X allows max 1 cashtag');
	expect(sent).toEqual([]);
});

test('Instagram takes 30 hashtags', async ({ page }) => {
	const { body, sent } = await openDraftFor(page, 'instagram');
	const tags = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(' ');
	await fillUntilKept(page.getByTestId('segment-input-0'), `${body} ${tags}`);
	await page.getByTestId('publish-now').click();
	await expect(page.getByTestId('publish-toast')).toContainText(
		'Instagram takes up to 30 hashtags (31 used)'
	);
	await expect(page.getByTestId('publish-confirm-destinations')).toHaveCount(0);
	await scheduleIsRefused(page, 'Instagram takes up to 30 hashtags');
	expect(sent).toEqual([]);
});

import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { clickUntilVisible, fillUntilKept, waitForLiveComposer, d1 } from './e2e-env';

/**
 * What the composer does once a post is on its way: a new post clears the
 * composer and links to where it went, a post opened from Posts goes back
 * there, and a post that is already published opens read-only. Schedule and
 * publish are answered here, so no provider is contacted; what is under test
 * is the composer's reaction to the answer.
 */

const PREFIX = 'after-post';
const connIds: string[] = [];

/** Leaves the shared e2e database as the other specs expect it: no extra
 *  accounts (smoke checks an empty Accounts page) and no extra posts. */
test.afterEach(() => {
	const ids = connIds.splice(0);
	const drafts = `SELECT id FROM drafts WHERE base_body LIKE '${PREFIX}%'`;
	d1(
		`DELETE FROM publish_targets WHERE draft_id IN (${drafts}); ` +
			`DELETE FROM draft_variants WHERE draft_id IN (${drafts}); ` +
			`DELETE FROM drafts WHERE base_body LIKE '${PREFIX}%'` +
			(ids.length
				? `; DELETE FROM connections WHERE id IN (${ids.map((id) => `'${id}'`).join(', ')})`
				: '')
	);
});

/** One account the composer selects by default; never contacted. */
async function seedAccount(page: Page) {
	const me = await page.request.get('/api/auth/me').then((r) => r.json());
	const userId = me.user.id as string;
	const connId = randomUUID();
	const now = Date.now();
	d1(
		`INSERT INTO connections (id, user_id, platform, handle, credentials_encrypted, meta_json, status, created_at, updated_at) VALUES ('${connId}', '${userId}', 'bluesky', 'after-${connId.slice(0, 8)}.bsky.social', 'enc', '{}', 'active', ${now}, ${now})`
	);
	connIds.push(connId);
	return { userId, connId };
}

/** A post with one target on the seeded account, in the given state. */
async function seedPost(page: Page, state: 'scheduled' | 'published') {
	const { userId, connId } = await seedAccount(page);
	const draftId = randomUUID();
	const body = `${PREFIX} ${state} ${draftId.slice(0, 8)}`;
	const now = Date.now();
	const target =
		state === 'scheduled'
			? `'scheduled', ${now + 2 * 60 * 60 * 1000}, NULL`
			: `'published', NULL, 'remote-${draftId.slice(0, 8)}'`;
	d1(
		`INSERT INTO drafts (id, user_id, title, base_body, status, created_at, updated_at) VALUES ('${draftId}', '${userId}', NULL, '${body}', '${state}', ${now}, ${now}); ` +
			`INSERT INTO publish_targets (id, draft_id, connection_id, status, scheduled_for, remote_post_id, attempt_count, created_at, updated_at) VALUES ('${randomUUID()}', '${draftId}', '${connId}', ${target}, 0, ${now}, ${now})`
	);
	return { draftId, connId, body };
}

/** Answer the composer's schedule request as the server would. */
async function answerSchedule(page: Page) {
	const sent: Array<Record<string, unknown>> = [];
	await page.route('**/api/drafts/*/schedule', async (route) => {
		const body = route.request().postDataJSON();
		sent.push(body);
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ targets: [], scheduledFor: body.runAt, cancelled: [] })
		});
	});
	return sent;
}

async function scheduleFromComposer(page: Page) {
	await clickUntilVisible(
		page,
		page.getByTestId('schedule-toggle'),
		page.getByTestId('schedule-panel')
	);
	await page.getByTestId('schedule-confirm').click();
}

test('scheduling a new post clears the composer and links to it', async ({ page }) => {
	await seedAccount(page);
	const sent = await answerSchedule(page);
	await page.goto('/compose');
	await fillUntilKept(page.getByTestId('segment-input-0'), `${PREFIX} new scheduled`);
	await expect(page).toHaveURL(/\/compose\?id=/, { timeout: 20000 });

	await scheduleFromComposer(page);

	await expect.poll(() => sent.length, { timeout: 20000 }).toBe(1);
	expect(sent[0].cancelOthers).toBe(true);
	await expect(page.getByTestId('publish-toast')).toContainText('Scheduled for');
	await expect(page.getByTestId('toast-action')).toHaveAttribute('href', '/posts?tab=scheduled');
	await expect(page.getByTestId('segment-input-0')).toHaveValue('');
	await expect(page).toHaveURL(/\/compose$/);
	// The cleared post must not be reloaded by the connections refresh.
	await page.waitForTimeout(1500);
	await expect(page.getByTestId('segment-input-0')).toHaveValue('');
});

test('publishing hands the post off, clears the composer at once, and reports back', async ({
	page
}) => {
	const { connId } = await seedAccount(page);
	// The platform's answer is held back: the composer must not wait for it.
	let answer: () => void = () => {};
	const answered = new Promise<void>((resolve) => (answer = resolve));
	await page.route('**/api/drafts/*/publish', async (route) => {
		await answered;
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				results: [{ connectionId: connId, status: 'published', skipped: false }]
			})
		});
	});
	await page.goto('/compose');
	await fillUntilKept(page.getByTestId('segment-input-0'), `${PREFIX} new published`);
	await clickUntilVisible(
		page,
		page.getByRole('button', { name: 'Publish', exact: true }),
		page.getByTestId('publish-confirm-destinations')
	);
	await expect(page.getByTestId('confirm-dialog-ok')).toBeEnabled({ timeout: 20000 });
	await page.getByTestId('confirm-dialog-ok').click();

	await expect(page.getByTestId('publish-confirm-destinations')).toBeHidden();
	await expect(page.getByTestId('segment-input-0')).toHaveValue('');
	await expect(page).toHaveURL(/\/compose$/);
	await expect(page.getByTestId('publish-toast')).toContainText('Publishing to 1 account');
	// The next post can be written while the last one is still going out.
	await fillUntilKept(page.getByTestId('segment-input-0'), `${PREFIX} the next one`);

	answer();
	await expect(page.getByTestId('publish-toast')).toContainText('Published to 1 account');
	await expect(page.getByTestId('toast-action')).toHaveAttribute('href', '/posts?tab=published');
	await expect(page.getByTestId('segment-input-0')).toHaveValue(`${PREFIX} the next one`);
});

test('a post opened from Posts goes back there once scheduled', async ({ page }) => {
	const { draftId, connId } = await seedPost(page, 'scheduled');
	const sent = await answerSchedule(page);
	await page.goto('/posts?tab=scheduled');
	// Posts is server-rendered, so the link can be clicked before hydration: a
	// full page load then, which has no Posts to go back to. Opening the menu
	// proves the app is live.
	await clickUntilVisible(
		page,
		page.getByRole('button', { name: 'Workspace menu' }),
		page.getByRole('menu').first()
	);
	await page.keyboard.press('Escape');
	await expect(page.getByRole('menu')).toHaveCount(0);
	await page.locator(`a[href="/compose?id=${draftId}"]`, { hasText: 'Edit post' }).click();
	await expect(page).toHaveURL(new RegExp(`/compose\\?id=${draftId}$`), { timeout: 20000 });
	await expect(page.getByTestId('segment-input-0')).toHaveValue(/scheduled/, { timeout: 20000 });

	await scheduleFromComposer(page);

	await expect.poll(() => sent.length, { timeout: 20000 }).toBe(1);
	expect(sent[0].connectionIds).toEqual([connId]);
	await expect(page).toHaveURL(/\/posts\?tab=scheduled$/, { timeout: 20000 });
	// It was already scheduled, so this changed its time.
	await expect(page.getByTestId('posts-notice')).toContainText('Rescheduled for');
});

test('a published post opens read-only and can be duplicated', async ({ page }) => {
	const { draftId, body } = await seedPost(page, 'published');
	await page.goto(`/compose?id=${draftId}`);
	await expect(page.getByTestId('published-lock')).toBeVisible();
	await expect(page.getByTestId('segment-input-0')).toHaveValue(body);
	await expect(page.getByTestId('segment-input-0')).toHaveAttribute('readonly', '');
	await expect(page.getByTestId('publish-now')).toHaveCount(0);
	await expect(page.getByTestId('schedule-toggle')).toHaveCount(0);

	// One click once the editor is live: a retried click would make two copies.
	await waitForLiveComposer(page);
	await page.getByTestId('duplicate-published').click();
	await expect(page).not.toHaveURL(new RegExp(draftId), { timeout: 20000 });
	await expect(page).toHaveURL(/\/compose\?id=/);
	await expect(page.getByTestId('published-lock')).toHaveCount(0);
	await expect(page.getByTestId('segment-input-0')).toHaveValue(body);
	await expect(page.getByTestId('publish-now')).toBeVisible();
});

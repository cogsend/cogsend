import { expect, test } from '@playwright/test';
import { clickUntilVisible, d1, fillUntilKept, waitForLiveComposer } from './e2e-env';

/**
 * A draft's preview link, from both ends: the owner makes it in the composer,
 * someone with no session opens it and sees the latest save, and turning it off
 * ends that at once.
 */

const PREFIX = 'share-preview';

test.afterEach(() => {
	const drafts = `SELECT id FROM drafts WHERE base_body LIKE '${PREFIX}%'`;
	d1(
		`DELETE FROM draft_shares WHERE draft_id IN (${drafts}); ` +
			`DELETE FROM drafts WHERE base_body LIKE '${PREFIX}%'`
	);
});

test('a preview link shows the saved draft to anyone until it is turned off', async ({
	page,
	browser
}) => {
	await page.goto('/compose');
	await waitForLiveComposer(page);
	const card = page.getByTestId('segment-input-0');
	await fillUntilKept(card, `${PREFIX} first version`);
	await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 15000 });

	await clickUntilVisible(page, page.getByTestId('share-toggle'), page.getByTestId('share-panel'));
	await page.getByTestId('share-create').click();
	const urlField = page.getByTestId('share-url');
	await expect(urlField).toHaveValue(/\/p\/[0-9a-f]{64}$/, { timeout: 15000 });
	const url = await urlField.inputValue();

	// A stranger: a fresh context carries none of the owner's cookies.
	const stranger = await browser.newContext();
	const viewer = await stranger.newPage();
	const first = await viewer.goto(url);
	expect(first?.status()).toBe(200);
	expect(first?.headers()['x-robots-tag']).toBe('noindex, nofollow');
	await expect(viewer.getByTestId('share-card-0')).toHaveText(`${PREFIX} first version`);
	await expect(viewer.getByText('Compose post')).toHaveCount(0);

	// The owner keeps writing; the next visit shows it.
	await page.keyboard.press('Escape');
	await fillUntilKept(card, `${PREFIX} second version`);
	await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 15000 });
	await viewer.reload();
	await expect(viewer.getByTestId('share-card-0')).toHaveText(`${PREFIX} second version`);

	// Reopening the panel shows the same link rather than making another.
	await clickUntilVisible(page, page.getByTestId('share-toggle'), page.getByTestId('share-panel'));
	await expect(urlField).toHaveValue(url);
	await page.getByTestId('share-revoke').click();
	await expect(page.getByTestId('share-create')).toBeVisible();

	const after = await viewer.reload();
	expect(after?.status()).toBe(404);
	await expect(viewer.getByTestId('share-unavailable')).toBeVisible();
	await expect(viewer.getByText(`${PREFIX} second version`)).toHaveCount(0);
	await stranger.close();
});

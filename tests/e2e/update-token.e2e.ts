import { expect, test, type Page } from '@playwright/test';

/**
 * The update form's two ways in: a remembered token opens with the CogSend
 * password, and a pasted one is remembered unless the box is unticked, in
 * which case nothing but the token is needed. The status is stood in for; the
 * server side is tests/saved-token.test.ts.
 */
async function standIn(page: Page, savedToken: { hint: string; savedAt: number } | null) {
	await page.route('**/api/release*', (route) =>
		route.fulfill({
			json: { current: '1.15.0', latest: null, updateAvailable: false, checkedAt: null }
		})
	);
	await page.route('**/api/update', (route) =>
		route.fulfill({
			json: {
				version: '1.15.0',
				install: 'other',
				github: null,
				target: null,
				savedToken,
				previous: null,
				job: null
			}
		})
	);
}

test('a saved token opens with the password; a new one asks for it only to be remembered', async ({
	page
}) => {
	await standIn(page, { hint: 'abcd', savedAt: Date.now() });
	await page.goto('/settings#instance');
	await page.getByRole('button', { name: 'Install a specific release from here' }).click();
	await expect(page.getByTestId('saved-token')).toContainText('ending abcd');
	await expect(page.getByLabel('Cloudflare API token')).toHaveCount(0);
	await page.getByPlaceholder('v1.13.0').fill('v9.9.9');
	const install = page.getByRole('button', { name: 'Install v9.9.9' });
	await expect(install).toBeDisabled();
	await page.getByLabel('Your CogSend password').fill('hunter2 hunter2');
	await expect(install).toBeEnabled();

	await page.getByRole('button', { name: 'Use a different token' }).click();
	await expect(page.getByLabel('Cloudflare API token')).toBeVisible();
	await expect(page.getByLabel('Remember it for later updates', { exact: false })).toBeChecked();
	await page.getByLabel('Your CogSend password').fill('');
	await page.getByLabel('Cloudflare API token').fill('cf_token_0123456789abcdefghij');
	await expect(install).toBeDisabled();
	await page.getByLabel('Remember it for later updates', { exact: false }).uncheck();
	await expect(page.getByLabel('Your CogSend password')).toHaveCount(0);
	await expect(install).toBeEnabled();
});

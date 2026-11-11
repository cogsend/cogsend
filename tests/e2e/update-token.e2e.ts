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
	await page.goto('/settings/instance');
	await page.getByRole('button', { name: 'Install a specific release from here' }).click();
	await expect(page.getByTestId('saved-token')).toContainText('ending abcd');
	await expect(page.getByLabel('Cloudflare API token')).toHaveCount(0);
	// The button is there from the start, saying what it still needs.
	await expect(page.getByRole('button', { name: 'Install', exact: true })).toBeDisabled();
	await expect(page.getByTestId('update-missing')).toContainText('release tag');
	await page.getByLabel('Release tag').fill('v9.9.9');
	await expect(page.getByTestId('update-missing')).toContainText('password');
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
	await expect(page.getByTestId('update-missing')).toHaveCount(0);

	// Cancel closes the form and drops what was typed.
	await page.getByRole('button', { name: 'Cancel' }).click();
	await expect(page.getByTestId('update-form')).toHaveCount(0);
	await page.getByRole('button', { name: 'Install a specific release from here' }).click();
	await expect(page.getByLabel('Release tag')).toHaveValue('');
});

/** A release on offer, a version to go back to, and optionally an unfinished update. */
async function standInWithOffer(page: Page, job: { tag: string } | null) {
	await page.route('**/api/release*', (route) =>
		route.fulfill({
			json: {
				current: '1.31.0',
				latest: { tag: 'v1.32.0', version: '1.32.0', url: 'https://example.com/notes' },
				updateAvailable: true,
				checkedAt: null
			}
		})
	);
	await page.route('**/api/update', (route) =>
		route.fulfill({
			json: {
				version: '1.31.0',
				install: 'other',
				github: null,
				target: null,
				savedToken: null,
				previous: { version: '1.30.1', replacedBy: '1.31.0', schemaChange: false },
				job: job ? { tag: job.tag, phase: 'upload', expired: false } : null
			}
		})
	);
	await page.goto('/settings/instance');
}

test('an unfinished update is what the form installs until it is finished or aborted', async ({
	page
}) => {
	await standInWithOffer(page, { tag: 'v1.32.0-rc.1' });
	await expect(
		page.getByText('An update to v1.32.0-rc.1 was started and not finished')
	).toBeVisible();
	// Even with a newer release on offer, the server installs nothing else first.
	await page.getByRole('button', { name: 'Update to v1.32.0 from here' }).click();
	await expect(page.getByLabel('Release tag')).toHaveValue('v1.32.0-rc.1');
	await expect(page.getByRole('button', { name: 'Install v1.32.0-rc.1' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Abort the unfinished update' })).toBeVisible();
});

test('switching between rollback and install leaves no typed tag behind', async ({ page }) => {
	await standInWithOffer(page, null);
	await page.getByRole('button', { name: 'Update to v1.32.0 from here' }).click();
	await expect(page.getByText('Installs v1.32.0')).toBeVisible();
	await page.getByRole('button', { name: 'Install a different release' }).click();
	await page.getByLabel('Release tag').fill('v1.31.5');
	await expect(page.getByRole('button', { name: 'Install v1.31.5' })).toBeVisible();

	const more = page.getByText('More options');
	await more.click();
	await page.getByRole('button', { name: 'Roll back to 1.30.1 instead' }).click();
	await expect(
		page.getByRole('button', { name: 'Roll back to 1.30.1', exact: true })
	).toBeVisible();
	await page.getByRole('button', { name: 'Install a release instead' }).click();
	await expect(page.getByText('Installs v1.32.0')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Install v1.32.0' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Install v1.31.5' })).toHaveCount(0);
});

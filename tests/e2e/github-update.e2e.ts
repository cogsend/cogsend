import { expect, test, type Page } from '@playwright/test';
import { E2E_ACCOUNT } from './e2e-env';

/**
 * A Deploy-button install that recorded its GitHub repository updates through
 * that repository's Update CogSend action: Settings links to it first, keeps
 * the token route as an alternative, and stops suggesting that Workers Builds
 * be disconnected. The status and the release are stood in for.
 */
async function signIn(page: Page) {
	await page.goto('/compose');
	if (/\/login$/.test(new URL(page.url()).pathname)) {
		await page.getByLabel('Email').fill(E2E_ACCOUNT.email);
		await page.getByLabel('Password').fill(E2E_ACCOUNT.password);
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page).toHaveURL(/\/compose$/, { timeout: 20000 });
	}
}

function standIn(page: Page, github: { repo: string; branch: string } | null) {
	return Promise.all([
		page.route('**/api/update', (route) =>
			route.fulfill({
				json: {
					version: '1.14.0',
					install: 'button',
					github,
					target: null,
					previous: null,
					job: null
				}
			})
		),
		page.route('**/api/release*', (route) =>
			route.fulfill({
				json: {
					current: '1.14.0',
					latest: { tag: 'v1.14.1', version: '1.14.1', url: 'https://example.com/' },
					updateAvailable: true,
					checkedAt: new Date().toISOString()
				}
			})
		)
	]);
}

test('a button install that knows its repository updates through GitHub', async ({ page }) => {
	await signIn(page);
	await standIn(page, { repo: 'me/my-cogsend', branch: 'main' });
	await page.goto('/settings#instance');

	const block = page.getByTestId('github-update');
	await expect(block).toContainText('me/my-cogsend');
	await expect(block.getByRole('link', { name: 'Update to v1.14.1 on GitHub' })).toHaveAttribute(
		'href',
		'https://github.com/me/my-cogsend/actions/workflows/update.yml'
	);
	const enable = await block
		.getByRole('link', { name: 'Add the Update action to the repository' })
		.getAttribute('href');
	expect(enable).toMatch(/^https:\/\/github\.com\/me\/my-cogsend\/new\/main\?filename=/);
	await expect(page.getByTestId('builds-notice')).toHaveCount(0);
	await expect(
		page.getByRole('button', { name: 'Or update here with a Cloudflare token' })
	).toBeVisible();
});

test('a button install from before 1.14 keeps the token route and the Builds advice', async ({
	page
}) => {
	await signIn(page);
	await standIn(page, null);
	await page.goto('/settings#instance');
	await expect(page.getByRole('button', { name: 'Update to v1.14.1 from here' })).toBeVisible();
	await expect(page.getByTestId('github-update')).toHaveCount(0);
	await expect(page.getByTestId('builds-notice')).toBeVisible();
});

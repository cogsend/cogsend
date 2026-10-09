import { expect, test, type Page } from '@playwright/test';
import { E2E_ACCOUNT } from './e2e-env';

/**
 * A newer release shows as a dot on the avatar until it has been seen, and as a
 * line in the profile menu until it is installed. GitHub is stood in for at
 * /api/release, the one place the browser learns about releases.
 */
function offer(page: Page, tag: string | null) {
	return page.route('**/api/release*', (route) =>
		route.fulfill({
			json: {
				current: '1.13.0',
				latest: tag ? { tag, version: tag.slice(1), url: 'https://example.com/' } : null,
				updateAvailable: tag !== null,
				checkedAt: new Date().toISOString()
			}
		})
	);
}

/** Navigates and waits for the header to have asked about releases. */
async function load(page: Page, go: () => Promise<unknown>) {
	const asked = page.waitForResponse((res) => res.url().includes('/api/release'));
	await go();
	await asked;
}

async function signIn(page: Page) {
	await page.goto('/compose');
	if (/\/login$/.test(new URL(page.url()).pathname)) {
		await page.getByLabel('Email').fill(E2E_ACCOUNT.email);
		await page.getByLabel('Password').fill(E2E_ACCOUNT.password);
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page).toHaveURL(/\/compose$/, { timeout: 20000 });
	}
}

test('a newer release shows in the header until it has been seen', async ({ page }) => {
	await offer(page, null);
	await signIn(page);
	await page.evaluate(() => localStorage.removeItem('cogsend:update-seen'));
	await load(page, () => page.reload());
	await page.getByRole('button', { name: 'Profile menu' }).click();
	await expect(page.getByTestId('update-menu-item')).toHaveCount(0);
	await expect(page.getByTestId('update-dot')).toHaveCount(0);
	await page.keyboard.press('Escape');

	await page.unroute('**/api/release*');
	await offer(page, 'v99.0.0');
	await page.reload();
	await expect(page.getByTestId('update-dot')).toBeVisible();
	await page.getByRole('button', { name: 'Profile menu, update available' }).click();
	await expect(page.getByTestId('update-menu-item')).toHaveText(/v99\.0\.0 is available/);
	await page.getByTestId('update-menu-item').click();
	await expect(page).toHaveURL(/\/settings#instance$/);
	await expect(page.getByTestId('update-dot')).toHaveCount(0);

	// Seen stays seen, but the menu keeps the line until the update is installed.
	await load(page, () => page.goto('/compose'));
	await expect(page.getByTestId('update-dot')).toHaveCount(0);
	await page.getByRole('button', { name: 'Profile menu' }).click();
	await expect(page.getByTestId('update-menu-item')).toBeVisible();
	await page.keyboard.press('Escape');

	// The next release brings the dot back.
	await page.unroute('**/api/release*');
	await offer(page, 'v99.0.1');
	await page.reload();
	await expect(page.getByTestId('update-dot')).toBeVisible();
});

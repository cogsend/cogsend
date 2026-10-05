import { expect, test, type Page } from '@playwright/test';
import { E2E_ACCOUNT } from './e2e-env';

test.beforeEach(async ({ page }) => {
	await page.goto('/compose');
	if (/\/login$/.test(new URL(page.url()).pathname)) {
		await page.getByLabel('Email').fill(E2E_ACCOUNT.email);
		await page.getByLabel('Password').fill(E2E_ACCOUNT.password);
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page).toHaveURL(/\/compose$/, { timeout: 20000 });
	}
});

async function storedBody(page: Page): Promise<string | undefined> {
	const id = new URL(page.url()).searchParams.get('id');
	if (!id) return undefined;
	const res = await page.request.get(`/api/drafts/${id}`);
	return (await res.json()).draft?.baseBody;
}

/**
 * Loads the composer on a paused clock: the autosave runs only when a test
 * advances time, and a failed save is never retried behind its back.
 */
async function composeOnPausedClock(page: Page) {
	await page.clock.install();
	await page.goto('/compose');
	await page.clock.pauseAt(Date.now() + 60_000);
}

test('the composer says when a draft is saved, and when it is not', async ({ page }) => {
	await composeOnPausedClock(page);
	const status = page.getByTestId('save-status');
	// An empty new draft is never saved, so there is nothing to report.
	await expect(status).toHaveCount(0);

	await page.route('**/api/drafts', (route) =>
		route.request().method() === 'POST'
			? route.fulfill({
					status: 500,
					contentType: 'application/json',
					body: JSON.stringify({ error: 'Database unavailable' })
				})
			: route.continue()
	);
	await page.getByTestId('segment-input-0').fill('save status probe');
	await expect(status).toHaveText('Saving…');
	await page.clock.runFor(2000);
	await expect(status).toContainText('Not saved', { timeout: 15000 });

	await page.unroute('**/api/drafts');
	await status.getByRole('button', { name: 'Retry' }).click();
	await expect(status).toHaveText('Saved', { timeout: 15000 });
	await expect.poll(() => storedBody(page), { timeout: 15000 }).toBe('save status probe');
});

test('hiding the page saves the draft without waiting for the autosave', async ({ page }) => {
	await composeOnPausedClock(page);
	await page.getByTestId('segment-input-0').fill('saved when hidden');
	await page.evaluate(() => {
		Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
		document.dispatchEvent(new Event('visibilitychange'));
	});
	await expect.poll(() => storedBody(page), { timeout: 15000 }).toBe('saved when hidden');
});

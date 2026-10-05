import { expect, test } from '@playwright/test';
import { E2E_ACCOUNT, waitForLiveComposer } from './e2e-env';

test.beforeEach(async ({ page }) => {
	await page.goto('/compose');
	if (/\/login$/.test(new URL(page.url()).pathname)) {
		await page.getByLabel('Email').fill(E2E_ACCOUNT.email);
		await page.getByLabel('Password').fill(E2E_ACCOUNT.password);
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page).toHaveURL(/\/compose$/, { timeout: 20000 });
	}
});

/**
 * An id the server does not know. Compose server-renders the draft named in
 * `?id=`, so this leaves the editor empty on first paint and the client fetch
 * runs — the load these tests race. Route handlers answer in its place.
 */
const MISS_ID = '00000000-0000-4000-8000-000000000000';

test('typing keeps focus when first autosave assigns the draft id', async ({ page }) => {
	await page.goto('/compose');
	expect(new URL(page.url()).searchParams.get('id')).toBeNull();
	await waitForLiveComposer(page);
	const box = page.getByTestId('segment-input-0');
	await box.click();
	await box.pressSequentially('hello focus probe', { delay: 20 });
	// First autosave (~1.4s debounce) creates the draft and sets ?id=.
	await expect
		.poll(() => new URL(page.url()).searchParams.get('id'), { timeout: 30000 })
		.toBeTruthy();
	// The reported bug: URL change stole focus and forced a second click.
	await expect(box).toBeFocused();
	await expect(box).toHaveValue('hello focus probe');
});

test('typing during a slow draft load is kept and saved', async ({ page }) => {
	// Save a draft with known content first.
	await page.goto('/compose');
	await waitForLiveComposer(page);
	const box = page.getByTestId('segment-input-0');
	await box.click();
	await box.pressSequentially('saved content', { delay: 10 });
	await expect
		.poll(() => new URL(page.url()).searchParams.get('id'), { timeout: 30000 })
		.toBeTruthy();
	const id = new URL(page.url()).searchParams.get('id')!;
	const stored = async () => {
		const res = await page.request.get(`/api/drafts/${id}`);
		const body = await res.json();
		return body.draft?.baseBody;
	};
	await expect.poll(stored, { timeout: 30000 }).toBe('saved content');
	// Let the autosave debounce settle so nothing is still in flight.
	await page.waitForTimeout(2000);

	// Re-open it with a deliberately slow client load and type while it is in
	// flight. The stored copy must not replace those keystrokes (and the
	// autosave must not strand them in a second draft).
	const draftBody = await (await page.request.get(`/api/drafts/${id}`)).text();
	await page.route(`**/api/drafts/${MISS_ID}`, async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 2000));
		await route.fulfill({ status: 200, contentType: 'application/json', body: draftBody });
	});
	await page.goto(`/compose?id=${MISS_ID}`);
	await waitForLiveComposer(page);
	const box2 = page.getByTestId('segment-input-0');
	await box2.click();
	await box2.pressSequentially('typed while loading', { delay: 10 });
	await page.waitForTimeout(3000);
	await expect(box2).toHaveValue('typed while loading');
	await page.unroute(`**/api/drafts/${MISS_ID}`);
	await expect.poll(stored, { timeout: 30000 }).toBe('typed while loading');
});

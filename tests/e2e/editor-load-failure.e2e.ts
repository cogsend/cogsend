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
 * `?id=`, so this leaves the editor empty and makes the client fetch the load
 * under test; the route handler then answers in place of the API. This is the
 * only way left to reach the editor's client-side load path on a fresh mount.
 */
const MISS_ID = '00000000-0000-4000-8000-000000000000';

/** Save a draft through the editor and return its id plus a reader for its body. */
async function seedDraft(page: import('@playwright/test').Page, text: string) {
	await page.goto('/compose');
	await waitForLiveComposer(page);
	const box = page.getByTestId('segment-input-0');
	await box.click();
	await box.pressSequentially(text, { delay: 10 });
	await expect
		.poll(() => new URL(page.url()).searchParams.get('id'), { timeout: 30000 })
		.toBeTruthy();
	const id = new URL(page.url()).searchParams.get('id')!;
	const stored = async () => {
		const res = await page.request.get(`/api/drafts/${id}`);
		const body = (await res.json()) as { draft?: { baseBody?: string } };
		return body.draft?.baseBody;
	};
	await expect.poll(stored, { timeout: 30000 }).toBe(text);
	// Let the autosave debounce settle so nothing is still in flight.
	await page.waitForTimeout(2000);
	await expect.poll(stored, { timeout: 30000 }).toBe(text);
	return { id, stored };
}

/**
 * A draft whose fetch fails used to leave `savedSnapshot` unset, which the
 * autosave effect treated as "nothing saved yet" and baselined the *empty*
 * editor. The first keystroke then PATCHed that empty body over the stored
 * draft. The handler now refuses to save until the stored copy arrives, says
 * so, and resumes saving once it does.
 */
test('a draft that fails to load is never overwritten, and retry recovers it', async ({ page }) => {
	const { id, stored } = await seedDraft(page, 'stored copy');
	const draftBody = await (await page.request.get(`/api/drafts/${id}`)).text();

	// Answer the client fetch with the real draft, failing the first read.
	let failing = true;
	await page.route(`**/api/drafts/${MISS_ID}`, async (route) => {
		if (route.request().method() !== 'GET') {
			await route.continue();
			return;
		}
		if (failing) {
			await route.fulfill({
				status: 500,
				contentType: 'application/json',
				body: '{"error":"boom"}'
			});
			return;
		}
		await route.fulfill({ status: 200, contentType: 'application/json', body: draftBody });
	});
	await page.goto(`/compose?id=${MISS_ID}`);
	const box = page.getByTestId('segment-input-0');
	await expect(box).toBeVisible({ timeout: 20000 });

	// The whole point: typing must not autosave over the draft that never loaded.
	await box.click();
	await box.pressSequentially('typed into a draft that never loaded', { delay: 10 });
	// Past the 1.4s autosave debounce with room for a slow local D1 write.
	await page.waitForTimeout(4500);
	expect(await stored()).toBe('stored copy');
	// …and the editor explains why nothing is being saved.
	const banner = page.getByTestId('draft-load-error');
	await expect(banner).toBeVisible({ timeout: 20000 });

	// Retry loads it: the notice clears and the stored copy is what it shows.
	failing = false;
	await page.getByRole('button', { name: 'Retry' }).click();
	await expect(banner).toBeHidden({ timeout: 20000 });
	await expect(box).toHaveValue('stored copy');

	// Saving is really back on, not merely unblocked: the next edit persists.
	await box.click();
	await box.press('ControlOrMeta+a');
	await box.pressSequentially('edited after retry', { delay: 10 });
	await expect.poll(stored, { timeout: 30000 }).toBe('edited after retry');
});

/**
 * Same-route navigation is where a stale failure used to leak: the editor
 * component stays mounted, so `draftId` and the failure flag survived the move
 * to a fresh compose — the new post could not autosave, and a later retry
 * pointed the next keystroke at the old draft.
 */
test('leaving a failed draft starts a clean composer', async ({ page }) => {
	const { id, stored } = await seedDraft(page, 'draft A body');

	await page.route(`**/api/drafts/${MISS_ID}`, async (route) => {
		if (route.request().method() === 'GET') {
			await route.abort('failed');
			return;
		}
		await route.continue();
	});
	await page.goto(`/compose?id=${MISS_ID}`);
	await expect(page.getByTestId('draft-load-error')).toBeVisible({ timeout: 20000 });

	// Workspace menu → Compose is a client-side navigation to the same route.
	await page.getByRole('button', { name: 'Workspace menu' }).click();
	await page.getByRole('menuitem', { name: 'Compose' }).click();
	await expect(page.getByTestId('draft-load-error')).toBeHidden({ timeout: 20000 });

	await page.unroute(`**/api/drafts/${MISS_ID}`);
	const box = page.getByTestId('segment-input-0');
	await expect(box).toHaveValue('');
	await box.click();
	await box.pressSequentially('fresh post', { delay: 10 });

	// The new post gets its own draft, and draft A is untouched.
	await expect
		.poll(() => new URL(page.url()).searchParams.get('id'), { timeout: 30000 })
		.not.toBe(id);
	expect(await stored()).toBe('draft A body');
});

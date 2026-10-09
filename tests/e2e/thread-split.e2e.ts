import { expect, test, type Page } from '@playwright/test';
import { E2E_ACCOUNT, waitForLiveComposer } from './e2e-env';

/** A 1×1 PNG: enough for the upload route's type sniffing. */
const DOT_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64'
);

test.beforeEach(async ({ page }) => {
	await page.goto('/compose');
	if (/\/login$/.test(new URL(page.url()).pathname)) {
		await page.getByLabel('Email').fill(E2E_ACCOUNT.email);
		await page.getByLabel('Password').fill(E2E_ACCOUNT.password);
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page).toHaveURL(/\/compose$/, { timeout: 20000 });
	}
});

async function storedDraft(page: Page) {
	await expect
		.poll(() => new URL(page.url()).searchParams.get('id'), { timeout: 30000 })
		.toBeTruthy();
	const id = new URL(page.url()).searchParams.get('id')!;
	return async () => {
		const res = await page.request.get(`/api/drafts/${id}`);
		return (await res.json()).draft as {
			baseBody: string;
			media: Array<{ segmentIndex: number }>;
		};
	};
}

test('typing several markers keeps every piece as its own card', async ({ page }) => {
	await page.goto('/compose');
	await waitForLiveComposer(page);
	await page.getByTestId('segment-input-0').fill('one --- two --- three');

	await expect(page.getByTestId('segment-input-0')).toHaveValue('one');
	await expect(page.getByTestId('segment-input-1')).toHaveValue('two');
	await expect(page.getByTestId('segment-input-2')).toHaveValue('three');

	const draft = await storedDraft(page);
	await expect
		.poll(async () => (await draft()).baseBody, { timeout: 30000 })
		.toBe('one\n---\ntwo\n---\nthree');
});

test('an image stays with its post when an earlier card is split', async ({ page }) => {
	await page.goto('/compose');
	await waitForLiveComposer(page);
	await page.getByTestId('segment-input-0').fill('first ---second');
	await expect(page.getByTestId('segment-input-1')).toHaveValue('second');
	const draft = await storedDraft(page);
	await expect
		.poll(async () => (await draft()).baseBody, { timeout: 30000 })
		.toBe('first\n---\nsecond');

	await page
		.getByTestId('file-input-1')
		.setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: DOT_PNG });
	await expect
		.poll(async () => (await draft()).media.map((m) => m.segmentIndex), { timeout: 30000 })
		.toEqual([1]);

	// A new card lands before the one holding the image.
	await page.getByTestId('segment-input-0').fill('first ---split');
	await expect(page.getByTestId('segment-input-2')).toHaveValue('second');

	await expect
		.poll(async () => (await draft()).media.map((m) => m.segmentIndex), { timeout: 30000 })
		.toEqual([2]);
	expect((await draft()).baseBody).toBe('first\n---\nsplit\n---\nsecond');
	await expect(page.getByText('Couldn’t save the image layout')).toHaveCount(0);
});

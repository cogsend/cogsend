import { expect, test, type Page } from '@playwright/test';
import { E2E_ACCOUNT, waitForLiveComposer } from './e2e-env';

/** A 1×1 PNG: enough for the upload route's type sniffing. */
const DOT_PNG_B64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const DOT_PNG = Buffer.from(DOT_PNG_B64, 'base64');
const dot = (n: number) => ({ name: `dot-${n}.png`, mimeType: 'image/png', buffer: DOT_PNG });

test.beforeEach(async ({ page }) => {
	await page.goto('/compose');
	if (/\/login$/.test(new URL(page.url()).pathname)) {
		await page.getByLabel('Email').fill(E2E_ACCOUNT.email);
		await page.getByLabel('Password').fill(E2E_ACCOUNT.password);
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page).toHaveURL(/\/compose$/, { timeout: 20000 });
	}
});

/** The draft open in the composer, read back from the server. */
async function storedDraft(page: Page) {
	await expect
		.poll(() => new URL(page.url()).searchParams.get('id'), { timeout: 30000 })
		.toBeTruthy();
	const id = new URL(page.url()).searchParams.get('id')!;
	return async () => {
		const res = await page.request.get(`/api/drafts/${id}`);
		return (await res.json()).draft.media as Array<{ id: string; storageKey: string }>;
	};
}

/**
 * Drag events as the browser sends them, carrying a file or text. Answers
 * whether a handler took the drop (called preventDefault).
 */
function drag(
	page: Page,
	selector: string,
	type: 'dragover' | 'drop',
	carrying: { file: string } | { text: string }
) {
	return page.evaluate(
		({ selector, type, carrying }) => {
			const dt = new DataTransfer();
			if ('file' in carrying) {
				const bytes = Uint8Array.from(atob(carrying.file), (c) => c.charCodeAt(0));
				dt.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }));
			} else {
				dt.setData('text/plain', carrying.text);
			}
			const target = document.querySelector(selector)!;
			const event = new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true });
			target.dispatchEvent(event);
			return event.defaultPrevented;
		},
		{ selector, type, carrying }
	);
}

test('a file dropped anywhere on a card attaches, and one dropped beside it is ignored', async ({
	page
}) => {
	await waitForLiveComposer(page);
	await page.getByTestId('segment-input-0').fill('dropped on the card');
	const media = await storedDraft(page);
	const card = page.getByTestId('segment-card-0');
	const file = { file: DOT_PNG_B64 };

	// Text being dragged is left to the browser.
	expect(await drag(page, '[data-testid="segment-card-0"]', 'dragover', { text: 'hi' })).toBe(
		false
	);
	await expect(card).not.toHaveAttribute('data-drop-target');

	// A file over the card lights it up; dropped on the card, not the text box, it attaches.
	expect(await drag(page, '[data-testid="segment-card-0"]', 'dragover', file)).toBe(true);
	await expect(card).toHaveAttribute('data-drop-target');
	await expect(card.getByText('Drop to attach')).toBeVisible();
	expect(await drag(page, '[data-testid="segment-card-0"]', 'drop', file)).toBe(true);
	await expect(card).not.toHaveAttribute('data-drop-target');
	await expect(page.getByTestId('segment-media-0')).toBeVisible();
	await expect.poll(async () => (await media()).length, { timeout: 30000 }).toBe(1);

	// Beside the cards, the browser is kept from opening the file in this tab.
	expect(await drag(page, 'body', 'dragover', file)).toBe(true);
	expect(await drag(page, 'body', 'drop', file)).toBe(true);
	await expect(page).toHaveURL(/\/compose\?id=/);
	expect(await media()).toHaveLength(1);
});

test('picking more images than fit attaches the ones that fit', async ({ page }) => {
	await waitForLiveComposer(page);
	await page.getByTestId('segment-input-0').fill('five picked, four fit');
	const media = await storedDraft(page);
	const input = page.getByTestId('file-input-0');

	await input.setInputFiles([1, 2, 3, 4, 5].map(dot));
	await expect(
		page.getByText('4 images attached · 1 left out, a post takes 4').first()
	).toBeVisible({
		timeout: 30000
	});
	await expect.poll(async () => (await media()).length, { timeout: 30000 }).toBe(4);

	// A full card says so before uploading anything.
	await input.setInputFiles([dot(6)]);
	await expect(
		page.getByText('This post already has 4 images', { exact: true }).first()
	).toBeVisible();
	expect(await media()).toHaveLength(4);

	// Your media says why nothing can be picked, on the card and on a tap.
	const [first] = await media();
	await page.getByTestId('library-0').click();
	const library = page.getByTestId('media-library');
	await expect(library.getByTestId('media-library-card-notice')).toHaveText(
		'This post already has 4 images. Remove one to attach another.'
	);
	const tile = library.locator(`[data-key="${first.storageKey}"]`);
	await expect(tile).toHaveAttribute('aria-disabled', 'true');
	await tile.click({ force: true });
	await expect(tile).toHaveAttribute('aria-pressed', 'false');
	await expect(library.getByTestId('media-library-notice')).toHaveText('This post is full');
	await library.getByRole('button', { name: 'Cancel' }).click();
	await expect(library).toHaveCount(0);
});

test('Your media can try again after a failed load', async ({ page }) => {
	await waitForLiveComposer(page);
	await page.getByTestId('segment-input-0').fill('your media retry');
	await storedDraft(page);
	let failures = 0;
	await page.route(
		(url) => url.pathname === '/api/media',
		async (route) => {
			if (failures++ === 0) {
				await route.fulfill({ status: 500, json: { error: 'Could not load your media' } });
			} else {
				await route.continue();
			}
		}
	);

	await page.getByTestId('library-0').click();
	const library = page.getByTestId('media-library');
	await expect(library.getByText('Could not load your media')).toBeVisible();
	await library.getByTestId('media-library-retry').click();
	await expect(library.getByTestId('media-library-retry')).toHaveCount(0);
	// Earlier specs attached files, and a fresh shard still has this list's empty state.
	await expect(
		library
			.getByTestId('media-library-file')
			.first()
			.or(library.getByText('Nothing here yet', { exact: false }))
	).toBeVisible();
	await page.unroute((url) => url.pathname === '/api/media');
	await library.getByRole('button', { name: 'Cancel' }).click();
});

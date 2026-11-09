import { expect, test, type Page } from '@playwright/test';
import { buildMp4 } from '../mp4-fixture';
import { E2E_ACCOUNT, attachUntilAnswered, waitForLiveComposer } from './e2e-env';

/** A 1×1 PNG: enough for the upload route's type sniffing. */
const DOT_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64'
);

type StoredMedia = {
	id: string;
	storageKey: string;
	mime: string;
	altText: string | null;
	segmentIndex: number;
};

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
	return {
		id,
		media: async () => {
			const res = await page.request.get(`/api/drafts/${id}`);
			return (await res.json()).draft.media as StoredMedia[];
		}
	};
}

async function writeAlt(page: Page, mediaId: string, text: string) {
	await page.getByTestId(`alt-toggle-${mediaId}`).click();
	await page.getByTestId(`media-alt-${mediaId}`).fill(text);
	await page.getByTestId(`alt-done-${mediaId}`).click();
}

test('an image from one post can be attached to another from Your media', async ({ page }) => {
	await page.goto('/compose');
	await waitForLiveComposer(page);
	await page.getByTestId('segment-input-0').fill('your media source');
	const source = await storedDraft(page);
	await attachUntilAnswered(
		page.getByTestId('file-input-0'),
		{ name: 'dot.png', mimeType: 'image/png', buffer: DOT_PNG },
		page.getByTestId('segment-media-0')
	);
	await expect.poll(async () => (await source.media()).length, { timeout: 30000 }).toBe(1);
	const [original] = await source.media();
	await writeAlt(page, original.id, 'a single dot');
	await expect
		.poll(async () => (await source.media())[0].altText, { timeout: 30000 })
		.toBe('a single dot');

	await page.goto('/compose');
	await waitForLiveComposer(page);
	await page.getByTestId('segment-input-0').fill('your media copy');
	const copy = await storedDraft(page);
	expect(copy.id).not.toBe(source.id);

	await page.getByTestId('library-0').click();
	const library = page.getByTestId('media-library');
	await expect(library).toBeVisible();
	const tile = library.locator(`[data-key="${original.storageKey}"]`);
	await expect(tile).toHaveAttribute('aria-label', 'a single dot');
	await tile.click();
	await expect(tile).toHaveAttribute('aria-pressed', 'true');
	await library.getByTestId('media-library-attach').click();
	await expect(library).toHaveCount(0);
	await expect(page.getByTestId('segment-media-0')).toBeVisible();

	await expect
		.poll(async () => (await copy.media()).map((m) => [m.storageKey, m.altText, m.segmentIndex]))
		.toEqual([[original.storageKey, 'a single dot', 0]]);

	// Alt text belongs to each post.
	const [attached] = await copy.media();
	await writeAlt(page, attached.id, 'the dot again');
	await expect
		.poll(async () => (await copy.media())[0].altText, { timeout: 30000 })
		.toBe('the dot again');
	expect((await source.media())[0].altText).toBe('a single dot');

	// A shared file shows the alt text it was last given.
	await page.getByTestId('library-0').click();
	await expect(tile).toHaveAttribute('aria-label', 'the dot again');
	await library.getByRole('button', { name: 'Cancel' }).click();
	await expect(library).toHaveCount(0);
});

test('a video from Your media goes on a card of its own', async ({ page }) => {
	await page.goto('/compose');
	await waitForLiveComposer(page);
	await page.getByTestId('segment-input-0').fill('your media video source');
	const source = await storedDraft(page);
	await attachUntilAnswered(
		page.getByTestId('file-input-0'),
		{ name: 'clip.mp4', mimeType: 'video/mp4', buffer: Buffer.from(buildMp4()) },
		page.getByTestId('segment-media-0').locator('[data-testid^="media-play-"]')
	);
	await expect.poll(async () => (await source.media()).length, { timeout: 30000 }).toBe(1);
	const [video] = await source.media();

	await page.goto('/compose');
	await waitForLiveComposer(page);
	await page.getByTestId('segment-input-0').fill('your media video copy');
	const copy = await storedDraft(page);
	await page.getByTestId('library-0').click();
	const library = page.getByTestId('media-library');
	const tile = library.locator(`[data-key="${video.storageKey}"]`);
	await tile.click();
	await library.getByTestId('media-library-attach').click();
	await expect(library).toHaveCount(0);
	await expect(page.getByText('Video attached')).toBeVisible();
	await expect(
		page.getByTestId('segment-media-0').locator('[data-testid^="media-play-"]')
	).toBeVisible();
	await expect
		.poll(async () => (await copy.media()).map((m) => [m.storageKey, m.mime]))
		.toEqual([[video.storageKey, 'video/mp4']]);

	// Nothing else goes beside it.
	await page.getByTestId('library-0').click();
	await expect(tile).toBeDisabled();
	await expect(tile).toHaveAttribute('aria-label', /This post has a video, which goes on its own/);
	await library.getByRole('button', { name: 'Cancel' }).click();
	await expect(library).toHaveCount(0);
});

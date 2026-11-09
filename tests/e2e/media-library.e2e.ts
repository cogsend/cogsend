import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { buildMp4 } from '../mp4-fixture';
import { E2E_ACCOUNT, attachUntilAnswered, waitForLiveComposer } from './e2e-env';

/** A 1×1 PNG: enough for the upload route's type sniffing. */
const DOT_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64'
);

/** A gradient PNG large enough that the composer makes it a thumbnail. */
function gradientPng(width: number, height: number): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([length, body, crc]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 2, 0, 0, 0], 8);
	const rows = Buffer.alloc((width * 3 + 1) * height);
	for (let y = 0; y < height; y++) {
		const row = y * (width * 3 + 1);
		for (let x = 0; x < width; x++) {
			rows.set([x % 256, y % 256, (x * y) % 256], row + 1 + x * 3);
		}
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(rows)),
		chunk('IEND', Buffer.alloc(0))
	]);
}

type StoredMedia = {
	id: string;
	storageKey: string;
	mime: string;
	altText: string | null;
	segmentIndex: number;
	meta: { thumb?: { v: number } } | null;
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

test('Your media shows a small copy, and an image opens whole from its post', async ({ page }) => {
	await page.goto('/compose');
	await waitForLiveComposer(page);
	await page.getByTestId('segment-input-0').fill('thumbnail and viewer');
	const draft = await storedDraft(page);
	const card = page.getByTestId('segment-media-0');
	await attachUntilAnswered(
		page.getByTestId('file-input-0'),
		{ name: 'wide.png', mimeType: 'image/png', buffer: gradientPng(900, 600) },
		card
	);
	await expect.poll(async () => (await draft.media()).length, { timeout: 30000 }).toBe(1);
	const [wide] = await draft.media();
	const v = wide.meta?.thumb?.v;
	expect(v).toBeTruthy();
	await attachUntilAnswered(
		page.getByTestId('file-input-0'),
		{ name: 'dot.png', mimeType: 'image/png', buffer: DOT_PNG },
		card.locator('[data-testid^="media-view-"]').nth(1)
	);
	await expect.poll(async () => (await draft.media()).length, { timeout: 30000 }).toBe(2);
	const dot = (await draft.media()).find((m) => m.id !== wide.id)!;
	// Too small for a thumbnail: Your media shows it as the composer does.
	expect(dot.meta?.thumb).toBeUndefined();
	await writeAlt(page, wide.id, 'a wide gradient');
	await expect
		.poll(async () => (await draft.media()).find((m) => m.id === wide.id)?.altText, {
			timeout: 30000
		})
		.toBe('a wide gradient');

	await page.getByTestId('library-0').click();
	const library = page.getByTestId('media-library');
	const tile = library.locator(`[data-key="${wide.storageKey}"] img`);
	await expect(tile).toHaveAttribute('src', `/api/media/${wide.storageKey}?thumb=${v}`);
	const thumb = await page.request.get(`/api/media/${wide.storageKey}?thumb=${v}`);
	expect(thumb.headers()['content-type']).toBe('image/jpeg');
	expect((await thumb.body()).length).toBeLessThan(200_000);
	await library.getByRole('button', { name: 'Cancel' }).click();
	await expect(library).toHaveCount(0);

	const opener = page.getByTestId(`media-view-${wide.id}`);
	await opener.click();
	const viewer = page.getByTestId('media-viewer');
	await expect(viewer).toBeVisible();
	await expect(page.getByTestId('media-viewer-count')).toHaveText('1 / 2');
	await expect(page.getByTestId('media-viewer-alt')).toHaveText('a wide gradient');
	await page.keyboard.press('ArrowRight');
	await expect(page.getByTestId('media-viewer-count')).toHaveText('2 / 2');
	await expect(page.getByTestId('media-viewer-alt')).toHaveCount(0);
	await page.getByTestId('media-viewer-next').click();
	await expect(page.getByTestId('media-viewer-count')).toHaveText('1 / 2');
	await page.keyboard.press('Escape');
	await expect(viewer).toHaveCount(0);
	await expect(opener).toBeFocused();

	// A click beside the picture closes it too.
	await opener.click();
	await expect(viewer).toBeVisible();
	await page.mouse.click(8, 8);
	await expect(viewer).toHaveCount(0);

	// The buttons over the image still do their own thing.
	await page.getByTestId(`alt-toggle-${wide.id}`).click();
	await expect(page.getByTestId(`media-alt-${wide.id}`)).toHaveValue('a wide gradient');
	await expect(viewer).toHaveCount(0);
	await page.getByTestId(`alt-done-${wide.id}`).click();
});

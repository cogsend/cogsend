import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { E2E_ACCOUNT, d1, waitForLiveComposer } from './e2e-env';

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
			media: Array<{
				segmentIndex: number;
				storageKey: string;
				meta: { preview?: { v: number }; jpeg?: { v: number } } | null;
			}>;
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

test('a large image is shown from a lighter copy and published from the original', async ({
	page
}) => {
	await page.goto('/compose');
	await waitForLiveComposer(page);
	await page.getByTestId('segment-input-0').fill('preview probe');
	const draft = await storedDraft(page);
	await expect.poll(async () => (await draft()).baseBody, { timeout: 30000 }).toBe('preview probe');

	// A photo-like PNG, too big to show as it is: a gradient with grain.
	const base64 = await page.evaluate(async () => {
		const canvas = document.createElement('canvas');
		canvas.width = 2000;
		canvas.height = 1500;
		const ctx = canvas.getContext('2d')!;
		const pixels = ctx.createImageData(canvas.width, canvas.height);
		for (let i = 0; i < pixels.data.length; i += 4) {
			const p = i / 4;
			const grain = Math.random() * 8;
			pixels.data[i] = ((p % 2000) / 8 + grain) | 0;
			pixels.data[i + 1] = (Math.floor(p / 2000) / 6 + grain) | 0;
			pixels.data[i + 2] = (128 + grain) | 0;
			pixels.data[i + 3] = 255;
		}
		ctx.putImageData(pixels, 0, 0);
		const blob = await new Promise<Blob>((resolve) =>
			canvas.toBlob((b) => resolve(b!), 'image/png')
		);
		const url = await new Promise<string>((resolve) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result));
			reader.readAsDataURL(blob);
		});
		return url.slice(url.indexOf(',') + 1);
	});
	await page.getByTestId('file-input-0').setInputFiles({
		name: 'photo.png',
		mimeType: 'image/png',
		buffer: Buffer.from(base64, 'base64')
	});

	await expect
		.poll(async () => (await draft()).media[0]?.meta?.preview?.v ?? null, { timeout: 30000 })
		.not.toBeNull();
	const [item] = (await draft()).media;
	const shown = page.getByTestId('segment-media-0').locator('img').first();
	await expect(shown).toHaveAttribute('src', new RegExp(`\\?preview=${item.meta!.preview!.v}$`));
	await expect.poll(() => shown.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1280);

	const preview = await page.request.get(`/api/media/${item.storageKey}?preview=1`);
	const original = await page.request.get(`/api/media/${item.storageKey}`);
	expect(preview.headers()['content-type']).toBe('image/jpeg');
	expect((await preview.body()).length).toBeLessThan((await original.body()).length);
});

const IG_PREFIX = 'ig probe';
const igConnIds: string[] = [];

/** No extra accounts or posts are left behind: smoke checks an empty Accounts page. */
test.afterEach(() => {
	const ids = igConnIds.splice(0);
	if (!ids.length) return;
	const drafts = `SELECT id FROM drafts WHERE base_body LIKE '${IG_PREFIX}%'`;
	d1(
		`DELETE FROM draft_media WHERE draft_id IN (${drafts}); ` +
			`DELETE FROM drafts WHERE base_body LIKE '${IG_PREFIX}%'; ` +
			`DELETE FROM connections WHERE id IN (${ids.map((id) => `'${id}'`).join(', ')})`
	);
});

/** An Instagram account the composer selects by default; never contacted. */
async function seedInstagram(page: Page) {
	const me = await page.request.get('/api/auth/me').then((r) => r.json());
	const connId = randomUUID();
	const now = Date.now();
	d1(
		`INSERT INTO connections (id, user_id, platform, handle, credentials_encrypted, meta_json, status, created_at, updated_at) VALUES ('${connId}', '${me.user.id}', 'instagram', 'ig_${connId.slice(0, 8)}', 'enc', '{}', 'active', ${now}, ${now})`
	);
	igConnIds.push(connId);
}

test('Instagram asks for a photo, and a PNG is sent through its JPEG copy', async ({ page }) => {
	await seedInstagram(page);
	await page.goto('/compose');
	await waitForLiveComposer(page);
	await page.getByTestId('segment-input-0').fill(`${IG_PREFIX} text only`);

	const row = page.getByTestId('media-fit-0-instagram');
	await expect(row).toContainText('Instagram needs a photo or video');
	await page.getByTestId('publish-now').click();
	await expect(page.getByTestId('publish-toast')).toContainText('Instagram needs a photo or video');

	const draft = await storedDraft(page);
	await page
		.getByTestId('file-input-0')
		.setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: DOT_PNG });
	await expect
		.poll(async () => (await draft()).media[0]?.meta?.jpeg?.v ?? null, { timeout: 30000 })
		.not.toBeNull();
	await expect(row).toHaveCount(0);
});

test('Uncheck Instagram leaves a text-only post for the other accounts', async ({ page }) => {
	await seedInstagram(page);
	await page.goto('/compose');
	await waitForLiveComposer(page);
	await page.getByTestId('segment-input-0').fill(`${IG_PREFIX} uncheck`);

	const row = page.getByTestId('media-fit-0-instagram');
	await expect(row).toContainText('Instagram needs a photo or video');
	await row.getByRole('button', { name: 'Uncheck Instagram' }).click();
	await expect(row).toHaveCount(0);
	await page.getByTestId('publish-now').click();
	await expect(page.getByTestId('publish-toast')).toContainText('Select at least one account');
});

import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { d1, waitForLiveComposer } from './e2e-env';

/**
 * Alt text and image uploads in the composer: the description field counts
 * and stops where the server would cut, a post with undescribed images says
 * so without being held back, and each image shows its own upload. Accounts
 * are seeded and never contacted; publishing is refused at the network.
 */

const PREFIX = 'media-alt';
const connIds: string[] = [];

/** Leaves the shared database as the other specs expect it: no extra
 *  accounts, posts or files in Your media. */
test.afterEach(() => {
	const ids = connIds.splice(0);
	const drafts = `SELECT id FROM drafts WHERE base_body LIKE '${PREFIX}%'`;
	d1(
		`DELETE FROM draft_media WHERE draft_id IN (${drafts}); ` +
			`DELETE FROM publish_targets WHERE draft_id IN (${drafts}); ` +
			`DELETE FROM draft_variants WHERE draft_id IN (${drafts}); ` +
			`DELETE FROM drafts WHERE base_body LIKE '${PREFIX}%'` +
			(ids.length
				? `; DELETE FROM connections WHERE id IN (${ids.map((id) => `'${id}'`).join(', ')})`
				: '')
	);
});

const DOT_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64'
);
const dot = (n: number) => ({ name: `dot-${n}.png`, mimeType: 'image/png', buffer: DOT_PNG });

/** d1() wraps the SQL in double quotes for the shell, so JSON's own are escaped. */
const sqlJson = (value: unknown) => JSON.stringify(value).replace(/"/g, '\\"');

/** A draft going to one seeded X account, open in the composer. */
async function openDraft(page: Page) {
	await page.goto('/compose');
	const me = await page.request.get('/api/auth/me').then((r) => r.json());
	const userId = me.user.id as string;
	const connId = randomUUID();
	connIds.push(connId);
	const draftId = randomUUID();
	const body = `${PREFIX} ${draftId.slice(0, 8)}`;
	const now = Date.now();
	d1(
		`INSERT INTO connections (id, user_id, platform, handle, credentials_encrypted, meta_json, status, created_at, updated_at) VALUES ('${connId}', '${userId}', 'x', 'alt-${connId.slice(0, 8)}', 'enc', '{}', 'active', ${now}, ${now}); ` +
			`INSERT INTO drafts (id, user_id, title, base_body, selected_connection_ids, status, created_at, updated_at) VALUES ('${draftId}', '${userId}', NULL, '${body}', '${sqlJson([connId])}', 'draft', ${now}, ${now})`
	);
	const sent: string[] = [];
	await page.route('**/api/drafts/*/{publish,schedule}', async (route) => {
		sent.push(route.request().url());
		await route.abort();
	});
	await page.goto(`/compose?id=${draftId}`);
	await expect(page.getByTestId('segment-input-0')).toHaveValue(body, { timeout: 20000 });
	await waitForLiveComposer(page);
	const media = async () => {
		const res = await page.request.get(`/api/drafts/${draftId}`);
		return (await res.json()).draft.media as Array<{ id: string; altText: string | null }>;
	};
	return { sent, media };
}

test('the alt text field counts, stops where the server would cut, and says what X keeps', async ({
	page
}) => {
	const { sent, media } = await openDraft(page);
	await page.getByTestId('file-input-0').setInputFiles([dot(1)]);
	await expect.poll(async () => (await media()).length, { timeout: 30000 }).toBe(1);
	const [image] = await media();

	// Undescribed: said above Publish, which it does not block.
	const warning = page.getByTestId('alt-warning');
	await expect(warning).toContainText('Image 1 has no alt text');
	await expect(page.getByTestId('publish-blocker')).toHaveCount(0);

	await warning.getByRole('button', { name: 'Add alt text' }).click();
	const field = page.getByTestId(`media-alt-${image.id}`);
	await expect(field).toBeFocused();
	const count = page.getByTestId(`media-alt-count-${image.id}`);
	await expect(count).toHaveText('0 / 1,500');

	await page.keyboard.insertText('a'.repeat(1200));
	await expect(count).toHaveText('1,200 / 1,500 · X keeps the first 1,000 characters');
	await expect(warning).toHaveCount(0);

	// Typing past the cap stops at it, so nothing is cut without being seen.
	await page.keyboard.insertText('b'.repeat(400));
	await expect(field).toHaveValue('a'.repeat(1200) + 'b'.repeat(300));
	await expect(count).toContainText('1,500 / 1,500');
	await expect.poll(async () => (await media())[0].altText?.length, { timeout: 15000 }).toBe(1500);

	// Cmd+Enter in the field closes it, back on its ALT button, and publishes nothing.
	await page.keyboard.press('ControlOrMeta+Enter');
	await expect(field).toHaveCount(0);
	await expect(page.getByTestId(`alt-toggle-${image.id}`)).toBeFocused();
	await page.waitForTimeout(300);
	await expect(page.getByTestId('publish-confirm-destinations')).toHaveCount(0);
	expect(sent).toEqual([]);
});

test('images without alt text are counted above Publish and do not stop it', async ({ page }) => {
	const { media } = await openDraft(page);
	await page.getByTestId('file-input-0').setInputFiles([dot(1), dot(2)]);
	await expect.poll(async () => (await media()).length, { timeout: 30000 }).toBe(2);
	await expect(page.getByTestId('alt-warning')).toContainText('2 images have no alt text');

	await page.getByTestId('publish-now').click();
	await expect(page.getByTestId('publish-confirm-destinations')).toBeVisible();
	await page.keyboard.press('Escape');
});

test('each image shows its own upload, and one that fails can be tried again', async ({ page }) => {
	const { media } = await openDraft(page);
	let posts = 0;
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => (release = resolve));
	await page.route('**/api/drafts/*/media', async (route) => {
		if (route.request().method() !== 'POST') return route.continue();
		posts += 1;
		if (posts === 1) {
			await held;
			return route.continue();
		}
		if (posts === 2) {
			return route.fulfill({
				status: 503,
				contentType: 'application/json',
				body: JSON.stringify({ error: 'Storage is busy' })
			});
		}
		return route.continue();
	});

	await page.getByTestId('file-input-0').setInputFiles([dot(1), dot(2)]);
	const tiles = page.getByTestId('upload-file');
	await expect(tiles).toHaveCount(2);
	await expect(page.getByRole('progressbar', { name: 'Uploading dot-1.png' })).toBeVisible();
	release();

	// The first lands as an image; the second stays on its tile with the reason.
	await expect.poll(async () => (await media()).length, { timeout: 30000 }).toBe(1);
	const failed = tiles.filter({ has: page.getByRole('alert') });
	await expect(failed).toHaveCount(1);
	await expect(failed).toContainText("Couldn't upload dot-2.png");
	await expect(failed).toHaveAttribute('title', /Storage is busy/);
	await expect(page.getByText('Image attached · 1 did not upload').first()).toBeVisible();

	await failed.getByTestId('upload-retry').click();
	await expect.poll(async () => (await media()).length, { timeout: 30000 }).toBe(2);
	await expect(tiles).toHaveCount(0);
});

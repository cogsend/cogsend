import { expect, test } from '@playwright/test';
import { clickUntilVisible, fillUntilKept } from './e2e-env';

/** A 1×1 PNG: enough for the upload route's type sniffing. */
const DOT_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64'
);

test('a thread on Posts shows its first post, opens to the rest and follows the search', async ({
	page
}) => {
	const tag = `t${Date.now().toString(36)}`;
	const created: string[] = [];
	await page.goto('/posts?tab=drafts');
	// Form posts without the page's origin are refused as cross-site.
	const headers = { origin: new URL(page.url()).origin };
	const draft = async (baseBody: string) => {
		const res = await page.request.post('/api/drafts', { data: { baseBody }, headers });
		expect(res.status()).toBe(201);
		const id = (await res.json()).draft.id as string;
		created.push(id);
		return id;
	};

	try {
		const thread = await draft(`lead ${tag}\n---\nsecond ${tag}\n---\nthird ${tag}`);
		const upload = await page.request.post(`/api/drafts/${thread}/media`, {
			multipart: {
				file: { name: 'dot.png', mimeType: 'image/png', buffer: DOT_PNG },
				segmentIndex: '1'
			},
			headers
		});
		expect(upload.ok(), await upload.text()).toBe(true);
		await draft(`single ${tag}`);

		await page.reload();
		const card = page.getByTestId('post-card').filter({ hasText: `lead ${tag}` });
		const toggle = card.getByTestId('thread-toggle');
		await expect(card).toBeVisible();
		await expect(card.getByText(`second ${tag}`)).toHaveCount(0);
		await expect(card.getByText(`third ${tag}`)).toHaveCount(0);
		// The image belongs to the second post, so the first shows none.
		await expect(card.locator('img')).toHaveCount(0);
		await expect(toggle).toHaveText('2 more posts in this thread');
		await expect(toggle).toHaveAttribute('aria-expanded', 'false');

		const posts = card.getByTestId('thread-post');
		await clickUntilVisible(page, toggle, posts.first());
		await expect(toggle).toHaveAttribute('aria-expanded', 'true');
		await expect(toggle).toHaveText('Show less');
		await expect(posts).toHaveCount(2);
		await expect(posts.nth(0)).toContainText('2/3');
		await expect(posts.nth(0)).toContainText(`second ${tag}`);
		await expect(posts.nth(1)).toContainText('3/3');
		await expect(posts.nth(1)).toContainText(`third ${tag}`);
		await expect(posts.nth(1).locator('img')).toHaveCount(0);

		await posts.nth(0).locator('[data-testid^="media-view-"]').click();
		const viewer = page.getByTestId('media-viewer');
		await expect(viewer).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(viewer).toHaveCount(0);

		await toggle.click();
		await expect(posts).toHaveCount(0);
		await expect(toggle).toHaveAttribute('aria-expanded', 'false');

		// A match in a later post opens the thread to show it, even after a tap
		// closed it; a search the first post matches leaves it closed.
		const search = page.getByLabel('Search posts');
		await fillUntilKept(search, `third ${tag}`);
		await expect(card.getByText(`third ${tag}`)).toBeVisible();
		await expect(page.getByTestId('post-card').filter({ hasText: `single ${tag}` })).toHaveCount(0);
		await fillUntilKept(search, tag);
		await expect(card.getByText(`third ${tag}`)).toHaveCount(0);

		const single = page.getByTestId('post-card').filter({ hasText: `single ${tag}` });
		await expect(single).toBeVisible();
		await expect(single.getByTestId('thread-toggle')).toHaveCount(0);
	} finally {
		for (const id of created) await page.request.delete(`/api/drafts/${id}`, { headers });
	}
});

import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { clickUntilVisible, d1, fillUntilKept, waitForLiveComposer } from './e2e-env';

/**
 * The Threads topic tag in the composer: offered only where it does something,
 * kept across saves and reloads without turning the post into a Threads
 * override, and never able to cost the rest of the post its save. Schedule is
 * answered here and Publish is refused, so no provider is contacted.
 */

const PREFIX = 'threads-topic';
const connIds: string[] = [];

/** Leaves the shared e2e database as the other specs expect it: no extra
 *  accounts (smoke checks an empty Accounts page) and no extra posts. */
test.afterEach(() => {
	const ids = connIds.splice(0);
	const drafts = `SELECT id FROM drafts WHERE base_body LIKE '${PREFIX}%'`;
	d1(
		`DELETE FROM draft_variants WHERE draft_id IN (${drafts}); ` +
			`DELETE FROM drafts WHERE base_body LIKE '${PREFIX}%'` +
			(ids.length
				? `; DELETE FROM connections WHERE id IN (${ids.map((id) => `'${id}'`).join(', ')})`
				: '')
	);
});

type Account = 'threads' | 'zernio-threads' | 'bluesky' | 'mastodon';

/** d1() wraps the SQL in double quotes for the shell, so JSON's own are escaped. */
const sqlJson = (value: unknown) => JSON.stringify(value).replace(/"/g, '\\"');

/** A draft with these accounts ticked, none of them ever contacted. */
async function seedDraft(
	page: Page,
	accounts: Account[],
	variant?: { body: string | null; options: Record<string, unknown> }
) {
	const me = await page.request.get('/api/auth/me').then((r) => r.json());
	const userId = me.user.id as string;
	const draftId = randomUUID();
	const body = `${PREFIX} ${draftId.slice(0, 8)}`;
	const now = Date.now();
	const rows = accounts.map((account) => {
		const id = randomUUID();
		connIds.push(id);
		const platform = account === 'zernio-threads' ? 'threads' : account;
		const meta = account === 'zernio-threads' ? { provider: 'zernio' } : {};
		return `INSERT INTO connections (id, user_id, platform, handle, credentials_encrypted, meta_json, status, created_at, updated_at) VALUES ('${id}', '${userId}', '${platform}', 'tt-${id.slice(0, 8)}', 'enc', '${sqlJson(meta)}', 'active', ${now}, ${now})`;
	});
	const ids = connIds.slice(-accounts.length);
	const sql = [
		...rows,
		`INSERT INTO drafts (id, user_id, title, base_body, selected_connection_ids, status, created_at, updated_at) VALUES ('${draftId}', '${userId}', NULL, '${body}', '${sqlJson(ids)}', 'draft', ${now}, ${now})`
	];
	if (variant) {
		const stored = variant.body === null ? 'NULL' : `'${variant.body}'`;
		sql.push(
			`INSERT INTO draft_variants (id, draft_id, platform, body, options_json, created_at, updated_at) VALUES ('${randomUUID()}', '${draftId}', 'threads', ${stored}, '${sqlJson(variant.options)}', ${now}, ${now})`
		);
	}
	d1(sql.join('; '));
	return { draftId, body };
}

async function openDraft(page: Page, draftId: string, body: string) {
	await page.goto(`/compose?id=${draftId}`);
	await expect(page.getByTestId('segment-input-0')).toHaveValue(body, { timeout: 20000 });
	await waitForLiveComposer(page);
}

async function openTopic(page: Page) {
	await clickUntilVisible(
		page,
		page.getByTestId('post-options-toggle'),
		page.getByTestId('threads-topic')
	);
}

async function storedDraft(page: Page, draftId: string) {
	const { draft } = await page.request.get(`/api/drafts/${draftId}`).then((r) => r.json());
	return draft as {
		baseBody: string;
		variants: Array<{ platform: string; body: string | null; optionsJson: { topicTag?: string } }>;
	};
}

async function threadsVariant(page: Page, draftId: string) {
	const { variants } = await storedDraft(page, draftId);
	return variants.find((v) => v.platform === 'threads') ?? null;
}

test('options appear for a Threads account, direct or through Zernio', async ({ page }) => {
	const bluesky = await seedDraft(page, ['bluesky']);
	await openDraft(page, bluesky.draftId, bluesky.body);
	await expect(page.getByTestId('post-options')).toHaveCount(0);

	const direct = await seedDraft(page, ['threads']);
	await openDraft(page, direct.draftId, direct.body);
	await expect(page.getByTestId('post-options')).toBeVisible();
	await openTopic(page);
	await expect(page.getByTestId('threads-topic-count')).toHaveText('0/50');

	const zernio = await seedDraft(page, ['zernio-threads']);
	await openDraft(page, zernio.draftId, zernio.body);
	await expect(page.getByTestId('post-options')).toBeVisible();
});

test('a tag on a Zernio account saves, and clearing it removes it', async ({ page }) => {
	const { draftId, body } = await seedDraft(page, ['zernio-threads'], {
		body: null,
		options: { topicTag: 'Stale' }
	});
	await openDraft(page, draftId, body);
	await openTopic(page);
	await expect(page.getByTestId('threads-topic')).toHaveValue('Stale');

	await page.getByTestId('threads-topic').fill('Fresh');
	await expect
		.poll(async () => (await threadsVariant(page, draftId))?.optionsJson.topicTag, {
			timeout: 15000
		})
		.toBe('Fresh');

	await page.getByTestId('threads-topic').fill('');
	await expect(page.getByTestId('post-options')).toBeVisible();
	await expect.poll(() => threadsVariant(page, draftId), { timeout: 15000 }).toBeNull();
});

test('a tag saves, reloads and leaves the post following Global', async ({ page }) => {
	const { draftId, body } = await seedDraft(page, ['threads']);
	await openDraft(page, draftId, body);
	await openTopic(page);
	// Typed key by key: the composer listens for keys across the whole window.
	await page.getByTestId('threads-topic').click();
	await page.keyboard.type('  #AI Tools ');
	await expect(page.getByTestId('threads-topic')).toHaveValue('  #AI Tools ');
	await expect(page.getByTestId('post-options-summary')).toHaveText('· AI Tools');
	await expect(page.getByTestId('threads-topic-count')).toHaveText('8/50');

	await expect
		.poll(() => threadsVariant(page, draftId), { timeout: 15000 })
		.toMatchObject({ body: null, optionsJson: { topicTag: 'AI Tools' } });

	await openDraft(page, draftId, body);
	await expect(page.getByTestId('post-options-summary')).toHaveText('· AI Tools');
	await expect(page.getByTestId('editor-tab-threads')).toHaveCount(0);

	// Editing Global still reaches Threads: the tag is not an override.
	await fillUntilKept(page.getByTestId('segment-input-0'), `${body} edited`);
	await expect
		.poll(async () => (await storedDraft(page, draftId)).baseBody, { timeout: 15000 })
		.toBe(`${body} edited`);
	expect(await threadsVariant(page, draftId)).toMatchObject({
		body: null,
		optionsJson: { topicTag: 'AI Tools' }
	});
});

test('clearing the tag removes it', async ({ page }) => {
	const { draftId, body } = await seedDraft(page, ['threads'], {
		body: null,
		options: { topicTag: 'AI Tools' }
	});
	await openDraft(page, draftId, body);
	await openTopic(page);
	await expect(page.getByTestId('threads-topic')).toHaveValue('AI Tools');
	await fillUntilKept(page.getByTestId('threads-topic'), '');
	await expect(page.getByTestId('post-options-summary')).toHaveCount(0);
	await expect.poll(() => threadsVariant(page, draftId), { timeout: 15000 }).toBeNull();
});

test('custom Threads text keeps the tag, and so does resetting it', async ({ page }) => {
	const { draftId, body } = await seedDraft(page, ['threads', 'bluesky'], {
		body: 'threads only text',
		options: { topicTag: 'AI Tools' }
	});
	await page.goto(`/compose?id=${draftId}`);
	await expect(page.getByTestId('editor-tab-threads')).toBeVisible({ timeout: 20000 });
	await waitForLiveComposer(page);

	await page.getByTestId('editor-tab-threads').click();
	await fillUntilKept(page.getByTestId('segment-input-0'), 'threads only text, edited');
	await expect
		.poll(() => threadsVariant(page, draftId), { timeout: 15000 })
		.toMatchObject({ body: 'threads only text, edited', optionsJson: { topicTag: 'AI Tools' } });

	await page.getByTestId('reset-platform-tab').click();
	await expect(page.getByTestId('editor-tab-threads')).toHaveCount(0);
	await expect(page.getByTestId('segment-input-0')).toHaveValue(body);
	await expect
		.poll(() => threadsVariant(page, draftId), { timeout: 15000 })
		.toMatchObject({ body: null, optionsJson: { topicTag: 'AI Tools' } });
	await expect(page.getByTestId('post-options-summary')).toHaveText('· AI Tools');
});

test('a thread is told the tag goes on its first post', async ({ page }) => {
	const { draftId, body } = await seedDraft(page, ['threads']);
	await openDraft(page, draftId, body);
	await openTopic(page);
	await expect(page.getByTestId('threads-topic-first-post')).toHaveCount(0);
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('threads-topic')).toHaveCount(0);

	await fillUntilKept(page.getByTestId('segment-input-0'), `${body}\n---\nsecond post`);
	await openTopic(page);
	await expect(page.getByTestId('threads-topic-first-post')).toBeVisible();
});

test('a wrong tag never costs the post its save, and stops it going out', async ({ page }) => {
	const { draftId, body } = await seedDraft(page, ['threads']);
	const sent: string[] = [];
	await page.route('**/api/drafts/*/{publish,schedule}', async (route) => {
		sent.push(route.request().url());
		await route.abort();
	});
	await openDraft(page, draftId, body);
	await openTopic(page);
	await fillUntilKept(page.getByTestId('threads-topic'), 'a.b');
	await expect(page.getByTestId('threads-topic-error')).toHaveText(
		'Topic tags cannot contain . or &'
	);
	await page.keyboard.press('Escape');

	await fillUntilKept(page.getByTestId('segment-input-0'), `${body} still saved`);
	await expect
		.poll(async () => (await storedDraft(page, draftId)).baseBody, { timeout: 15000 })
		.toBe(`${body} still saved`);
	await expect(page.getByTestId('save-status')).not.toContainText('Not saved');
	expect(await threadsVariant(page, draftId)).toBeNull();

	await expect(page.getByTestId('publish-blocker')).toHaveText('Topic tags cannot contain . or &');
	await page.getByTestId('publish-now').click();
	await expect(page.getByTestId('publish-toast')).toContainText('Topic tags cannot contain . or &');
	await expect(page.getByTestId('publish-confirm-destinations')).toHaveCount(0);

	await clickUntilVisible(
		page,
		page.getByTestId('schedule-toggle'),
		page.getByTestId('schedule-panel')
	);
	await page.getByTestId('schedule-confirm').click();
	await expect(page.getByTestId('schedule-panel')).toBeVisible();
	expect(sent).toEqual([]);
});

test('scheduling keeps the tag and the next post starts without it', async ({ page }) => {
	const { draftId, body } = await seedDraft(page, ['threads'], {
		body: null,
		options: { topicTag: 'AI Tools' }
	});
	await page.route('**/api/drafts/*/schedule', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				targets: [],
				scheduledFor: route.request().postDataJSON().runAt,
				cancelled: []
			})
		});
	});
	await openDraft(page, draftId, body);
	await clickUntilVisible(
		page,
		page.getByTestId('schedule-toggle'),
		page.getByTestId('schedule-panel')
	);
	await page.getByTestId('schedule-confirm').click();
	await expect(page.getByTestId('publish-toast')).toContainText('Scheduled for');
	await expect(page.getByTestId('segment-input-0')).toHaveValue('');
	await expect(page.getByTestId('post-options-summary')).toHaveCount(0);

	expect(await threadsVariant(page, draftId)).toMatchObject({
		body: null,
		optionsJson: { topicTag: 'AI Tools' }
	});
});

test('Mastodon and Threads share one options panel, summed up on its chip', async ({ page }) => {
	const { draftId, body } = await seedDraft(page, ['threads', 'mastodon'], {
		body: null,
		options: { topicTag: 'AI Tools' }
	});
	await openDraft(page, draftId, body);
	await expect(page.getByTestId('post-options')).toHaveCount(1);
	await openTopic(page);
	await expect(page.getByTestId('masto-visibility')).toBeVisible();
	await expect(page.getByTestId('threads-topic')).toHaveValue('AI Tools');

	await fillUntilKept(page.getByTestId('masto-cw'), 'spoilers');
	await expect(page.getByTestId('post-options-summary')).toContainText('CW · AI Tools');

	await page.keyboard.press('Escape');
	await expect(page.getByTestId('masto-visibility')).toHaveCount(0);
	await expect(page.getByTestId('threads-topic')).toHaveCount(0);
});

test('a wrong tag turns the chip red until it is fixed', async ({ page }) => {
	const { draftId, body } = await seedDraft(page, ['threads']);
	await openDraft(page, draftId, body);
	await openTopic(page);
	await fillUntilKept(page.getByTestId('threads-topic'), 'a&b');
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('post-options-toggle')).toHaveClass(/border-red-300/);

	await openTopic(page);
	await fillUntilKept(page.getByTestId('threads-topic'), 'ab');
	await expect(page.getByTestId('post-options-toggle')).not.toHaveClass(/border-red-300/);
});

test('moving between drafts in the composer brings each its own tag', async ({ page }) => {
	const tagged = await seedDraft(page, ['threads'], {
		body: null,
		options: { topicTag: 'AI Tools' }
	});
	const plain = await seedDraft(page, ['threads']);
	await openDraft(page, tagged.draftId, tagged.body);
	await expect(page.getByTestId('post-options-summary')).toHaveText('· AI Tools');

	// A link, not page.goto: the composer stays mounted and loads the other draft itself.
	const followLink = async (id: string) => {
		await page.evaluate((href) => {
			const link = document.createElement('a');
			link.href = href;
			link.dataset.testid = 'draft-link';
			document.body.append(link);
			link.textContent = 'open';
		}, `/compose?id=${id}`);
		await page.getByTestId('draft-link').last().click();
	};
	await followLink(plain.draftId);
	await expect(page.getByTestId('segment-input-0')).toHaveValue(plain.body, { timeout: 15000 });
	await expect(page.getByTestId('post-options-summary')).toHaveCount(0);

	await followLink(tagged.draftId);
	await expect(page.getByTestId('segment-input-0')).toHaveValue(tagged.body, { timeout: 15000 });
	await expect(page.getByTestId('post-options-summary')).toHaveText('· AI Tools');
	expect(await threadsVariant(page, plain.draftId)).toBeNull();
});

test('the popover stays on screen at phone width', async ({ page }) => {
	const { draftId, body } = await seedDraft(page, ['threads']);
	for (const width of [320, 390, 640, 1280]) {
		await page.setViewportSize({ width, height: 800 });
		await openDraft(page, draftId, body);
		await openTopic(page);
		const box = await page.getByTestId('threads-topic').boundingBox();
		expect(box).not.toBeNull();
		expect(box!.x).toBeGreaterThanOrEqual(0);
		expect(box!.x + box!.width).toBeLessThanOrEqual(width);
		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		);
		expect(overflow).toBe(0);
	}
});

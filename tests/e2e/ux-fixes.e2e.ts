import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { clickUntilVisible, d1, fillUntilKept, waitForLiveComposer } from './e2e-env';

/**
 * What the composer, Posts, home and Insights say and refuse once a post has
 * somewhere to go: a dialog keeps the publish shortcut, an expired account is
 * named before anything is sent, a failed post reads as failed, and Posts
 * reaches past its first page. Every account is seeded and never contacted;
 * publish and schedule are refused at the network.
 */

const PREFIX = 'ux-fixes';
const connIds: string[] = [];

/** Leaves the shared e2e database as the other specs expect it: no extra
 *  accounts (smoke checks an empty Accounts page) and no extra posts. */
test.afterEach(() => {
	const ids = connIds.splice(0);
	const drafts = `SELECT id FROM drafts WHERE base_body LIKE '${PREFIX}%'`;
	d1(
		`DELETE FROM publish_targets WHERE draft_id IN (${drafts}); ` +
			`DELETE FROM draft_variants WHERE draft_id IN (${drafts}); ` +
			`DELETE FROM drafts WHERE base_body LIKE '${PREFIX}%'` +
			(ids.length
				? `; DELETE FROM connections WHERE id IN (${ids.map((id) => `'${id}'`).join(', ')})`
				: '')
	);
});

/** d1() wraps the SQL in double quotes for the shell, so JSON's own are escaped. */
const sqlJson = (value: unknown) => JSON.stringify(value).replace(/"/g, '\\"');

type Platform = 'bluesky' | 'mastodon' | 'x';

async function userIdOf(page: Page) {
	const me = await page.request.get('/api/auth/me').then((r) => r.json());
	return me.user.id as string;
}

function handleFor(platform: Platform, id: string) {
	const short = `ux-${id.slice(0, 8)}`;
	if (platform === 'bluesky') return `${short}.bsky.social`;
	if (platform === 'mastodon') return `${short}@mastodon.example`;
	return short;
}

function connectionSql(userId: string, id: string, platform: Platform, status = 'active') {
	const now = Date.now();
	return `INSERT INTO connections (id, user_id, platform, handle, credentials_encrypted, meta_json, status, created_at, updated_at) VALUES ('${id}', '${userId}', '${platform}', '${handleFor(platform, id)}', 'enc', '{}', '${status}', ${now}, ${now})`;
}

function seedConnection(userId: string, platform: Platform, status = 'active') {
	const id = randomUUID();
	connIds.push(id);
	d1(connectionSql(userId, id, platform, status));
	return { id, handle: handleFor(platform, id) };
}

type TargetRow = {
	connectionId: string;
	status: 'scheduled' | 'published' | 'failed';
	scheduledFor?: number;
	error?: string;
	updatedAt?: number;
};

function postSql(
	userId: string,
	draftId: string,
	body: string,
	draftStatus: string,
	rows: TargetRow[]
) {
	const now = Date.now();
	return [
		`INSERT INTO drafts (id, user_id, title, base_body, selected_connection_ids, status, created_at, updated_at) VALUES ('${draftId}', '${userId}', NULL, '${body}', '${sqlJson(rows.map((r) => r.connectionId))}', '${draftStatus}', ${now}, ${now})`,
		...rows.map((row, i) => {
			const at = row.updatedAt ?? now;
			const when = row.status === 'scheduled' ? String(row.scheduledFor) : 'NULL';
			const remote = row.status === 'published' ? `'remote-${draftId.slice(0, 8)}-${i}'` : 'NULL';
			const error = row.error ? `'${row.error}'` : 'NULL';
			return `INSERT INTO publish_targets (id, draft_id, connection_id, status, scheduled_for, remote_post_id, error_message, attempt_count, created_at, updated_at) VALUES ('${randomUUID()}', '${draftId}', '${row.connectionId}', '${row.status}', ${when}, ${remote}, ${error}, 0, ${at}, ${at})`;
		})
	].join('; ');
}

function seedPost(userId: string, draftStatus: string, rows: TargetRow[]) {
	const draftId = randomUUID();
	const body = `${PREFIX} ${draftId.slice(0, 8)}`;
	d1(postSql(userId, draftId, body, draftStatus, rows));
	return { draftId, body };
}

/** A draft ticked for the given accounts, open in the composer. */
async function openDraft(page: Page, connectionIds: string[], text?: string) {
	const userId = await userIdOf(page);
	const draftId = randomUUID();
	const body = text ?? `${PREFIX} ${draftId.slice(0, 8)}`;
	const now = Date.now();
	d1(
		`INSERT INTO drafts (id, user_id, title, base_body, selected_connection_ids, status, created_at, updated_at) VALUES ('${draftId}', '${userId}', NULL, '${body}', '${sqlJson(connectionIds)}', 'draft', ${now}, ${now})`
	);
	const sent: string[] = [];
	await page.route('**/api/drafts/*/{publish,schedule}', async (route) => {
		sent.push(route.request().url());
		await route.abort();
	});
	await page.goto(`/compose?id=${draftId}`);
	await expect(page.getByTestId('segment-input-0')).toHaveValue(body, { timeout: 20000 });
	await waitForLiveComposer(page);
	return { draftId, body, sent };
}

const DAY = 24 * 60 * 60 * 1000;

test('the publish shortcut does nothing while Your media is open', async ({ page }) => {
	await page.goto('/compose');
	const account = seedConnection(await userIdOf(page), 'bluesky');
	const { sent } = await openDraft(page, [account.id]);

	const library = page.getByTestId('media-library');
	await clickUntilVisible(page, page.getByTestId('library-0'), library);
	await page.keyboard.press('ControlOrMeta+Enter');
	// Long enough for the confirm to have opened had the shortcut gone through.
	await page.waitForTimeout(500);
	await expect(page.getByTestId('publish-confirm-destinations')).toHaveCount(0);
	await library.getByRole('button', { name: 'Cancel' }).click();
	await expect(library).toHaveCount(0);

	// With the dialog gone the same keys open the confirm, so the guard is
	// what held them back.
	await page.keyboard.press('ControlOrMeta+Enter');
	await expect(page.getByTestId('publish-confirm-destinations')).toBeVisible();
	await page.keyboard.press('Escape');
	expect(sent).toEqual([]);
});

test('an expired account is named before anything is sent, and can still be unchecked', async ({
	page
}) => {
	await page.goto('/compose');
	const userId = await userIdOf(page);
	const live = seedConnection(userId, 'bluesky');
	const expired = seedConnection(userId, 'mastodon', 'expired');
	const { sent } = await openDraft(page, [live.id, expired.id]);

	const blocker = page.getByTestId('publish-blocker');
	await expect(blocker).toContainText('Reconnect Mastodon');
	await expect(blocker).toContainText('or uncheck it');

	await page.getByTestId('publish-now').click();
	await expect(page.getByTestId('publish-toast')).toContainText('Reconnect Mastodon');
	await expect(page.getByTestId('publish-confirm-destinations')).toHaveCount(0);

	await clickUntilVisible(
		page,
		page.getByTestId('schedule-toggle'),
		page.getByTestId('schedule-panel')
	);
	await page.getByTestId('schedule-confirm').click();
	await expect(page.getByTestId('publish-toast')).toContainText('Reconnect Mastodon');
	await page.keyboard.press('Escape');
	expect(sent).toEqual([]);

	const row = page.locator(`button[title^="Mastodon:"][title$="${expired.handle}"]`);
	await clickUntilVisible(page, page.getByTestId('destinations-toggle'), row);
	await expect(row).toHaveAttribute('aria-pressed', 'true');
	await expect(row).toBeEnabled();
	await row.click();
	await expect(row).toHaveAttribute('aria-pressed', 'false');
	// Once unchecked it cannot be picked again until it is reconnected.
	await expect(row).toBeDisabled();
	await page.keyboard.press('Escape');
	await expect(blocker).toHaveCount(0);
});

test('the blocker line names the platform that is over its limit', async ({ page }) => {
	await page.goto('/compose');
	const account = seedConnection(await userIdOf(page), 'x');
	const text = `${PREFIX} ${'a'.repeat(300)}`;
	const { sent } = await openDraft(page, [account.id], text);
	await expect(page.getByTestId('publish-blocker')).toHaveText(
		`X: ${text.length - 280} over the limit`
	);
	await fillUntilKept(page.getByTestId('segment-input-0'), `${PREFIX} short`);
	await expect(page.getByTestId('publish-blocker')).toHaveCount(0);
	expect(sent).toEqual([]);
});

test('a failed post says Failed, and a partly published one is badged and in both tabs', async ({
	page
}) => {
	await page.goto('/posts');
	const userId = await userIdOf(page);
	const a = seedConnection(userId, 'bluesky');
	const b = seedConnection(userId, 'bluesky');
	const failed = seedPost(userId, 'failed', [
		{ connectionId: a.id, status: 'failed', error: 'boom' }
	]);
	const partial = seedPost(userId, 'failed', [
		{ connectionId: a.id, status: 'published' },
		{ connectionId: b.id, status: 'failed', error: 'boom' }
	]);

	await page.goto('/posts?tab=failed');
	const failedCard = page.getByTestId('post-card').filter({ hasText: failed.body });
	const partialCard = page.getByTestId('post-card').filter({ hasText: partial.body });
	await expect(failedCard).toBeVisible();
	await expect(failedCard).toHaveAttribute('data-outcome', 'failed');
	await expect(failedCard).not.toContainText('Published');
	await expect(failedCard.getByTestId('partial-badge')).toHaveCount(0);
	await expect(partialCard).toBeVisible();
	await expect(partialCard).toHaveAttribute('data-outcome', 'partial');
	await expect(partialCard.getByTestId('partial-badge')).toBeVisible();
	await expect(partialCard).toContainText('Published to 1 of 2');

	await page.goto('/posts?tab=published');
	await expect(page.getByTestId('post-card').filter({ hasText: partial.body })).toBeVisible();
	await expect(page.getByTestId('post-card').filter({ hasText: failed.body })).toHaveCount(0);
});

test('a retry the server refuses says so on the card', async ({ page }) => {
	await page.goto('/posts');
	const userId = await userIdOf(page);
	const account = seedConnection(userId, 'bluesky');
	const post = seedPost(userId, 'failed', [
		{ connectionId: account.id, status: 'failed', error: 'boom' }
	]);
	await page.route('**/api/targets/bulk', (route) =>
		route.fulfill({
			status: 500,
			contentType: 'application/json',
			body: JSON.stringify({ error: 'The retry was refused' })
		})
	);

	await page.goto('/posts?tab=failed');
	const card = page.getByTestId('post-card').filter({ hasText: post.body });
	const error = card.getByTestId('card-error');
	await clickUntilVisible(
		page,
		card.getByRole('button', { name: 'Retry', exact: true }).first(),
		error
	);
	await expect(error).toHaveAttribute('role', 'alert');
	await expect(error).toContainText('The retry was refused');
	await error.getByRole('button', { name: 'Dismiss' }).click();
	await expect(error).toHaveCount(0);
});

test('Reschedule cannot be confirmed for a time that has passed', async ({ page }) => {
	await page.goto('/posts');
	const userId = await userIdOf(page);
	const account = seedConnection(userId, 'bluesky');
	const post = seedPost(userId, 'scheduled', [
		{ connectionId: account.id, status: 'scheduled', scheduledFor: Date.now() + 7 * DAY }
	]);

	await page.goto('/posts?tab=scheduled');
	const card = page.getByTestId('post-card').filter({ hasText: post.body });
	const panel = card.getByRole('group', { name: 'Reschedule' });
	await clickUntilVisible(page, card.getByRole('button', { name: 'Reschedule' }), panel);
	const confirm = panel.getByRole('button', { name: 'Confirm' });
	await expect(confirm).toBeEnabled();
	await panel.getByRole('button', { name: 'Specific date' }).click();
	await panel.getByTestId('reschedule-datetime').fill('2020-01-01T10:00');
	await expect(panel.getByTestId('reschedule-invalid')).toHaveText('Pick a time in the future');
	await expect(confirm).toBeDisabled();
	await page.keyboard.press('Escape');
	await expect(panel).toHaveCount(0);
});

test('Posts loads older posts past the first page, and search finds them', async ({ page }) => {
	await page.goto('/posts');
	const userId = await userIdOf(page);
	const account = seedConnection(userId, 'bluesky');
	const now = Date.now();
	const oldestTag = `${PREFIX} oldest ${randomUUID().slice(0, 8)}`;
	const statements: string[] = [];
	for (let i = 0; i < 105; i++) {
		const draftId = randomUUID();
		const body = i === 104 ? oldestTag : `${PREFIX} page ${i} ${draftId.slice(0, 8)}`;
		statements.push(
			postSql(userId, draftId, body, 'published', [
				{ connectionId: account.id, status: 'published', updatedAt: now - (i + 1) * 60_000 }
			])
		);
	}
	d1(statements.join('; '));

	await page.goto('/posts?tab=published');
	const oldest = page.getByTestId('post-card').filter({ hasText: oldestTag });
	const more = page.getByTestId('load-older');
	await expect(more).toBeVisible();
	await expect(oldest).toHaveCount(0);
	for (let i = 0; i < 5 && (await oldest.count()) === 0; i++) {
		await more.click();
		await expect(more.or(oldest)).toBeVisible();
		await page.waitForTimeout(300);
	}
	await expect(oldest).toBeVisible();

	await page.reload();
	await expect(more).toBeVisible();
	await expect(oldest).toHaveCount(0);
	await fillUntilKept(page.getByLabel('Search posts'), oldestTag);
	await expect(oldest).toBeVisible();
});

test("an account filter finds that account's failures past the first page", async ({ page }) => {
	await page.goto('/posts');
	const userId = await userIdOf(page);
	const busy = seedConnection(userId, 'bluesky');
	const quiet = seedConnection(userId, 'mastodon');
	const now = Date.now();
	const statements: string[] = [];
	for (let i = 0; i < 105; i++) {
		const draftId = randomUUID();
		statements.push(
			postSql(userId, draftId, `${PREFIX} busy ${i} ${draftId.slice(0, 8)}`, 'published', [
				{ connectionId: busy.id, status: 'published', updatedAt: now - (i + 1) * 60_000 }
			])
		);
	}
	const oldFailure = randomUUID();
	const failedBody = `${PREFIX} quiet failure ${oldFailure.slice(0, 8)}`;
	statements.push(
		postSql(userId, oldFailure, failedBody, 'failed', [
			{ connectionId: quiet.id, status: 'failed', error: 'boom', updatedAt: now - 200 * 60_000 }
		])
	);
	d1(statements.join('; '));

	await page.goto(`/posts?tab=failed&account=${quiet.id}`);
	await expect(page.getByTestId('post-card').filter({ hasText: failedBody })).toBeVisible();
	await expect(page).toHaveURL(new RegExp(`account=${quiet.id}`));
	await expect(page.getByTestId('post-card')).toHaveCount(1);
});

test('home counts a post going to three accounts as one scheduled post', async ({ page }) => {
	await page.goto('/');
	const counts = page.getByTestId('home-counts');
	const before = Number((await counts.innerText()).match(/(\d+) scheduled posts?/)?.[1]);
	expect(Number.isFinite(before)).toBe(true);

	const userId = await userIdOf(page);
	const when = Date.now() + 7 * DAY;
	const rows = ['bluesky', 'mastodon', 'x'].map((platform) => ({
		connectionId: seedConnection(userId, platform as Platform).id,
		status: 'scheduled' as const,
		scheduledFor: when
	}));
	seedPost(userId, 'scheduled', rows);

	await page.reload();
	const after = before + 1;
	await expect(counts).toContainText(
		`${after} ${after === 1 ? 'scheduled post' : 'scheduled posts'}`
	);
	await expect(counts.getByRole('link', { name: /scheduled post/ })).toHaveAttribute(
		'href',
		'/posts?tab=scheduled'
	);
	await expect(page.getByTestId('home-next-post')).toBeVisible();
});

test('a failed count on Insights opens the failed posts of that account', async ({ page }) => {
	await page.goto('/insights');
	const userId = await userIdOf(page);
	const account = seedConnection(userId, 'bluesky');
	seedPost(userId, 'failed', [{ connectionId: account.id, status: 'failed', error: 'boom' }]);

	await page.reload();
	const link = page.locator(
		`a[data-testid="insight-account-failed"][href="/posts?tab=failed&account=${account.id}"]`
	);
	await expect(link).toBeVisible();
	await link.click();
	await expect(page).toHaveURL(new RegExp(`/posts\\?tab=failed&account=${account.id}$`));
});

test.describe('signed out', () => {
	// A context of its own with no cookies: it never signs in, so the shared
	// session the other specs use stays valid.
	test.use({ storageState: { cookies: [], origins: [] } });

	test('sign-in points to recovery for a lost password', async ({ page }) => {
		await page.goto('/login');
		await expect(
			page.getByRole('link', { name: 'Lost your password or authenticator?' })
		).toHaveAttribute('href', /configuration\/#the-login$/);
	});
});

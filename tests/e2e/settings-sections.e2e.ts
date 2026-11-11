import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { clickUntilVisible, d1 } from './e2e-env';

/**
 * Settings is one page per section, and Accounts shows a badge only when an
 * account needs something. Nothing here saves a real setting: the one save is
 * answered by a route mock.
 */

const SECTIONS = [
	{ label: 'Account', href: '/settings', card: 'Profile' },
	{ label: 'Posting', href: '/settings/posting', card: 'New post defaults' },
	{ label: 'Scheduled publishing', href: '/settings/scheduling', card: 'Scheduled publishing' },
	{ label: 'API access', href: '/settings/api', card: 'API access' },
	{ label: 'Instance', href: '/settings/instance', card: 'Updates' }
];

const connIds: string[] = [];

test.afterEach(() => {
	const ids = connIds.splice(0);
	if (ids.length)
		d1(`DELETE FROM connections WHERE id IN (${ids.map((id) => `'${id}'`).join(', ')})`);
});

async function seedAccount(page: Page, platform: string, status: string) {
	const me = await page.request.get('/api/auth/me').then((r) => r.json());
	const id = randomUUID();
	const handle = `sections-${id.slice(0, 8)}`;
	const now = Date.now();
	connIds.push(id);
	d1(
		`INSERT INTO connections (id, user_id, platform, handle, credentials_encrypted, meta_json, status, created_at, updated_at) VALUES ('${id}', '${me.user.id}', '${platform}', '${handle}', 'enc', '{}', '${status}', ${now}, ${now})`
	);
	return { id, handle };
}

const sectionNav = (page: Page) => page.getByRole('navigation', { name: 'Settings sections' });

test('each settings section has its own page, and the nav marks the one open', async ({ page }) => {
	await page.goto('/settings');
	for (const section of SECTIONS) {
		const link = sectionNav(page).getByRole('link', { name: section.label, exact: true });
		await link.click();
		await expect(page).toHaveURL(new RegExp(`${section.href}$`));
		await expect(link).toHaveAttribute('aria-current', 'page');
		await expect(
			page.getByRole('heading', { level: 2, name: section.card, exact: true })
		).toBeVisible();
		await expect(sectionNav(page).locator('[aria-current="page"]')).toHaveCount(1);
	}
});

test('an old link to the Instance card lands on the Instance section', async ({ page }) => {
	await page.goto('/settings#instance');
	await expect(page).toHaveURL(/\/settings\/instance$/);
	await expect(page.getByTestId('version-line')).toBeVisible();
});

test('a saved message stays with the section it came from', async ({ page }) => {
	// Answer the save here, so the real instance name never changes.
	await page.route('**/api/settings', (route) =>
		route.request().method() === 'PATCH'
			? route.fulfill({ json: { instanceName: 'Sections check' } })
			: route.fallback()
	);
	await page.goto('/settings/instance');
	const name = page.getByRole('textbox', { name: 'Instance name' });
	await expect(name).toBeEditable();
	await page.waitForLoadState('networkidle');
	await name.fill('Sections check');
	const notice = page.getByRole('alert').filter({ hasText: 'Instance name saved' });
	await clickUntilVisible(page, page.getByRole('button', { name: 'Save', exact: true }), notice);
	await sectionNav(page).getByRole('link', { name: 'Posting', exact: true }).click();
	await expect(page).toHaveURL(/\/settings\/posting$/);
	await expect(notice).toHaveCount(0);
});

test('post defaults name each platform as the platform does', async ({ page }) => {
	const linkedin = await seedAccount(page, 'linkedin', 'active');
	await page.goto('/settings/posting');
	const group = page.getByRole('group', { name: 'Selected accounts' });
	const row = group.getByRole('button').filter({ hasText: linkedin.handle });
	await expect(row).toContainText('LinkedIn');
	await expect(row).not.toContainText('Linkedin');
});

test('accounts show a badge only when one needs reconnecting', async ({ page }) => {
	const active = await seedAccount(page, 'bluesky', 'active');
	const expired = await seedAccount(page, 'mastodon', 'expired');
	await page.goto('/accounts');

	const expiredBadge = page.getByTestId(`account-status-${expired.id}`);
	await expect(expiredBadge).toHaveText(/expired/i);
	await expect(page.getByTestId(`account-status-${active.id}`)).toHaveCount(0);
	await expect(page.getByText('Connected', { exact: true })).toHaveCount(0);
	await expect(page.getByText("This account can't post until it is reconnected.")).toHaveCount(1);
	await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toHaveCount(1);

	// Disconnect asks first, and Keep leaves the account where it was.
	const dialog = page.getByRole('alertdialog');
	await clickUntilVisible(
		page,
		page.getByRole('button', { name: `Disconnect ${active.handle}`, exact: true }),
		dialog
	);
	await expect(dialog).toContainText(`Disconnect ${active.handle}?`);
	await dialog.getByRole('button', { name: 'Keep', exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(
		page.getByRole('button', { name: `Disconnect ${active.handle}`, exact: true })
	).toBeVisible();
});

test('on a phone the open section tab scrolls into view', async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 700 });
	await page.goto('/settings/instance');
	await expect(
		sectionNav(page).getByRole('link', { name: 'Instance', exact: true })
	).toBeInViewport({ ratio: 0.95 });
});

test('Back to a section keeps where the page was scrolled', async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 600 });
	await page.goto('/settings/api');
	await page.waitForLoadState('networkidle');
	await page.getByRole('link', { name: 'MCP docs' }).scrollIntoViewIfNeeded();
	const scrolled = await page.evaluate(() => window.scrollY);
	expect(scrolled).toBeGreaterThan(300);
	// A DOM click, so the page is not scrolled up to the tab first.
	await page.evaluate(() =>
		document
			.querySelector<HTMLElement>(
				'nav[aria-label="Settings sections"] a[href="/settings/instance"]'
			)
			?.click()
	);
	await expect(page).toHaveURL(/\/settings\/instance$/);
	await page.goBack();
	await expect(page).toHaveURL(/\/settings\/api$/);
	await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(scrolled - 50);
});

test('a request that fails after leaving a section does not report on the next one', async ({
	page
}) => {
	let first = true;
	await page.route('**/api/settings', async (route) => {
		if (route.request().method() !== 'GET' || !first) return route.fallback();
		first = false;
		await new Promise((resolve) => setTimeout(resolve, 1500));
		await route.fulfill({ status: 500, json: { error: 'boom' } });
	});
	// The Account cards fetch from onMount, so once the slow request is out the
	// page is live and the click below is an in-app move, not a fresh load.
	const slow = page.waitForRequest(
		(req) => req.method() === 'GET' && new URL(req.url()).pathname === '/api/settings'
	);
	await page.goto('/settings');
	await slow;
	await sectionNav(page).getByRole('link', { name: 'Posting', exact: true }).click();
	await expect(page).toHaveURL(/\/settings\/posting$/);
	await expect(page.getByRole('heading', { name: 'New post defaults' })).toBeVisible();
	// Past the slow answer, with the Posting cards loaded.
	await page.waitForTimeout(2500);
	await expect(page.getByText('Could not load your settings')).toHaveCount(0);
});

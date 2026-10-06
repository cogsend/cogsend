import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { clickUntilVisible, E2E_ACCOUNT, E2E_D1_FLAGS, waitForLiveComposer } from './e2e-env';

/**
 * X shows a post whose text ends with a link to another X post as a quote, and
 * the composer draws that link as a quote card. The stored text must keep the
 * link at the very end whatever happens in the text box, because that text is
 * what publishing sends.
 */

const POST_ID = '1974452871209381904';
const LINK = `https://x.com/ada_builds/status/${POST_ID}`;
const GONE = 'https://x.com/ada_builds/status/1';
const OWN = 'https://x.com/quoter/status/1974500000000000001';

let xConnectionId = '';
let publishedDraftId = '';
let userId = '';
const extraDraftIds: string[] = [];

function d1(sql: string) {
	execSync(`node scripts/wrangler.mjs d1 execute DB --local ${E2E_D1_FLAGS} --command "${sql}"`, {
		stdio: 'pipe'
	});
}

async function signIn(page: Page) {
	await page.goto('/compose');
	if (/\/login$/.test(new URL(page.url()).pathname)) {
		await page.getByLabel('Email').fill(E2E_ACCOUNT.email);
		await page.getByLabel('Password').fill(E2E_ACCOUNT.password);
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page).toHaveURL(/\/compose$/, { timeout: 20000 });
	}
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
	const page = await browser.newPage();
	await signIn(page);
	const me = await page.request.get('/api/auth/me').then((r) => r.json());
	await page.close();
	userId = me.user.id;
	const now = Date.now();
	xConnectionId = randomUUID();
	publishedDraftId = randomUUID();
	// A connection row is enough: nothing here publishes.
	d1(
		`INSERT INTO connections (id, user_id, platform, handle, credentials_encrypted, meta_json, status, created_at, updated_at) VALUES ('${xConnectionId}', '${me.user.id}', 'x', 'quoter', 'enc', '{}', 'active', ${now}, ${now})`
	);
	d1(
		`INSERT INTO drafts (id, user_id, base_body, status, created_at, updated_at) VALUES ('${publishedDraftId}', '${me.user.id}', 'Our launch post', 'published', ${now}, ${now})`
	);
	d1(
		`INSERT INTO publish_targets (id, draft_id, connection_id, status, remote_post_id, remote_url, created_at, updated_at) VALUES ('${randomUUID()}', '${publishedDraftId}', '${xConnectionId}', 'published', '1974500000000000001', '${OWN}', ${now}, ${now})`
	);
});

test.afterAll(() => {
	for (const id of extraDraftIds) d1(`DELETE FROM drafts WHERE id='${id}'`);
	d1(`DELETE FROM drafts WHERE id='${publishedDraftId}'`);
	d1(`DELETE FROM connections WHERE id='${xConnectionId}'`);
});

test.beforeEach(async ({ page }) => {
	// The real endpoint would ask publish.x.com; the card only needs its answer.
	await page.route('**/api/link-preview*', (route) => {
		const asked = new URL(route.request().url()).searchParams.get('url') ?? '';
		if (asked === GONE) {
			return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
		}
		const own = asked === OWN;
		return route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				url: asked,
				title: own ? 'You (@quoter)' : 'Ada Builds (@ada_builds)',
				description: '',
				image: null,
				siteName: 'X',
				xPost: {
					id: own ? '1974500000000000001' : POST_ID,
					name: own ? 'You' : 'Ada Builds',
					handle: own ? 'quoter' : 'ada_builds',
					text: own ? 'Our launch post' : 'Moved my whole posting setup to a Worker.',
					date: 'Oct 4, 2026'
				}
			})
		});
	});
	await signIn(page);
	await selectX(page);
	await waitForLiveComposer(page);
});

/** X has to be a destination for its link to be a quote. */
async function selectX(page: Page) {
	const x = page.locator('button[title="X: quoter"]');
	await clickUntilVisible(page, page.getByTestId('destinations-toggle'), x);
	if ((await x.getAttribute('aria-pressed')) !== 'true') await x.click();
	await expect(x).toHaveAttribute('aria-pressed', 'true');
	await page.keyboard.press('Escape');
}

async function storedBody(page: Page) {
	await expect
		.poll(() => new URL(page.url()).searchParams.get('id'), { timeout: 30000 })
		.toBeTruthy();
	const id = new URL(page.url()).searchParams.get('id')!;
	return async () => {
		const res = await page.request.get(`/api/drafts/${id}`);
		return ((await res.json()).draft as { baseBody: string }).baseBody;
	};
}

/** A paste at the end of the box, as the browser reports it. */
async function pasteAtEnd(field: Locator, text: string) {
	await field.evaluate((el: HTMLTextAreaElement, t: string) => {
		el.focus();
		el.setRangeText(t, el.value.length, el.value.length, 'end');
		el.dispatchEvent(
			new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: t })
		);
	}, text);
}

test('a pasted X link becomes a quote card and stays at the end of the text', async ({ page }) => {
	const box = page.getByTestId('segment-input-0');
	await box.fill('So good.');
	await pasteAtEnd(box, ` ${LINK}`);

	await expect(box).toHaveValue('So good.');
	await expect(page.getByTestId('x-quote-card')).toContainText('Ada Builds');
	await expect(page.getByTestId('x-quote-card')).toContainText('Moved my whole posting setup');
	const body = await storedBody(page);
	await expect.poll(body, { timeout: 30000 }).toBe(`So good. ${LINK}`);

	// More words go before the link, never after it.
	await box.press('End');
	await box.pressSequentially(' Really.');
	await box.press('Enter');
	await box.pressSequentially('Read it.');
	await expect(box).toHaveValue('So good. Really.\nRead it.');
	await expect.poll(body, { timeout: 30000 }).toBe(`So good. Really.\nRead it. ${LINK}`);

	// Removing the card removes the link and nothing else.
	await page.getByTestId('x-quote-remove').click();
	await expect(page.getByTestId('x-quote-card')).toHaveCount(0);
	await expect(box).toHaveValue('So good. Really.\nRead it.');
	await expect.poll(body, { timeout: 30000 }).toBe('So good. Really.\nRead it.');
});

test('a thread marker typed in a quoted card keeps the quote on the last piece', async ({
	page
}) => {
	const box = page.getByTestId('segment-input-0');
	await box.fill('first');
	await pasteAtEnd(box, ` ${LINK}`);
	await expect(box).toHaveValue('first');

	await box.press('End');
	await box.pressSequentially(' ---', { delay: 50 });
	await expect(page.getByTestId('segment-input-1')).toBeFocused();
	await page.getByTestId('segment-input-1').pressSequentially('next', { delay: 50 });

	await expect(box).toHaveValue('first');
	await expect(page.getByTestId('segment-input-1')).toHaveValue('next');
	await expect(page.getByTestId('segment-card-0').getByTestId('x-quote-card')).toHaveCount(0);
	await expect(page.getByTestId('segment-card-1').getByTestId('x-quote-card')).toBeVisible();
	const body = await storedBody(page);
	await expect.poll(body, { timeout: 30000 }).toBe(`first\n---\nnext ${LINK}`);
});

test('a typed link stays in the box until it loses focus', async ({ page }) => {
	const box = page.getByTestId('segment-input-0');
	await box.fill(`Look ${LINK}`);
	await expect(box).toHaveValue(`Look ${LINK}`);
	await expect(page.getByTestId('x-quote-card')).toBeVisible();

	await box.blur();
	await expect(box).toHaveValue('Look');
	const body = await storedBody(page);
	await expect.poll(body, { timeout: 30000 }).toBe(`Look ${LINK}`);
});

test('a second pasted link replaces the quote', async ({ page }) => {
	const box = page.getByTestId('segment-input-0');
	const other = 'https://x.com/jack/status/20';
	await box.fill('Two posts');
	await pasteAtEnd(box, ` ${LINK}`);
	await expect(box).toHaveValue('Two posts');
	await pasteAtEnd(box, ` ${other}`);
	await expect(box).toHaveValue('Two posts');
	const body = await storedBody(page);
	await expect.poll(body, { timeout: 30000 }).toBe(`Two posts ${other}`);
	await expect(page.getByText('Now quoting the post you pasted')).toBeVisible();
});

test('a link X will not quote is flagged and can be made the quote', async ({ page }) => {
	const box = page.getByTestId('segment-input-0');
	await box.fill(`${LINK} is great`);
	await expect(page.getByTestId('x-quote-stray')).toBeVisible();
	await expect(page.getByTestId('x-quote-card')).toHaveCount(0);

	await page.getByTestId('x-quote-make').click();
	await expect(box).toHaveValue('is great');
	await expect(page.getByTestId('x-quote-card')).toBeVisible();
	await expect(page.getByTestId('x-quote-stray')).toHaveCount(0);
	const body = await storedBody(page);
	await expect.poll(body, { timeout: 30000 }).toBe(`is great\n${LINK}`);
});

test('a post X cannot find says so', async ({ page }) => {
	const box = page.getByTestId('segment-input-0');
	await box.fill('Gone?');
	await pasteAtEnd(box, ` ${GONE}`);
	await expect(page.getByTestId('x-quote-unavailable')).toBeVisible();
	await expect(box).toHaveValue('Gone?');
});

test('the picker quotes one of your published X posts', async ({ page }) => {
	const box = page.getByTestId('segment-input-0');
	await box.fill('Still true');
	await page.getByTestId('quote-post-0').click();
	const picker = page.getByTestId('quote-picker');
	await expect(picker).toContainText('Our launch post');
	await picker.getByRole('button', { name: /Our launch post/ }).click();

	await expect(picker).toHaveCount(0);
	await expect(box).toHaveValue('Still true');
	await expect(page.getByTestId('x-quote-card')).toContainText('Our launch post');
	const body = await storedBody(page);
	await expect.poll(body, { timeout: 30000 }).toBe(`Still true\n${OWN}`);
});

test('Quote on X in Posts opens a draft quoting that post', async ({ page }) => {
	await page.goto('/posts?tab=published');
	const quote = page.getByTestId('quote-on-x').first();
	await quote.click();
	await expect(page).toHaveURL(/\/compose\?id=/, { timeout: 20000 });
	await expect(page.getByTestId('x-quote-card')).toContainText('Our launch post');
	await expect(page.getByTestId('segment-input-0')).toHaveValue('');
	const body = await storedBody(page);
	await expect.poll(body, { timeout: 30000 }).toBe(OWN);
});

test('a long paste into a quote draft starts on the quoted card', async ({ page }) => {
	await page.goto('/posts?tab=published');
	await page.getByTestId('quote-on-x').first().click();
	await expect(page).toHaveURL(/\/compose\?id=/, { timeout: 20000 });
	await expect(page.getByTestId('x-quote-card')).toBeVisible();
	await waitForLiveComposer(page);

	const long = Array.from(
		{ length: 12 },
		(_, i) => `Sentence ${i} says something worth reading about quoting.`
	).join(' ');
	await page.evaluate((text) => {
		const dt = new DataTransfer();
		dt.setData('text/plain', text);
		document
			.querySelector('[data-testid="segment-input-0"]')
			?.dispatchEvent(
				new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
			);
	}, long);

	await expect(page.getByTestId('segment-input-1')).toBeVisible();
	await expect(page.getByTestId('segment-input-0')).toHaveValue(/^Sentence 0/);
	await expect(page.getByTestId('segment-card-0').getByTestId('x-quote-card')).toBeVisible();
	await expect(page.getByTestId('segment-card-1').getByTestId('x-quote-card')).toHaveCount(0);
	// The first post holds the quote link too and still fits X's limit.
	const [n, max] = (await page.getByTestId('segment-count-0').innerText()).split('/').map(Number);
	expect(n).toBeLessThanOrEqual(max);
	const body = await storedBody(page);
	await expect
		.poll(async () => (await body()).split('\n---\n')[0], { timeout: 30000 })
		.toMatch(new RegExp(`^Sentence 0[^]*\\n${OWN.replace(/[.?/]/g, '\\$&')}$`));
});

test('on a phone the picker opens fully on screen, clear of the bottom bar', async ({ page }) => {
	// Enough published posts that the list is tall, as it is for a real account.
	const now = Date.now();
	for (let i = 0; i < 7; i++) {
		const draftId = randomUUID();
		extraDraftIds.push(draftId);
		d1(
			`INSERT INTO drafts (id, user_id, base_body, status, created_at, updated_at) VALUES ('${draftId}', '${userId}', 'An older post number ${i} with enough words to wrap onto a second line', 'published', ${now - i - 1}, ${now - i - 1})`
		);
		d1(
			`INSERT INTO publish_targets (id, draft_id, connection_id, status, remote_post_id, remote_url, created_at, updated_at) VALUES ('${randomUUID()}', '${draftId}', '${xConnectionId}', 'published', '19745000000000001${i}0', 'https://x.com/quoter/status/19745000000000001${i}0', ${now - i - 1}, ${now - i - 1})`
		);
	}
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/compose');
	await waitForLiveComposer(page);
	await page.getByTestId('quote-post-0').click();
	const picker = page.getByTestId('quote-picker');
	await expect(picker).toContainText('Our launch post');

	// Measure the whole list, all eight posts in it.
	await expect.poll(async () => (await picker.boundingBox())!.height).toBeGreaterThan(250);
	// It used to open upwards from the first card and run off the top of the page.
	const list = (await picker.boundingBox())!;
	const bar = (await page.getByTestId('destinations-toggle').boundingBox())!;
	expect(list.y).toBeGreaterThanOrEqual(0);
	expect(list.y + list.height).toBeLessThanOrEqual(bar.y);
	expect(list.x).toBeGreaterThanOrEqual(0);
	expect(list.x + list.width).toBeLessThanOrEqual(390);
});

test('on a phone the picker under the last card scrolls clear of the bottom bar', async ({
	page
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/compose');
	await waitForLiveComposer(page);
	await page.getByTestId('segment-input-0').fill('one --- two --- three --- four');
	await expect(page.getByTestId('segment-input-3')).toHaveValue('four');
	await page.getByTestId('quote-post-3').click();
	const picker = page.getByTestId('quote-picker');
	await expect(picker).toContainText('Our launch post');
	await expect.poll(async () => (await picker.boundingBox())!.height).toBeGreaterThan(250);
	await expect
		.poll(async () => {
			const list = (await picker.boundingBox())!;
			const bar = (await page.getByTestId('destinations-toggle').boundingBox())!;
			return list.y >= 0 && list.y + list.height <= bar.y;
		})
		.toBe(true);
});

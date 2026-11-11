import { expect, test } from '@playwright/test';
import { clickUntilVisible, E2E_ACCOUNT } from './e2e-env';

test.beforeEach(async ({ page }) => {
	await page.goto('/compose');
	if (/\/login$/.test(new URL(page.url()).pathname)) {
		await page.getByLabel('Email').fill(E2E_ACCOUNT.email);
		await page.getByLabel('Password').fill(E2E_ACCOUNT.password);
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page).toHaveURL(/\/compose$/, { timeout: 20000 });
	}
});

test('focused textarea shows no black outline', async ({ page }) => {
	const box = page.getByTestId('segment-input-0');
	await box.click();
	await expect(box).toBeFocused();
	const outline = await box.evaluate((el) => getComputedStyle(el).outlineStyle);
	expect(outline).toBe('none');
});

test('keyboard focus ring still works on buttons', async ({ page }) => {
	await page.getByTestId('segment-input-0').click();
	let ringFound = false;
	for (let i = 0; i < 30 && !ringFound; i++) {
		await page.keyboard.press('Tab');
		ringFound = await page.evaluate(() => {
			const el = document.activeElement as HTMLElement | null;
			if (!el || (el.tagName !== 'BUTTON' && el.tagName !== 'A')) return false;
			return getComputedStyle(el).outlineStyle === 'solid';
		});
	}
	expect(ringFound).toBe(true);
});

test('schedule panel prefills current date/time with D/H/M offsets', async ({ page }) => {
	// A click before hydration is lost, and this one opens a fresh page.
	await clickUntilVisible(
		page,
		page.getByTestId('schedule-toggle'),
		page.getByTestId('schedule-panel')
	);
	// No Morning/Today presets anymore.
	await expect(page.getByTestId('schedule-offsets')).toBeVisible();
	await expect(page.getByTestId('schedule-preset-tomorrow')).toHaveCount(0);
	// Offsets prefilled with the common default (1 hour).
	await expect(page.getByTestId('schedule-offset-value')).toHaveValue('1');
	await expect(page.getByTestId('schedule-offset-unit')).toHaveValue('hours');

	// Date/time prefilled with "now + 1 hour" (DEFAULT_SCHEDULE_OFFSET), which
	// rolls into the next day any time after 23:00 — computing the date from the
	// raw clock made this test fail for a run in that hour.
	const expectedDate = await page.evaluate(() => {
		const d = new Date(Date.now() + 60 * 60_000);
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	});
	// Note: date/time inputs are not rendered when in 'relative' mode.
	// We need to switch to absolute mode to verify their prefilled values.
	await page.getByText('Specific date').click();
	await expect(page.getByTestId('schedule-date')).toHaveValue(expectedDate);
	const timeVal = await page.getByTestId('schedule-time').inputValue();
	expect(timeVal).toMatch(/^\d{2}:\d{2}$/);

	// Editing an offset recomputes the date/time and shows a local-tz preview.
	await page.getByText('Relative').click();
	await page.getByTestId('schedule-offset-value').fill('5');
	await expect(page.getByTestId('schedule-preview')).toBeVisible();
	const preview = (await page.getByTestId('schedule-preview').innerText()) ?? '';
	const tz = await page.evaluate(
		() =>
			new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
				.formatToParts(new Date())
				.find((p) => p.type === 'timeZoneName')?.value ?? ''
	);
	expect(preview).toContain('Will publish');
	expect(preview).toContain(tz);
});

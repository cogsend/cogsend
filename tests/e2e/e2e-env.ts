import { readFileSync } from 'node:fs';
import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Shared harness values for the e2e suite.
 *
 * The preview server gets a dedicated fixture through Wrangler's `--env-file`
 * flag, so the specs read the same file. A developer's `.dev.vars` is never
 * consulted or changed. The TOTP suite can supply a temporary derivative via
 * `COGSEND_E2E_VARS_FILE`.
 *
 * The login is not one of those values: the account is created in D1 before the
 * server starts, by `scripts/seed-local.mjs`, into the suite's own state
 * directory. `E2E_ACCOUNT` is what it writes.
 */
const FIXTURE = 'tests/e2e/fixtures/dev.vars';

function parse(raw: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of raw.split('\n')) {
		const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
		if (m) out[m[1]] = m[2];
	}
	return out;
}

export const E2E_VARS_FILE = process.env.COGSEND_E2E_VARS_FILE || FIXTURE;

export function e2eVars(): Record<string, string> {
	return parse(readFileSync(E2E_VARS_FILE, 'utf8'));
}

/**
 * Dedicated local D1/R2 state for tests. Using its own directory means a test
 * run never deletes the state a developer uses for `npm run dev`.
 * Keep in sync with playwright.config.ts, which passes the same value to
 * `wrangler dev --persist-to`.
 */
export const E2E_PERSIST_TO = '.wrangler/e2e-state';

/** The account `scripts/seed-local.mjs` puts into that database. Throwaway by
 *  design: it exists only inside `.wrangler/e2e-state`, which every run wipes. */
export const E2E_ACCOUNT = { email: 'e2e@localhost', password: 'e2e-password' };

/** Extra flags for every `wrangler d1 …` call inside a spec. */
export const E2E_D1_FLAGS = `--persist-to ${E2E_PERSIST_TO}`;

/**
 * Click a control and wait for what it opens, retrying the click.
 *
 * Svelte hydrates after the first paint, so a click that lands too early is
 * simply lost — no error, nothing happens — and the failure looks like a broken
 * feature on whichever machine was slowest. Every spec that clicks straight
 * after `goto` has this race; this is the shared answer to it.
 */
/**
 * Type into a field and make sure the value survives hydration.
 *
 * Pages arrive server-rendered and Svelte takes over afterwards; a `fill` that
 * lands in between is overwritten by the value it hydrates with, so the test
 * asserts against an empty composer — which is how "deleting an already-deleted
 * draft keeps the card hidden" failed in CI (no text, no autosave, no draft id
 * in the URL). Slow starts are what expose it: a cold `workerd`, a loaded
 * runner, a delayed bundle. Verified by delaying the client bundle by 5s and
 * filling immediately: the plain fill was gone afterwards, this one stuck.
 *
 * `window.__svelte` appears when Svelte's runtime starts, so wait for it rather
 * than guess with a timeout. Best effort — if a future Svelte stops setting it,
 * the loop below still catches a wipe, just later.
 */
export async function fillUntilKept(field: Locator, value: string) {
	const page = field.page();
	await page
		.waitForFunction(() => '__svelte' in window, undefined, { timeout: 5000 })
		.catch(() => {});
	for (let attempt = 0; attempt < 3; attempt++) {
		await field.fill(value);
		await page.waitForTimeout(150);
		if ((await field.inputValue()) === value) return;
	}
	await expect(field).toHaveValue(value);
}

/**
 * Wait until the composer has hydrated, for tests that need real keystrokes
 * rather than a retried `fill`.
 *
 * Keys typed before hydration are overwritten by the value the composer
 * hydrates with, so the text comes back missing its first letters ("ped while
 * loading"). The composer's autoResize action gives the first card an inline
 * height, and actions only run once the component is live, so that height is
 * the signal.
 */
export async function waitForLiveComposer(page: Page) {
	await page.waitForFunction(() =>
		Boolean(document.querySelector<HTMLElement>('[data-testid="segment-input-0"]')?.style.height)
	);
}

/**
 * Attach a file to an input and wait for the app's answer to it.
 *
 * `setInputFiles` fires `change` as it sets the value, and the input is in the
 * server-rendered HTML — so on a loaded runner the event can land before Svelte
 * has attached the handler, the change is lost, and the answer the test waits for
 * never appears. Same race as `fillUntilKept`, same guard: wait for the runtime,
 * then set the file again until the app says something.
 */
export async function attachUntilAnswered(
	input: Locator,
	file: { name: string; mimeType: string; buffer: Buffer },
	answer: Locator
) {
	const page = input.page();
	await page
		.waitForFunction(() => '__svelte' in window, undefined, { timeout: 5000 })
		.catch(() => {});
	for (let attempt = 0; attempt < 3; attempt++) {
		await input.setInputFiles(file);
		try {
			await expect(answer).toBeVisible({ timeout: 3_000 });
			return;
		} catch {
			// The change event beat hydration (or a toast replaced this one).
		}
	}
	await expect(answer).toBeVisible();
}

export async function clickUntilVisible(page: Page, opener: Locator, target: Locator) {
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			// A short click timeout, so a lost click is retried rather than
			// waiting out Playwright's 30s default; and a click that lands on an
			// overlay the first attempt opened counts as a retry, not a failure.
			await opener.click({ timeout: 5_000 });
			await expect(target).toBeVisible({ timeout: 2_000 });
			return;
		} catch {
			// Not hydrated yet, or it closed again: click once more.
		}
	}
	await expect(target).toBeVisible();
}

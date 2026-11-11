import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { E2E_ACCOUNT } from './e2e-env';

/**
 * The Content-Security-Policy is only worth having if the app actually runs
 * under it. SvelteKit nonces its own inline hydration scripts, so `script-src`
 * needs no 'unsafe-inline' — and the moment a dependency injects a script or a
 * stylesheet from somewhere else, this spec fails instead of the browser
 * silently blocking it in production.
 */
function watchForViolations(page: Page): string[] {
	const violations: string[] = [];
	const note = (text: string) => {
		if (/content security policy|refused to (load|execute|apply)/i.test(text)) {
			violations.push(text);
		}
	};
	page.on('console', (msg: ConsoleMessage) => note(msg.text()));
	page.on('pageerror', (err: Error) => note(err.message));
	return violations;
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

test('page responses carry the security headers, and HSTS only over https', async ({ page }) => {
	const res = await page.goto('/login');
	expect(res).toBeTruthy();
	const headers = res!.headers();

	// The policy itself comes from SvelteKit (mode: 'auto' adds the nonce).
	expect(headers['content-security-policy']).toContain("default-src 'self'");
	expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
	expect(headers['content-security-policy']).toContain("object-src 'none'");
	expect(headers['content-security-policy']).toContain("connect-src 'self'");
	expect(headers['x-frame-options']).toBe('DENY');
	expect(headers['x-content-type-options']).toBe('nosniff');
	expect(headers['referrer-policy']).toBe('no-referrer');
	expect(headers['permissions-policy']).toContain('camera=()');
	// This server is plain http on purpose: pinning it to https would break
	// local development for good.
	expect(headers['strict-transport-security']).toBeUndefined();
});

test('an unknown path redirects instead of rendering, and the landing page is covered', async ({
	page,
	request
}) => {
	// The hook sends any non-public, unknown path to /login, and a signed-in
	// visitor is bounced on to the dashboard from there — so a typo lands on a
	// real page rather than a soft 404, and that page is still covered.
	const landed = await page.goto('/definitely-not-a-page');
	expect(landed!.status()).toBe(200);
	expect(landed!.headers()['content-security-policy']).toContain("default-src 'self'");
	expect(landed!.headers()['x-frame-options']).toBe('DENY');

	// An anonymous probe of the same path gets a redirect, not a rendered page.
	const anon = await request.get('/definitely-not-a-page', { maxRedirects: 0 });
	expect([302, 303, 307]).toContain(anon.status());
	expect(anon.headers()['location'] ?? '').toContain('/login');

	// JSON responses get nosniff and the referrer policy; they need no CSP.
	const api = await request.get('/api/health');
	expect(api.headers()['x-content-type-options']).toBe('nosniff');
	expect(api.headers()['referrer-policy']).toBe('no-referrer');
	expect(api.headers()['permissions-policy']).toContain('camera=()');
});

test('every page runs without a CSP violation', async ({ page }) => {
	test.setTimeout(120_000);
	await signIn(page);
	const violations = watchForViolations(page);

	for (const path of [
		'/compose',
		'/posts',
		'/accounts',
		'/settings',
		'/settings/posting',
		'/settings/scheduling',
		'/settings/api',
		'/settings/instance',
		'/insights',
		'/'
	]) {
		await page.goto(path);
		await page.waitForLoadState('networkidle');
		// Give hydration and the data fetches a moment to finish.
		await page.waitForTimeout(500);
	}

	expect(violations).toEqual([]);
});

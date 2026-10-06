import { createHmac } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, test, type Page } from '@playwright/test';
import {
	E2E_ACCOUNT,
	E2E_D1_FLAGS,
	attachUntilAnswered,
	clickUntilVisible,
	e2eVars,
	fillUntilKept
} from './e2e-env';

/** RFC 6238 TOTP (SHA-1, 30s) for the base32 secret shown on setup-2fa. */
function totpCode(secretBase32: string, timeMs = Date.now()): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	const clean = secretBase32.replace(/[^A-Z2-7]/gi, '').toUpperCase();
	let bits = '';
	for (const c of clean) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
	const bytes: number[] = [];
	for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
	const msg = Buffer.alloc(8);
	msg.writeBigUInt64BE(BigInt(Math.floor(timeMs / 30_000)));
	const hmac = createHmac('sha1', Buffer.from(bytes)).update(msg).digest();
	const offset = hmac[hmac.length - 1] & 0x0f;
	return (((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000) + '').padStart(6, '0');
}

const vars = e2eVars();
// .dev.vars may set SKIP_TOTP=1 (local convenience): sign-in then lands in the
// app directly and the enroll/verify steps are skipped.
const SKIP_TOTP = ['1', 'true', 'yes', 'on'].includes((vars.SKIP_TOTP || '').toLowerCase());
const DRAFT_TEXT = `e2e smoke ${Date.now()}`;

/**
 * Seed a firewalled Bluesky connection directly in the test D1. Its PDS is
 * rejected by server-side validation, so publishing fails fast and offline
 * without ever touching the network.
 */
/** Encrypt credentials the way the Worker expects (v1:iv:tag:ciphertext). */
async function encryptForTest(creds: Record<string, unknown>): Promise<string> {
	const { webcrypto } = await import('node:crypto');
	const keyHex = vars.APP_ENCRYPTION_KEY;
	const raw = Buffer.from(keyHex, 'hex');
	const key = await webcrypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
	const iv = webcrypto.getRandomValues(new Uint8Array(12));
	const plaintext = Buffer.from(JSON.stringify(creds));
	const packed = Buffer.from(
		await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
	);
	// v1:iv:tag:ciphertext — the IV is separate from the packed output.
	const b64 = (b: Buffer) => b.toString('base64');
	return `v1:${b64(Buffer.from(iv))}:${b64(packed.subarray(-16))}:${b64(packed.subarray(0, -16))}`;
}

async function seedFirewalledBluesky(page: Page, handle: string): Promise<string> {
	const { execSync } = await import('node:child_process');
	const { randomUUID } = await import('node:crypto');
	const blob = await encryptForTest({
		handle,
		appPassword: 'xxxx',
		did: `did:plc:${handle}`,
		pdsHost: 'https://localhost:1'
	});
	const me = await page.request.get('/api/auth/me').then((r) => r.json());
	const connId = randomUUID();
	const now = Date.now();
	execSync(
		`node scripts/wrangler.mjs d1 execute DB --local ${E2E_D1_FLAGS} --command "INSERT INTO connections (id, user_id, platform, handle, credentials_encrypted, meta_json, status, created_at, updated_at) VALUES ('${connId}', '${me.user.id}', 'bluesky', '${handle}', '${blob}', '{}', 'active', ${now}, ${now})"`,
		{ stdio: 'pipe' }
	);
	return connId;
}

/** A Mastodon row is enough for the composer; publish never touches it here. */
async function seedMastodon(page: Page, handle: string): Promise<string> {
	const { execSync } = await import('node:child_process');
	const { randomUUID } = await import('node:crypto');
	const blob = await encryptForTest({
		accessToken: 'xxxx',
		instanceUrl: 'https://mastodon.test'
	});
	const me = await page.request.get('/api/auth/me').then((r) => r.json());
	const connId = randomUUID();
	const now = Date.now();
	execSync(
		`node scripts/wrangler.mjs d1 execute DB --local ${E2E_D1_FLAGS} --command "INSERT INTO connections (id, user_id, platform, handle, instance_url, credentials_encrypted, meta_json, status, created_at, updated_at) VALUES ('${connId}', '${me.user.id}', 'mastodon', '${handle}', 'https://mastodon.test', '${blob}', '{}', 'active', ${now}, ${now})"`,
		{ stdio: 'pipe' }
	);
	return connId;
}

async function deleteConnection(id: string): Promise<void> {
	const { execSync } = await import('node:child_process');
	execSync(
		`node scripts/wrangler.mjs d1 execute DB --local ${E2E_D1_FLAGS} --command "DELETE FROM connections WHERE id='${id}'"`,
		{ stdio: 'pipe' }
	);
}

test.describe.configure({ mode: 'serial' });
let page: Page;

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
});

test.afterAll(async () => {
	await page.close();
});

test('signs in and enrolls 2fa', async () => {
	test.setTimeout(120_000);
	await page.goto('/compose');
	await expect(page).toHaveURL(/\/login$/);
	// The login page wears the same mark as the app, not a letter from its name.
	await expect(page.getByTestId('brand-mark')).toBeVisible();
	// Both fields have to survive hydration; see tests/e2e/e2e-env.ts.
	await fillUntilKept(page.getByLabel('Email'), E2E_ACCOUNT.email);
	await fillUntilKept(page.getByLabel('Password'), E2E_ACCOUNT.password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	if (SKIP_TOTP) {
		// Password is the whole login in this mode.
		await expect(page).toHaveURL(/\/compose$/, { timeout: 20000 });
		return;
	}
	await expect(page).toHaveURL(/\/login\/setup-2fa$/);
	const secret = (await page.locator('code').first().innerText()).replace(/\s+/g, '');
	await page.getByText('I saved these backup codes').click();
	// Codes can straddle a 30s boundary: retry with a fresh code.
	for (let attempt = 0; attempt < 3; attempt++) {
		await page.getByPlaceholder('123456').fill(totpCode(secret));
		await page.getByRole('button', { name: 'Confirm and continue' }).click();
		try {
			await expect(page).toHaveURL(/\/(compose)?$/, { timeout: 4000 });
			return;
		} catch {
			/* retry */
		}
	}
	throw new Error('2fa enroll did not complete');
});

test('autosaves a draft and restores it on reload', async () => {
	await page.goto('/compose');
	await fillUntilKept(page.getByTestId('segment-input-0'), DRAFT_TEXT);
	await expect
		.poll(() => new URL(page.url()).searchParams.get('id'), { timeout: 30000 })
		.toBeTruthy();
	await page.reload();
	// wrangler dev serves local D1 slowly: allow a generous restore window.
	await expect(page.getByTestId('segment-input-0')).toHaveValue(DRAFT_TEXT, { timeout: 60000 });
});

test('draft appears in posts with an undoable delete', async () => {
	await page.goto('/posts');
	await expect(page.getByText(DRAFT_TEXT.slice(0, 24))).toBeVisible();
	await clickUntilVisible(
		page,
		page.getByRole('button', { name: 'Remove' }).first(),
		page.getByRole('alertdialog')
	);
	await expect(page.getByRole('alertdialog')).toBeVisible();
	await page.getByRole('button', { name: 'Remove', exact: true }).last().click();
	await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
	await page.getByRole('button', { name: 'Undo' }).click();
	await expect(page.getByText(DRAFT_TEXT.slice(0, 24))).toBeVisible();
});

test('schedule panel requires accounts and outbox loads', async () => {
	await page.goto('/compose');
	await clickUntilVisible(
		page,
		page.getByTestId('schedule-toggle'),
		page.getByTestId('schedule-panel')
	);
	await expect(page.getByTestId('schedule-panel')).toBeVisible();
	await page.goto('/posts');
	await expect(page.getByRole('heading', { name: 'Posts', exact: true })).toBeVisible();
});

/**
 * The three OAuth platforms need app credentials only the deployment owner can
 * create, so a fresh install has none. The dialog must then say what a platform
 * needs — for that platform, when it is picked — instead of offering a connect
 * button whose request can only come back "not configured".
 *
 * Runs before any spec connects an account: the empty state is asserted here.
 */
const OAUTH_SETUP = [
	{
		id: 'linkedin',
		name: 'LinkedIn',
		secrets: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
		command: 'npm run secrets:put LINKEDIN_CLIENT_ID LINKEDIN_CLIENT_SECRET'
	},
	{
		id: 'threads',
		name: 'Threads',
		secrets: ['THREADS_APP_ID', 'THREADS_APP_SECRET'],
		command: 'npm run secrets:put THREADS_APP_ID THREADS_APP_SECRET'
	},
	{
		id: 'x',
		name: 'X',
		secrets: ['X_CLIENT_ID', 'X_CLIENT_SECRET'],
		command: 'npm run secrets:put X_CLIENT_ID X_CLIENT_SECRET'
	}
] as const;

test('a platform without app credentials shows its setup steps, not a failure', async () => {
	test.setTimeout(120_000);
	// A developer whose .dev.vars holds real credentials sees the connect path
	// instead; only the platforms this instance cannot connect are asserted.
	const missing = OAUTH_SETUP.filter((p) => !p.secrets.every((s) => Boolean(vars[s])));
	test.skip(missing.length === 0, 'every OAuth platform is configured in .dev.vars');

	await page.goto('/accounts');

	// The empty state promises only what this instance can connect.
	const emptyState = page.getByText(/^No accounts yet\./);
	await expect(emptyState).toBeVisible();
	const promised = (await emptyState.textContent()) ?? '';
	expect(promised).toContain('Bluesky');
	expect(promised).toContain('Mastodon');
	for (const platform of OAUTH_SETUP) {
		const configured = !missing.some((p) => p.id === platform.id);
		expect([platform.id, promised.includes(platform.name)]).toEqual([platform.id, configured]);
	}

	await clickUntilVisible(
		page,
		page.getByRole('button', { name: 'Connect new' }),
		page.getByRole('heading', { name: 'Add Integration' })
	);

	// Cards mark what needs setup, and nothing names a secret until one is
	// picked: the wall of environment variables is gone.
	for (const platform of OAUTH_SETUP) {
		const chip = page.getByTestId(`needs-setup-${platform.id}`);
		if (missing.some((p) => p.id === platform.id)) await expect(chip).toBeVisible();
		else await expect(chip).toHaveCount(0);
	}
	await expect(page.getByText(/CLIENT_ID|APP_ID|SECRET/)).toHaveCount(0);

	let connectCalls = 0;
	await page.route('**/api/connections/*', (route) => {
		connectCalls += 1;
		return route.continue();
	});

	// The chip is the card's action for a platform in this state, and the icon's
	// <title> ("x", "linkedin") prefixes the button's accessible name, so pick
	// it by test id rather than by name.
	const probe = missing[0];
	await page.getByTestId(`needs-setup-${probe.id}`).click();
	await expect(page.getByTestId('platform-setup-panel')).toBeVisible();
	await expect(
		page.getByRole('heading', { name: `${probe.name} isn't enabled yet` })
	).toBeVisible();
	// The steps stay collapsed so the panel is three lines and two rows, not a
	// wall of text: the redirect URI lives under step 1, the secrets under 2.
	await expect(page.getByTestId('setup-callback-uri')).toBeHidden();
	await page.getByTestId('setup-step-1').click();
	const redirectUri = page.getByTestId('setup-callback-uri');
	await expect(redirectUri).toBeVisible();
	await expect(redirectUri).toContainText(`/api/connections/${probe.id}/callback`);
	await page.getByTestId('setup-step-2').click();
	await expect(page.getByTestId('setup-command')).toHaveText(probe.command);
	for (const secret of probe.secrets) {
		await expect(page.getByText(secret, { exact: true })).toBeVisible();
	}
	// The other way to set them, for a reader without the checkout: the panel
	// must not send someone to a command they cannot run.
	await expect(page.getByTestId('platform-setup-panel')).toContainText('Cloudflare dashboard');
	// Copying is the point of the block: the value has to reach the clipboard,
	// not just look like it did.
	await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
	const copyUri = page.getByRole('button', { name: 'Copy the redirect URI' });
	await copyUri.click();
	// Icon-only button: the confirmation is the tick, announced to a screen
	// reader through the status region rather than drawn as text.
	await expect(page.getByTestId('copy-status').first()).toHaveText('Copied to clipboard');
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
		((await redirectUri.textContent()) ?? '').trim()
	);
	// The card is a setup entry point, not a connect attempt.
	expect(connectCalls).toBe(0);

	// Each platform explains itself alone: X also carries its pricing note.
	await page.getByRole('button', { name: /All platforms/ }).click();
	if (missing.some((p) => p.id === 'x') && probe.id !== 'x') {
		await page.getByTestId('needs-setup-x').click();
		await expect(page.getByTestId('platform-setup-panel')).toContainText('pay-per-use');
		await page.getByRole('button', { name: /All platforms/ }).click();
	}

	await page.getByRole('button', { name: 'Close add integration dialog' }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	// Closing after looking at a platform must leave no error behind: this used
	// to be where "X is not configured (X_CLIENT_ID missing)" appeared.
	await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a stale callback error is explained, then dropped from the URL', async () => {
	test.setTimeout(120_000);
	// The callback redirects to /accounts?error=<code>. Before this, the code was
	// echoed verbatim and stayed in the address bar, so a reload replayed an old
	// failure next to a connection that had since succeeded.
	await page.goto('/accounts?error=oauth_expired');
	const alert = page.getByRole('alert');
	await expect(alert).toContainText(/expired/i);
	await expect(alert).not.toContainText('oauth_expired');
	await expect(page).toHaveURL(/\/accounts$/);
	await page.reload();
	await expect(page.getByRole('alert')).toHaveCount(0);
});
test('settings defaults persist', async () => {
	await page.goto('/settings');
	// The version is injected at build time and shown here, so a bug report can
	// name it; asserting it also proves the vite define reached the bundle.
	await expect(page.getByText(/^Version \d+\.\d+\.\d+/)).toBeVisible();
	// The update line sits under the version: either a release link (when a
	// newer one exists) or the manual check. It must never be blank.
	await expect(page.getByTestId('version-line')).toContainText(/is available|Check for updates/);
	await page.getByLabel('Mastodon visibility').selectOption('private');
	await page.getByRole('button', { name: 'Save defaults' }).click();
	await expect(page.getByText('Defaults saved')).toBeVisible();
	const apiSettings = await page.request.get('/api/settings').then((r) => r.json());
	if (apiSettings.settings?.mastoVisibility !== 'private') {
		throw new Error(`settings API shows ${JSON.stringify(apiSettings)}`);
	}
	await page.reload();
	await expect(page.getByLabel('Mastodon visibility')).toHaveValue('private');
});

test('scheduled publishing card explains the tick and mints a token', async () => {
	await page.goto('/settings');
	const section = page.getByTestId('scheduler-section');
	await expect(section).toBeVisible();
	// The status line is derived from the heartbeat; a fresh instance has none.
	await expect(page.getByTestId('scheduler-status-line')).toContainText(/No tick yet|Last tick/);

	// Generate, reveal once, then revoke: the token is a credential, so it must
	// never come back from a later read.
	await page.getByTestId('tick-token-generate').click();
	// Generating is not destructive, so the confirm button takes focus.
	await expect
		.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? ''))
		.toBe('confirm-dialog-ok');
	// The confirmation dialog is the only "OK" on screen; the card's own buttons
	// are matched by test id because "Generate" appears in several places.
	await page.getByTestId('confirm-dialog-ok').click();
	const revealed = page.getByTestId('tick-token-value');
	await expect(revealed).toBeVisible();
	const token = (await revealed.textContent())?.trim() ?? '';
	expect(token.startsWith('tick_')).toBe(true);

	const status = await page.request.get('/api/scheduler/tick-token').then((r) => r.json());
	expect(status.configured).toBe(true);
	expect(JSON.stringify(status)).not.toContain(token);

	await page.getByRole('button', { name: 'I have saved it' }).click();
	await expect(revealed).toBeHidden();
	await page.getByTestId('scheduler-section').getByRole('button', { name: 'Revoke' }).click();
	// Revoking is destructive, so focus goes to the safe control: opening this
	// dialog and pressing Enter must not destroy the token.
	await expect
		.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? ''))
		.toBe('confirm-dialog-cancel');
	await page.getByTestId('confirm-dialog-ok').click();
	await expect(page.getByTestId('tick-token-status')).toContainText('No tick token');
});

test('the tick runs on demand and reports back', async () => {
	await page.goto('/settings');
	await clickUntilVisible(
		page,
		page.getByRole('button', { name: 'Tick now' }),
		page.getByText(/^Tick ran:/)
	);
	await expect(page.getByText(/^Tick ran:/)).toBeVisible();
	// A heartbeat now exists, so the status line stops saying "No tick yet".
	await expect(page.getByTestId('scheduler-status-line')).toContainText('Last tick');
});

test('profile save leaves unsaved new-post defaults alone', async () => {
	await page.goto('/settings');
	const before = await page.request.get('/api/settings').then((r) => r.json());
	const originalName: string | null = before.displayName ?? null;

	// Change a default but never save it, then save the profile: the profile card
	// owns the name, so the pending default must not ride along with it.
	const dirty = before.settings.mastoVisibility === 'unlisted' ? 'direct' : 'unlisted';
	await page.getByLabel('Mastodon visibility').selectOption(dirty);
	await page.getByLabel('Display Name').fill('Cross-card probe');
	await page.getByRole('button', { name: 'Save Changes' }).click();
	await expect(page.getByText('Profile saved')).toBeVisible();

	const after = await page.request.get('/api/settings').then((r) => r.json());
	expect(after.displayName).toBe('Cross-card probe');
	expect(after.settings.mastoVisibility).toBe(before.settings.mastoVisibility);

	// Leave the workspace as the following tests expect to find it.
	await page.request.patch('/api/settings', { data: { displayName: originalName ?? '' } });
});

test('profile picture dialog saves on its own and validates the URL', async () => {
	await page.goto('/settings');
	const before = await page.request.get('/api/settings').then((r) => r.json());
	const originalPicture: string = before.settings?.profilePictureUrl ?? '';

	await page.getByRole('button', { name: 'Add profile picture' }).click();
	// A primary confirm focuses the button that continues, not Cancel: the
	// dialog is a form, and the user came here to save. (The danger tone is the
	// other way round — see ConfirmDialog.)
	await expect
		.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? ''))
		.toBe('confirm-dialog-ok');
	await page.locator('#profile-picture-url').fill('http://insecure.example/me.png');
	await page.getByTestId('confirm-dialog-ok').click();
	await expect(page.getByText('Enter an https:// image URL')).toBeVisible();
	// Rejected locally: nothing reached the API.
	expect(
		(await page.request.get('/api/settings').then((r) => r.json())).settings.profilePictureUrl
	).toBe(originalPicture);

	// Fixing the URL clears the message before the next save attempt.
	await page.locator('#profile-picture-url').fill('https://example.com/me.png');
	await expect(page.getByText('Enter an https:// image URL')).toBeHidden();
	await page.getByTestId('confirm-dialog-ok').click();
	await expect(page.getByText('Profile picture saved')).toBeVisible();

	const saved = await page.request.get('/api/settings').then((r) => r.json());
	expect(saved.settings.profilePictureUrl).toBe('https://example.com/me.png');
	// The picture dialog owns the picture alone.
	expect(saved.displayName).toBe(before.displayName);

	// Remove it again so later tests meet the workspace they expect.
	await page.getByRole('button', { name: 'Edit profile picture' }).click();
	await page.getByRole('button', { name: 'Remove picture' }).click();
	await expect(page.getByText('Profile picture removed')).toBeVisible();
	expect(
		(await page.request.get('/api/settings').then((r) => r.json())).settings.profilePictureUrl
	).toBe(originalPicture);
});

test('profile menu appears after login with workspace navigation', async () => {
	// Guards the stale-layout-data regression: without fresh layout data after
	// auth, the root layout keeps user:null and the menu never renders.
	await page.goto('/compose');
	await expect(page.getByRole('button', { name: 'Profile menu' })).toBeVisible();
	await clickUntilVisible(
		page,
		page.getByRole('button', { name: 'Profile menu' }),
		page.getByRole('menuitem', { name: 'Settings' })
	);
	await expect(page.getByRole('menuitem', { name: 'Settings' })).toBeVisible();
	await expect(page.getByRole('menuitem', { name: 'API docs' })).toBeVisible();
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: 'Workspace menu' }).click();
	await expect(page.getByRole('menuitem', { name: 'Compose' })).toBeVisible();
	await expect(page.getByRole('menuitem', { name: 'Posts' })).toBeVisible();
	await expect(page.getByRole('menuitem', { name: 'Accounts' })).toBeVisible();
	await page.getByRole('menuitem', { name: 'Posts' }).click();
	await expect(page).toHaveURL(/\/posts/);
});

test('publish asks for confirmation listing destinations', async () => {
	test.setTimeout(120_000);
	await seedFirewalledBluesky(page, 'test.bsky.social');
	await page.goto('/compose');
	await clickUntilVisible(
		page,
		page.getByTestId('destinations-toggle'),
		page.getByRole('button', { name: /test\.bsky\.social/ }).first()
	);
	// The dock truncates the handle to "test"; match the row's accessible name.
	await expect(page.getByRole('button', { name: /test\.bsky\.social/ }).first()).toBeVisible({
		timeout: 15000
	});
	await page.keyboard.press('Escape');
	await fillUntilKept(page.getByTestId('segment-input-0'), 'confirm flow probe');
	// Button opens the dialog instead of publishing.
	await page.getByRole('button', { name: 'Publish', exact: true }).click();
	const dialog = page.getByTestId('publish-confirm-destinations');
	await expect(dialog).toBeVisible();
	await expect(dialog.locator('[title="Bluesky: test.bsky.social"]')).toBeVisible();
	// It is a dialog, so focus moves into it: a keyboard user can confirm with
	// Enter or leave with Escape without hunting for the popover.
	await expect
		.poll(() =>
			page.evaluate(() => {
				const active = document.activeElement as HTMLElement | null;
				const popover = document.querySelector('[role="dialog"][aria-label="Confirm post"]');
				return Boolean(active && popover && popover.contains(active));
			})
		)
		.toBe(true);
	// Cancel publishes nothing.
	await page.getByRole('button', { name: 'Keep editing' }).click();
	await expect(dialog).toBeHidden();
	// Escape dismisses it too. The popover is a dialog, and Escape is the one
	// key a keyboard user needs to get out of it — the compose shortcut guard
	// used to swallow it, leaving no way out but a mouse.
	await page.getByRole('button', { name: 'Publish', exact: true }).click();
	await expect(dialog).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	// Cmd/Ctrl+Enter routes through the same confirmation.
	await page.getByTestId('segment-input-0').press('Meta+Enter');
	await expect(dialog).toBeVisible();
	// Hold the publish request so the flow is observable: confirming must
	// close the popover, and the main button must own the progress state.
	await page.route('**/api/drafts/*/publish', async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 1500));
		await route.continue();
	});
	// Confirm sends; the firewalled PDS fails deterministically server-side.
	await page.getByTestId('confirm-dialog-ok').click();
	await expect(dialog).toBeHidden();
	await expect(page.getByTestId('publish-now')).toHaveAttribute('aria-busy', 'true');
	await expect(page.getByTestId('publish-now')).toContainText('Publishing');
	// A failure reopens the popover with per-destination detail.
	const progress = page.getByTestId('publish-progress');
	await expect(progress).toBeVisible({ timeout: 15000 });
	const destination = page.getByTestId('publish-dest');
	await expect(destination).toHaveAttribute('data-status', 'failed', { timeout: 30000 });
	await expect(destination).toContainText(/isn’t allowed|needs reconnect|failed/i);
	await expect(page.getByText(/isn’t allowed|needs reconnect|failed/i).first()).toBeVisible({
		timeout: 30000
	});
	// Closing the failure view dismisses the popover.
	await page.getByTestId('publish-progress-close').click();
	await expect(dialog).toBeHidden();
	// The failed publish must not wipe the composer: refreshing connections
	// used to re-trigger the URL watcher against a stale `page.url`.
	await expect(page.getByTestId('segment-input-0')).toHaveValue('confirm flow probe');
	await expect(page).toHaveURL(/\?id=/);
	await page.unroute('**/api/drafts/*/publish');
});

test('publishing to two destinations tracks each one', async () => {
	test.setTimeout(120_000);
	await seedFirewalledBluesky(page, 'second.bsky.social');
	await page.goto('/compose');
	await fillUntilKept(page.getByTestId('segment-input-0'), 'fan-out probe');
	await clickUntilVisible(
		page,
		page.getByRole('button', { name: 'Publish', exact: true }),
		page.getByTestId('publish-confirm-destinations')
	);
	const dialog = page.getByTestId('publish-confirm-destinations');
	await expect(dialog).toBeVisible();
	await expect(dialog.locator('[title="Bluesky: test.bsky.social"]')).toBeVisible();
	await expect(dialog.locator('[title="Bluesky: second.bsky.social"]')).toBeVisible();
	await page.getByTestId('confirm-dialog-ok').click();
	// One progress row per destination, each tracked independently.
	const rows = page.getByTestId('publish-dest');
	await expect(rows).toHaveCount(2, { timeout: 15000 });
	await expect(rows.nth(0)).toHaveAttribute('data-status', 'failed', { timeout: 30000 });
	await expect(rows.nth(1)).toHaveAttribute('data-status', 'failed', { timeout: 30000 });
	await page.getByTestId('publish-progress-close').click();
	await expect(dialog).toBeHidden();
});

test('a saved draft restores the accounts it was written for', async () => {
	test.setTimeout(120_000);
	// Both bluesky accounts exist by now (seeded by the two tests above);
	// reuse them so the shared connection list stays unchanged.
	await page.goto('/compose');
	await clickUntilVisible(
		page,
		page.getByTestId('destinations-toggle'),
		page.locator('button[title="Bluesky: test.bsky.social"]')
	);
	const first = page.locator('button[title="Bluesky: test.bsky.social"]');
	const second = page.locator('button[title="Bluesky: second.bsky.social"]');
	await expect(first).toBeVisible({ timeout: 15000 });
	// Select just one of the two accounts, clearing the default (all active).
	await page.getByRole('button', { name: 'Clear all' }).click();
	await first.click();
	await expect(first).toHaveAttribute('aria-pressed', 'true');
	await expect(second).toHaveAttribute('aria-pressed', 'false');
	await page.keyboard.press('Escape');
	await fillUntilKept(page.getByTestId('segment-input-0'), 'selection restore probe');
	await expect
		.poll(() => new URL(page.url()).searchParams.get('id'), { timeout: 30000 })
		.toBeTruthy();
	// Reopen the saved draft — the one-account selection must come back, not
	// the default set of every active account.
	const savedUrl = page.url();
	await page.goto(savedUrl);
	await expect(page.getByTestId('segment-input-0')).toHaveValue('selection restore probe', {
		timeout: 60000
	});
	// The value above is server-rendered, so it can be on screen before Svelte
	// has hydrated. A bare click here is lost and the popover never opens; this
	// is the race clickUntilVisible exists for (see tests/e2e/e2e-env.ts).
	await clickUntilVisible(
		page,
		page.getByTestId('destinations-toggle'),
		page.locator('button[title="Bluesky: test.bsky.social"]')
	);
	await expect(page.locator('button[title="Bluesky: test.bsky.social"]')).toHaveAttribute(
		'aria-pressed',
		'true',
		{ timeout: 15000 }
	);
	await expect(page.locator('button[title="Bluesky: second.bsky.social"]')).toHaveAttribute(
		'aria-pressed',
		'false'
	);
	await expect(page.getByTestId('destinations-toggle')).toContainText('1 selected');
});

test('publish without asking runs headless and still reports failures', async () => {
	test.setTimeout(120_000);
	await page.evaluate(() => localStorage.setItem('cogsend-skip-publish-confirm', '1'));
	await page.goto('/compose');
	await fillUntilKept(page.getByTestId('segment-input-0'), 'skip-ask fan-out probe');
	// No confirmation dialog: the click publishes straight away.
	await page.getByTestId('publish-now').click();
	await expect(page.getByTestId('publish-confirm-destinations')).toHaveCount(0);
	await expect(page.getByText(/isn’t allowed|needs reconnect|failed/i).first()).toBeVisible({
		timeout: 30000
	});
	// The button returns to its idle label once every destination settled.
	await expect(page.getByTestId('publish-now')).toHaveText(/^Publish\s*$/, { timeout: 30000 });
	await expect(page.getByTestId('segment-input-0')).toHaveValue('skip-ask fan-out probe');
	await page.evaluate(() => localStorage.removeItem('cogsend-skip-publish-confirm'));
});

test('api key works logged out, stays out of key management', async () => {
	test.setTimeout(120_000);
	await page.goto('/settings');
	await expect(page.getByTestId('api-key-section')).toBeVisible();
	const mcpSetup = page.getByTestId('mcp-setup');
	await expect(mcpSetup).toBeVisible();
	const origin = new URL(page.url()).origin;
	await expect(page.getByTestId('mcp-endpoint')).toHaveText(`${origin}/api/mcp`);
	await expect(mcpSetup).toContainText('Claude Code');
	await expect(mcpSetup).toContainText('OpenAI Codex');
	await expect(mcpSetup.getByRole('link', { name: 'API reference' })).toHaveAttribute(
		'href',
		'/api#mcp-server-heading'
	);
	await expect(mcpSetup.locator('pre').nth(0)).toContainText('Bearer ${COGSEND_API_KEY}');
	await expect(mcpSetup.locator('pre').nth(1)).toContainText(
		'bearer_token_env_var = "COGSEND_API_KEY"'
	);
	await expect(mcpSetup.locator('pre').nth(1)).toContainText(
		'default_tools_approval_mode = "prompt"'
	);
	await expect(page.locator('input[name="api-key-scopes"][value="read-write"]')).toBeChecked();
	await page.locator('input[name="api-key-scopes"][value="read"]').check();
	await clickUntilVisible(
		page,
		page.getByRole('button', { name: 'Generate API key' }),
		page.getByTestId('confirm-dialog-ok')
	);
	await page.getByTestId('confirm-dialog-ok').click();
	const reveal = page.getByTestId('api-key-reveal');
	await expect(reveal).toBeVisible({ timeout: 15000 });
	const rawKey = await page.getByTestId('api-key-value').innerText();
	expect(rawKey.trim()).toMatch(/^cog_[0-9a-fA-F]{64}$/);
	await page.getByRole('button', { name: 'I have saved it' }).click();
	await expect(reveal).toBeHidden();
	await expect(page.getByTestId('api-key-status')).toContainText(rawKey.trim().slice(0, 12));
	// Dismissing the one-time reveal must remove the complete key from rendered markup.
	expect(await page.content()).not.toContain(rawKey.trim());

	// The official Streamable HTTP client can initialize and call a read tool with this fresh key.
	const supportedClient = new Client(
		{ name: 'cogsend-settings-e2e', version: '1.0.0' },
		{ versionNegotiation: { mode: { pin: '2026-07-28' } } }
	);
	const supportedTransport = new StreamableHTTPClientTransport(new URL(`${origin}/api/mcp`), {
		requestInit: { headers: { Authorization: `Bearer ${rawKey.trim()}` } }
	});
	await supportedClient.connect(supportedTransport);
	const { tools } = await supportedClient.listTools();
	expect(tools.map((tool) => tool.name)).toContain('list_drafts');
	const supportedRead = await supportedClient.callTool({
		name: 'list_drafts',
		arguments: { limit: 1 }
	});
	expect(supportedRead.isError).not.toBe(true);
	await supportedClient.close();

	// Logged-out Node fetch (no cookies): the read-only key can read but cannot write.
	let currentKey = rawKey.trim();
	let keyed = { Authorization: `Bearer ${currentKey}` };
	const drafts = await fetch(`${origin}/api/drafts`, { headers: keyed });
	expect(drafts.status).toBe(200);
	const mcpCall = (
		key: string,
		name = 'create_draft',
		args: Record<string, unknown> = { title: 'Read-only scope check' }
	) =>
		fetch(`${origin}/api/mcp`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${key}`,
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
				'mcp-method': 'tools/call',
				'mcp-name': name,
				'mcp-protocol-version': '2026-07-28'
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: {
					name,
					arguments: args,
					_meta: {
						'io.modelcontextprotocol/protocolVersion': '2026-07-28',
						'io.modelcontextprotocol/clientCapabilities': {}
					}
				}
			})
		});
	const readOnlyRead = await mcpCall(currentKey, 'list_drafts', { limit: 1 }).then((response) =>
		response.json()
	);
	expect(readOnlyRead.result.isError).not.toBe(true);
	expect(readOnlyRead.result.structuredContent.drafts).toEqual(expect.any(Array));
	const readOnlyWrite = await mcpCall(currentKey).then((response) => response.json());
	expect(readOnlyWrite.result.isError).toBe(true);
	expect(readOnlyWrite.result.structuredContent).toMatchObject({ status: 403 });

	// Replace the key with read+write. Replacement must revoke the first key immediately.
	await page.locator('input[name="api-key-scopes"][value="read-write"]').check();
	await clickUntilVisible(
		page,
		page.getByRole('button', { name: 'Generate replacement' }),
		page.getByTestId('confirm-dialog-ok')
	);
	await page.getByTestId('confirm-dialog-ok').click();
	await expect(page.getByTestId('api-key-reveal')).toBeVisible({ timeout: 15000 });
	const replacementKey = (await page.getByTestId('api-key-value').innerText()).trim();
	expect(replacementKey).toMatch(/^cog_[0-9a-fA-F]{64}$/);
	await page.getByRole('button', { name: 'I have saved it' }).click();
	expect(await page.content()).not.toContain(replacementKey);
	expect(
		(await fetch(`${origin}/api/drafts`, { headers: { Authorization: `Bearer ${currentKey}` } }))
			.status
	).toBe(401);
	expect((await mcpCall(currentKey)).status).toBe(401);
	currentKey = replacementKey;
	keyed = { Authorization: `Bearer ${currentKey}` };
	const writeAllowed = await mcpCall(currentKey).then((response) => response.json());
	expect(writeAllowed.result.isError).not.toBe(true);
	expect(writeAllowed.result.structuredContent.draft.title).toBe('Read-only scope check');
	// …but cannot touch key management or credentials.
	expect((await fetch(`${origin}/api/key`, { headers: keyed })).status).toBe(401);
	expect(
		(
			await fetch(`${origin}/api/connections/bluesky`, {
				method: 'POST',
				headers: { ...keyed, 'Content-Type': 'application/json' },
				body: '{}'
			})
		).status
	).toBe(401);
	expect((await fetch(`${origin}/api/drafts`)).status).toBe(401);

	// Docs page renders for the session.
	await page.goto('/api');
	await expect(page.getByRole('heading', { name: 'API' })).toBeVisible();
	await expect(page.getByText('Authorization: Bearer').first()).toBeVisible();

	// Revoke in-session; the logged-out key dies with it.
	await page.goto('/settings');
	await clickUntilVisible(
		page,
		page.getByRole('button', { name: 'Revoke' }),
		page.getByTestId('confirm-dialog-ok')
	);
	await page.getByTestId('confirm-dialog-ok').click();
	await expect(page.getByTestId('api-key-status')).toContainText('No active key');
	expect((await fetch(`${origin}/api/drafts`, { headers: keyed })).status).toBe(401);
	expect((await mcpCall(currentKey)).status).toBe(401);
});

test('composer chrome: counts, thread cards and override tabs', async () => {
	await page.goto('/compose');
	await expect(page.getByTestId('segment-input-0')).toBeVisible();
	// Count pill tracks the typed text against the strictest selected cap.
	await fillUntilKept(page.getByTestId('segment-input-0'), 'gauge probe text');
	// Let autosave land so the reset below restores saved state.
	await expect
		.poll(() => new URL(page.url()).searchParams.get('id'), { timeout: 30000 })
		.toBeTruthy();
	await expect(page.getByTestId('segment-count-0')).toContainText(/\/300|\/500/);

	// Bluesky override: add override, edit the card, unlink to re-sync.
	await page.getByTestId('add-override-toggle').click();
	await page.getByRole('button', { name: /test\.bsky\.social/ }).click();
	await expect(page.getByTestId('editor-tab-bluesky')).toBeVisible();
	await fillUntilKept(page.getByTestId('segment-input-0'), 'bluesky-only text');
	await expect(page.getByTestId('reset-platform-tab')).toBeVisible();
	await page.getByTestId('reset-platform-tab').click();
	await expect(page.getByTestId('reset-platform-tab')).toHaveCount(0);
	// Reset restores Global's body text in the card.
	await expect(page.getByTestId('segment-input-0')).toHaveValue('gauge probe text');
});

test('mastodon options follow the selected destinations', async () => {
	test.setTimeout(120_000);
	// The settings test leaves visibility=private; a stored default alone must
	// not surface the Mastodon strip while only Bluesky is selected.
	await page.goto('/compose');
	await expect(page.getByTestId('masto-options')).toHaveCount(0);

	const mastoId = await seedMastodon(page, 'masto@test');
	try {
		// The fresh composer selects every active account, Mastodon included.
		await page.goto('/compose');
		await expect(page.getByTestId('masto-options')).toBeVisible({ timeout: 15000 });
		await clickUntilVisible(
			page,
			page.getByTestId('masto-settings-toggle'),
			page.getByTestId('masto-visibility')
		);
		await expect(page.getByTestId('masto-visibility')).toBeVisible();
		await expect(page.getByTestId('masto-cw')).toBeVisible();
		await page.keyboard.press('Escape');

		// Deselecting Mastodon hides the strip again.
		await page.getByTestId('destinations-toggle').click();
		await page.getByRole('button', { name: 'Clear all' }).click();
		await page.locator('button[title="Bluesky: test.bsky.social"]').click();
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('masto-options')).toHaveCount(0);
	} finally {
		// Keep the shared connection list stable for the tests that follow.
		await deleteConnection(mastoId);
	}
});

test('short paste stays in the card', async () => {
	await page.goto('/compose');
	await page.getByTestId('segment-input-0').click();
	const short = 'Tiny paste stays in the card';
	await page.evaluate((text) => {
		const dt = new DataTransfer();
		dt.setData('text/plain', text);
		const ev = new ClipboardEvent('paste', {
			clipboardData: dt,
			bubbles: true,
			cancelable: true
		});
		document.querySelector('[data-testid="segment-input-0"]')?.dispatchEvent(ev);
	}, short);
	// Nothing to gain: no split, no extra cards. (A synthetic paste event has
	// no default insertion — only the split path can create cards.)
	await expect(page.getByTestId('segment-input-1')).toHaveCount(0);
});

test('overflow paste auto-splits across cards', async () => {
	await page.goto('/compose');
	await clickUntilVisible(
		page,
		page.getByTestId('add-override-toggle'),
		page.getByRole('button', { name: /test\.bsky\.social/ })
	);
	await page.getByRole('button', { name: /test\.bsky\.social/ }).click();
	await expect(page.getByTestId('editor-tab-bluesky')).toBeVisible();
	// 12 sentences ≈ 250+ chars: over Bluesky's 300 cap only when longer.
	const long = Array.from(
		{ length: 30 },
		(_, i) => `This is sentence number ${i} and it carries a decent amount of text.`
	).join(' ');
	await page.getByTestId('editor-tab-bluesky').click();
	await page.evaluate((text) => {
		const dt = new DataTransfer();
		dt.setData('text/plain', text);
		const ev = new ClipboardEvent('paste', {
			clipboardData: dt,
			bubbles: true,
			cancelable: true
		});
		document.querySelector('[data-testid="segment-input-0"]')?.dispatchEvent(ev);
	}, long);
	// The split produced multiple cards, each within the cap.
	await expect(page.getByTestId('segment-input-1')).toBeVisible();
	for (let i = 0; i < 3; i++) {
		const counter = page.getByTestId(`segment-count-${i}`);
		if (await counter.count()) {
			const [n, max] = (await counter.innerText()).split('/').map(Number);
			expect(n).toBeLessThanOrEqual(max);
		}
	}
});

/**
 * The link preview's title is `truncate` (nowrap), so it feeds the card's
 * min-content width; without min-w-0 on the card that single line stretched the
 * card past the composer column and the preview visually left the thread card.
 * The OG payload is stubbed because the regression needs only a long
 * single-line title — the real endpoint must not decide whether it reproduces.
 */
test('a long link preview stays inside its thread card', async () => {
	await page.goto('/compose');
	await page.route('**/api/link-preview*', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				url: 'https://example.com/long-title',
				title: `Example article — ${'a long unbroken page title '.repeat(12)}`,
				description: 'A description that wraps inside the card.',
				image: null,
				siteName: 'example.com'
			})
		})
	);
	// The second card is what makes the two widths comparable, so a
	// thread-capable destination has to be selected: a stored default from an
	// earlier test can leave only LinkedIn on.
	await clickUntilVisible(
		page,
		page.getByTestId('destinations-toggle'),
		page.locator('button[title="Bluesky: test.bsky.social"]')
	);
	const bluesky = page.locator('button[title="Bluesky: test.bsky.social"]');
	if ((await bluesky.getAttribute('aria-pressed')) !== 'true') await bluesky.click();
	await page.keyboard.press('Escape');

	await fillUntilKept(page.getByTestId('segment-input-0'), 'first post');
	await clickUntilVisible(
		page,
		page.getByTestId('add-thread-post'),
		page.getByTestId('segment-input-1')
	);
	await fillUntilKept(page.getByTestId('segment-input-1'), 'https://example.com/long-title');
	await expect(page.getByTestId('link-preview')).toBeVisible();

	const measured = await page.evaluate(() => {
		const box = (id: string) =>
			document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect();
		const plain = box('segment-card-0');
		const linked = box('segment-card-1');
		const preview = box('link-preview');
		return {
			plainWidth: Math.round(plain.width),
			linkedWidth: Math.round(linked.width),
			previewOverhang: Math.round(preview.right - linked.right),
			sideways: document.documentElement.scrollWidth - window.innerWidth
		};
	});
	// A card with a link is no wider than one without, its preview stays inside
	// it, and nothing pushes the document sideways.
	expect(measured.linkedWidth).toBe(measured.plainWidth);
	expect(measured.previewOverhang).toBeLessThanOrEqual(0);
	expect(measured.sideways).toBeLessThanOrEqual(0);
});

test('Alt+Arrow keys reorder thread posts and follow the media', async () => {
	await page.goto('/compose');
	await fillUntilKept(page.getByTestId('segment-input-0'), 'first post');
	await clickUntilVisible(
		page,
		page.getByTestId('add-thread-post'),
		page.getByTestId('segment-input-1')
	);
	await page.getByTestId('segment-input-1').fill('second post');
	await page.getByTestId('segment-input-1').focus();
	await page.keyboard.press('Alt+ArrowUp');
	// The former second post is now first.
	await expect(page.getByTestId('segment-input-0')).toHaveValue('second post');
	await expect(page.getByTestId('segment-input-1')).toHaveValue('first post');
});

test('navigating away with pending edits flushes the draft', async () => {
	await page.goto('/compose');
	const text = `flush probe ${Date.now()}`;
	await fillUntilKept(page.getByTestId('segment-input-0'), text);
	// Leave within the autosave debounce window via SPA navigation.
	await page.getByRole('button', { name: 'Workspace menu' }).click();
	await page.getByRole('menuitem', { name: 'Posts' }).click();
	await expect(page).toHaveURL(/\/posts/);
	// The flush runs during navigation: poll the API for the created draft.
	await expect
		.poll(
			async () => {
				const data = await page.request.get('/api/drafts').then((r) => r.json());
				return (data.drafts || []).some((d: { baseBody: string }) => d.baseBody.includes(text));
			},
			{ timeout: 20000 }
		)
		.toBeTruthy();
	// And it shows up in the UI after a reload.
	await page.reload();
	await expect(page.getByText(text)).toBeVisible({ timeout: 20000 });
});

test('publish confirmation can be skipped and reset from settings', async () => {
	await page.goto('/compose');
	await fillUntilKept(page.getByTestId('segment-input-0'), 'skip-ask probe');
	await clickUntilVisible(
		page,
		page.getByTestId('publish-now'),
		page.getByRole('dialog', { name: 'Confirm post' })
	);
	const dialog = page.getByRole('dialog', { name: 'Confirm post' });
	await expect(dialog).toBeVisible();
	await dialog.getByRole('checkbox').check();
	await page.getByRole('button', { name: 'Keep editing' }).click();
	expect(await page.evaluate(() => localStorage.getItem('cogsend-skip-publish-confirm'))).toBe('1');
	// Reset from Settings.
	await page.goto('/settings');
	const ask = page.getByRole('switch', { name: /Ask for confirmation before publishing/ });
	await expect(ask).not.toBeChecked();
	await ask.click();
	expect(
		await page.evaluate(() => localStorage.getItem('cogsend-skip-publish-confirm'))
	).toBeNull();
});

test('destinations dock shows on mobile layout', async () => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/compose');
	await expect(page.getByTestId('destinations-toggle')).toBeVisible();
	await expect(page.getByTestId('publish-now')).toBeVisible();
	await page.setViewportSize({ width: 1280, height: 800 });
});

test('the header keeps a Write button on a phone', async () => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/posts');
	await page.getByRole('link', { name: 'Write', exact: true }).click();
	await expect(page).toHaveURL(/\/compose$/);
	await page.setViewportSize({ width: 1280, height: 800 });
});

// Regression guard: the posts tab row, the insights stat grid and the API
// definition list all used to push the document wider than a phone screen.
test('key pages do not scroll sideways on a 320px phone', async () => {
	await page.setViewportSize({ width: 320, height: 700 });
	for (const path of [
		'/posts',
		'/posts?tab=drafts',
		'/insights',
		'/api',
		'/settings',
		'/compose'
	]) {
		await page.goto(path);
		await expect(page.getByRole('heading').first()).toBeVisible();
		await page.waitForTimeout(200);
		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth - window.innerWidth
		);
		expect(overflow, `${path} scrolls sideways by ${overflow}px at 320px`).toBeLessThanOrEqual(0);
	}
	await page.setViewportSize({ width: 1280, height: 800 });
});

test('duplicate API, insights page, and failed-tab deep link', async () => {
	const created = await page.request.post('/api/drafts', {
		data: { baseBody: 'e2e duplicate source' }
	});
	expect(created.status()).toBe(201);
	const source = (await created.json()).draft;

	const dup = await page.request.post(`/api/drafts/${source.id}/duplicate`);
	expect(dup.status()).toBe(201);
	const clone = (await dup.json()).draft;
	expect(clone.id).not.toBe(source.id);
	expect(clone.baseBody).toBe('e2e duplicate source');
	expect(clone.status).toBe('draft');

	// The clone opens in the composer with its content intact.
	await page.goto(`/compose?id=${clone.id}`);
	await expect(page.getByTestId('segment-input-0')).toHaveValue('e2e duplicate source');

	// Insights: stats with a period comparison, per-account numbers, no Best hour.
	await page.goto('/insights');
	await expect(page.getByRole('heading', { name: 'Insights' })).toBeVisible();
	await expect(page.getByTestId('insights-page')).toBeVisible();
	await expect(page.getByText('Delivery stats for the last 30 days')).toBeVisible();
	await expect(page.getByTestId('insights-stats')).toBeVisible();
	// Three cards only: published, scheduled, last post.
	await expect(page.getByTestId('insights-stats').getByText('Published')).toBeVisible();
	await expect(page.getByTestId('insights-stats').getByText('Scheduled')).toBeVisible();
	await expect(page.getByTestId('insights-stats').getByText('Last post')).toBeVisible();
	await expect(page.getByText('Success rate')).toHaveCount(0);
	await expect(page.getByTestId('insights-accounts')).toBeVisible();
	await expect(page.getByTestId('insight-account').first()).toBeVisible();
	await expect(page.getByText('Best hour', { exact: false })).toHaveCount(0);
	// Range switches refetch and relabel the whole page.
	await page.getByRole('button', { name: '90 days' }).click();
	await expect(page.getByText('Delivery stats for the last 13 weeks')).toBeVisible();
	await expect(page.getByText('Last 13 weeks').first()).toBeVisible();
	await page.getByRole('button', { name: '7 days' }).click();
	await expect(page.getByText('Delivery stats for the last 7 days')).toBeVisible();

	// A failing stats request shows a banner and keeps the last good numbers...
	await page.route('**/api/insights*', (route) =>
		route.fulfill({
			status: 500,
			contentType: 'application/json',
			body: JSON.stringify({ error: 'boom' })
		})
	);
	await page.getByRole('button', { name: '90 days' }).click();
	await expect(page.getByRole('alert')).toBeVisible();
	await expect(page.getByTestId('insights-stats')).toBeVisible();
	await page.unroute('**/api/insights*');

	// ...and a malformed 200 is rejected instead of crashing the page.
	await page.route('**/api/insights*', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: '{"unexpected":true}' })
	);
	await page.getByRole('button', { name: '30 days' }).click();
	await expect(page.getByText(/Unexpected response from the server/)).toBeVisible();
	await expect(page.getByTestId('insights-stats')).toBeVisible();
	await page.unroute('**/api/insights*');

	// The dashboard failure banner links here with the tab pre-selected.
	await page.goto('/posts?tab=failed');
	await expect(page.getByRole('link', { name: /^failed/ })).toHaveAttribute('aria-current', 'page');
});

test('posts account dropdown filters the feed', async () => {
	const { execSync } = await import('node:child_process');
	const { randomUUID } = await import('node:crypto');
	const connId = await seedFirewalledBluesky(page, 'filtered.bsky.social');
	const me = await page.request.get('/api/auth/me').then((r) => r.json());
	const now = Date.now();
	const draftId = randomUUID();
	execSync(
		`node scripts/wrangler.mjs d1 execute DB --local ${E2E_D1_FLAGS} --command "INSERT INTO drafts (id, user_id, title, base_body, status, created_at, updated_at) VALUES ('${draftId}', '${me.user.id}', NULL, 'dropdown probe', 'published', ${now}, ${now})"`,
		{ stdio: 'pipe' }
	);
	execSync(
		`node scripts/wrangler.mjs d1 execute DB --local ${E2E_D1_FLAGS} --command "INSERT INTO publish_targets (id, draft_id, connection_id, status, remote_post_id, attempt_count, created_at, updated_at) VALUES ('${randomUUID()}', '${draftId}', '${connId}', 'published', 'remote-filter', 1, ${now}, ${now})"`,
		{ stdio: 'pipe' }
	);

	await page.goto('/posts?tab=published');
	const trigger = page.getByRole('button', { name: 'Filter posts by account' });
	await expect(trigger).toBeVisible();
	// Bluesky handles drop the .bsky.social suffix in labels.
	const option = page.getByRole('menuitemradio', { name: 'filtered' });
	// The trigger is server-rendered, so it is visible before Svelte hydrates and
	// a bare click can be lost (see clickUntilVisible in tests/e2e/e2e-env.ts).
	await clickUntilVisible(page, trigger, option);
	await option.click();
	await expect(trigger).toContainText('filtered');
	await expect(page.getByText('dropdown probe')).toBeVisible();

	// The filter lives in the address, so a reload keeps it.
	await expect(page).toHaveURL(new RegExp(`/posts\\?tab=published&account=${connId}$`));
	await page.reload();
	await expect(trigger).toContainText('filtered');
	await expect(page.getByText('dropdown probe')).toBeVisible();
});

test('posts keeps its tab and search across a round trip', async () => {
	// An account none of the posts go to is dropped instead of stranding an
	// empty list. Its removal also shows the page has hydrated.
	await page.goto('/posts?tab=published&account=no-such-account');
	await expect(page).toHaveURL(/\/posts\?tab=published$/);

	const tabs = page.getByRole('group', { name: 'Filter posts by status' });
	const scheduled = tabs.getByRole('link', { name: /^scheduled/ });
	const published = tabs.getByRole('link', { name: /^published/ });
	const historyLength = await page.evaluate(() => history.length);
	await scheduled.click();
	await expect(page).toHaveURL(/\/posts\?tab=scheduled$/);
	await expect(scheduled).toHaveAttribute('aria-current', 'page');
	// Switching tabs replaces the entry, so Back still leaves Posts.
	expect(await page.evaluate(() => history.length)).toBe(historyLength);
	await published.click();
	await expect(published).toHaveAttribute('aria-current', 'page');

	const search = page.getByPlaceholder('Search posts...');
	await fillUntilKept(search, 'dropdown probe');
	await expect(page.getByText('dropdown probe')).toBeVisible();

	await page.getByRole('link', { name: 'Write', exact: true }).click();
	await expect(page).toHaveURL(/\/compose$/);
	await page.goBack();
	await expect(page).toHaveURL(/\/posts\?tab=published$/);
	await expect(published).toHaveAttribute('aria-current', 'page');
	await expect(search).toHaveValue('dropdown probe');
	await expect(page.getByText('dropdown probe')).toBeVisible();

	// The menu's Posts link starts over on All, even from another tab.
	await page.getByRole('button', { name: 'Workspace menu' }).click();
	await page.getByRole('menuitem', { name: 'Posts' }).click();
	await expect(page).toHaveURL(/\/posts$/);
	await expect(tabs.getByRole('link', { name: /^all posts/i })).toHaveAttribute(
		'aria-current',
		'page'
	);
});

test('linkedin filter shows the profile name, not the email', async () => {
	const { execSync } = await import('node:child_process');
	const { randomUUID } = await import('node:crypto');
	const me = await page.request.get('/api/auth/me').then((r) => r.json());
	const now = Date.now();
	const connId = randomUUID();
	execSync(
		`node scripts/wrangler.mjs d1 execute DB --local ${E2E_D1_FLAGS} --command "INSERT INTO connections (id, user_id, platform, display_name, handle, credentials_encrypted, meta_json, status, created_at, updated_at) VALUES ('${connId}', '${me.user.id}', 'linkedin', 'Test User', 'person@example.com', 'enc', '{}', 'active', ${now}, ${now})"`,
		{ stdio: 'pipe' }
	);
	const draftId = randomUUID();
	execSync(
		`node scripts/wrangler.mjs d1 execute DB --local ${E2E_D1_FLAGS} --command "INSERT INTO drafts (id, user_id, title, base_body, status, created_at, updated_at) VALUES ('${draftId}', '${me.user.id}', NULL, 'linkedin probe', 'published', ${now}, ${now})"`,
		{ stdio: 'pipe' }
	);
	execSync(
		`node scripts/wrangler.mjs d1 execute DB --local ${E2E_D1_FLAGS} --command "INSERT INTO publish_targets (id, draft_id, connection_id, status, remote_post_id, attempt_count, created_at, updated_at) VALUES ('${randomUUID()}', '${draftId}', '${connId}', 'published', 'remote-li', 1, ${now}, ${now})"`,
		{ stdio: 'pipe' }
	);

	await page.goto('/posts?tab=published');
	await clickUntilVisible(
		page,
		page.getByRole('button', { name: 'Filter posts by account' }),
		page.getByRole('menuitemradio', { name: 'Test User' })
	);
	await expect(page.getByRole('menuitemradio', { name: 'Test User' })).toBeVisible();
	await expect(page.getByRole('menuitemradio', { name: /person@example\.com/ })).toHaveCount(0);
});
test('single-destination composer hides thread, override and mastodon chrome', async () => {
	// The LinkedIn account seeded by the filter test is still connected.
	// LinkedIn cannot thread, so with it as the only destination neither the
	// thread affordance nor an override (the Global body already is its body)
	// nor the Mastodon options have anything to act on.
	await page.goto('/compose');
	await clickUntilVisible(
		page,
		page.getByTestId('destinations-toggle'),
		page.getByRole('button', { name: 'Clear all' })
	);
	await page.getByRole('button', { name: 'Clear all' }).click();
	const linkedin = page.locator('button[title="LinkedIn: Test User"]');
	await linkedin.click();
	await expect(linkedin).toHaveAttribute('aria-pressed', 'true');
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('add-thread-post')).toHaveCount(0);
	await expect(page.getByTestId('add-override-toggle')).toHaveCount(0);
	await expect(page.getByTestId('masto-options')).toHaveCount(0);

	// A second, thread-capable destination brings both affordances back.
	await page.getByTestId('destinations-toggle').click();
	await page.locator('button[title="Bluesky: test.bsky.social"]').click();
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('add-override-toggle')).toBeVisible();
	await expect(page.getByTestId('add-thread-post')).toBeVisible();
});

test('search clear button resets the query in one click', async () => {
	await page.goto('/posts');
	const search = page.getByPlaceholder('Search posts...');
	const clear = page.getByRole('button', { name: 'Clear search' });
	await expect(clear).toBeHidden();
	await search.fill('zzz-no-match');
	await expect(clear).toBeVisible();
	await expect(page.getByText(/Nothing matches/)).toBeVisible();
	await clear.click();
	await expect(search).toHaveValue('');
	await expect(clear).toBeHidden();
});

test('a refused draft delete restores the card and says so', async () => {
	// Seed a fresh draft so the first card is unambiguous.
	const text = `delete-refusal probe ${Date.now()}`;
	await page.goto('/compose');
	await fillUntilKept(page.getByTestId('segment-input-0'), text);
	await expect
		.poll(() => new URL(page.url()).searchParams.get('id'), { timeout: 30000 })
		.toBeTruthy();
	await expect
		.poll(
			async () => {
				const res = await page.request.get('/api/drafts');
				const body = await res.json();
				return (body.drafts ?? []).some((d: { baseBody?: string }) => d.baseBody === text);
			},
			{ timeout: 30000 }
		)
		.toBe(true);

	// The API refuses deletes while a publish is in flight (409); pretending
	// success would hide a draft that still exists.
	await page.route('**/api/drafts/*', async (route) => {
		if (route.request().method() === 'DELETE') {
			await route.fulfill({
				status: 409,
				contentType: 'application/json',
				body: JSON.stringify({ error: 'Publishing in progress' })
			});
			return;
		}
		await route.continue();
	});
	await page.goto('/posts');
	const label = text.slice(0, 24);
	await expect(page.getByText(label)).toBeVisible();
	// Retried until the dialog is up: a click before hydration opens nothing,
	// and the confirm would then land on another card's Remove.
	await clickUntilVisible(
		page,
		page.getByRole('button', { name: 'Remove' }).first(),
		page.getByRole('alertdialog')
	);
	await page.getByRole('alertdialog').getByRole('button', { name: 'Remove', exact: true }).click();
	// Optimistically hidden, then restored once the server refuses.
	await expect(page.getByText(label)).toBeHidden();
	await expect(page.getByText(label)).toBeVisible({ timeout: 20000 });
	await expect(page.getByRole('alert').filter({ hasText: /delete the draft/i })).toBeVisible();
	await page.unroute('**/api/drafts/*');
});

test('deleting an already-deleted draft keeps the card hidden', async () => {
	const text = `already-gone probe ${Date.now()}`;
	await page.goto('/compose');
	await fillUntilKept(page.getByTestId('segment-input-0'), text);
	await expect
		.poll(() => new URL(page.url()).searchParams.get('id'), { timeout: 30000 })
		.toBeTruthy();
	const id = new URL(page.url()).searchParams.get('id')!;
	await expect
		.poll(
			async () => {
				const res = await page.request.get('/api/drafts');
				const body = await res.json();
				return (body.drafts ?? []).some((d: { baseBody?: string }) => d.baseBody === text);
			},
			{ timeout: 30000 }
		)
		.toBe(true);

	await page.goto('/posts');
	const label = text.slice(0, 24);
	await expect(page.getByText(label)).toBeVisible();
	// Deleted behind the page's back (another tab) while the stale card is
	// still on screen: a 404 means gone for good, not "restore and complain".
	expect((await page.request.delete(`/api/drafts/${id}`)).ok()).toBe(true);
	// Retried until the dialog is up: a click before hydration opens nothing,
	// and the confirm would then land on another card's Remove.
	await clickUntilVisible(
		page,
		page.getByRole('button', { name: 'Remove' }).first(),
		page.getByRole('alertdialog')
	);
	await page.getByRole('alertdialog').getByRole('button', { name: 'Remove', exact: true }).click();
	await expect(page.getByText(label)).toBeHidden();
	await page.waitForTimeout(2500);
	await expect(page.getByText(label)).toBeHidden();
	await expect(page.getByRole('alert').filter({ hasText: /delete the draft/i })).toBeHidden();
});

test('a retryable publish failure is reported as retrying, not failed', async () => {
	test.setTimeout(120_000);
	// Seed at the end of the suite and delete afterwards so the shared
	// connection list stays stable for the tests above.
	const connId = await seedFirewalledBluesky(page, 'retry.bsky.social');
	try {
		await page.goto('/compose');
		await fillUntilKept(page.getByTestId('segment-input-0'), 'retry probe');
		await page.route('**/api/drafts/*/publish', async (route) => {
			const body = JSON.parse(route.request().postData() ?? '{}') as {
				connectionIds?: string[];
			};
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					results: [
						{
							connectionId: body.connectionIds?.[0],
							status: 'scheduled',
							error: 'Threads container failed (400): media download failed [meta 1.2207052]'
						}
					]
				})
			});
		});
		await page.getByTestId('publish-now').click();
		await page.getByTestId('confirm-dialog-ok').click();
		// Amber "retrying" toast with a link, not a red failure. Assert the toast
		// itself: the screen-reader live region repeats this wording, so a
		// getByText for it matches two elements once the announcement lands
		// (which is what made this spec flaky in CI).
		const toast = page.getByTestId('publish-toast');
		await expect(toast).toContainText(/Retrying automatically for/i, { timeout: 15000 });
		// The amber toast carries the link the comment above promises.
		await expect(toast.getByTestId('toast-action')).toHaveText('View posts');
		await expect(page.getByText(/could not download the image/i)).toHaveCount(0);
		await page.unroute('**/api/drafts/*/publish');
	} finally {
		await deleteConnection(connId);
	}
});

test('video is not offered or accepted while ENABLE_VIDEO_UPLOAD is off', async () => {
	// The media affordance needs a destination, like every other composer test.
	await seedFirewalledBluesky(page, 'video-probe.bsky.social');
	await page.goto('/compose');
	const input = page.getByTestId('file-input-0');
	await expect(input).toBeAttached();

	// The picker does not advertise video…
	const accept = (await input.getAttribute('accept')) ?? '';
	expect(accept).toContain('image/png');
	expect(accept).not.toContain('video');

	// …and a programmatic drop of an MP4 is filtered out with a plain message
	// rather than reaching the API, which refuses video while the flag is off.
	await attachUntilAnswered(
		input,
		{
			name: 'clip.mp4',
			mimeType: 'video/mp4',
			buffer: Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
		},
		page.getByText('Only image files (PNG, JPEG, WebP, GIF) are supported')
	);
});

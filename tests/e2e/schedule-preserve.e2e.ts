import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { clickUntilVisible, E2E_ACCOUNT, d1 } from './e2e-env';

/**
 * Editing a scheduled post (Posts → Edit post) must reopen the schedule popover
 * on the stored time, not on the fresh-post default. Time is pinned: the
 * browser runs in a fixed zone with a fixed `Date`, and every stored value is a
 * fixed ISO instant, so the expected local date/time never depends on the
 * machine or the hour the suite runs. The schedule POST itself is intercepted:
 * the client's request body is the thing under test, and the server's "within
 * a year of the real clock" rule would reject these fixed instants anyway.
 */
test.use({ timezoneId: 'America/New_York' });

/** Browser "now": 08:00 EDT on 2030-06-10. */
const NOW = new Date('2030-06-10T12:00:00.000Z');
/** Default for a fresh schedule: NOW + 1 hour, in that zone. */
const DEFAULT_DATE = '2030-06-10';
const DEFAULT_TIME = '09:00';
/** A future stored schedule: 10:30 EDT on 2030-06-15. */
const STORED_ISO = '2030-06-15T14:30:00.000Z';
const STORED_DATE = '2030-06-15';
const STORED_TIME = '10:30';
/** Before NOW, so the browser treats it as past. Still future to the real
 *  server clock, so nothing in the local worker tries to publish it. */
const PAST_ISO = '2030-06-01T09:00:00.000Z';

/** Rows seeded by the current test, removed after it so later specs (smoke's
 *  empty Accounts page) see the shared e2e database as they left it. */
const seeded: Array<{ draftId: string; connId: string }> = [];

/**
 * A draft with one publish target on a seeded (never contacted) connection.
 * `scheduledFor: null` models a target with no stored time (a cancelled one).
 */
async function seedScheduledDraft(page: Page, body: string, scheduledFor: string | null) {
	const me = await page.request.get('/api/auth/me').then((r) => r.json());
	const userId = me.user.id as string;
	const connId = randomUUID();
	const draftId = randomUUID();
	const now = Date.now();
	const handle = `sched-${connId.slice(0, 8)}.bsky.social`;
	const when = scheduledFor === null ? 'NULL' : String(new Date(scheduledFor).getTime());
	const status = scheduledFor === null ? 'cancelled' : 'scheduled';
	d1(
		`INSERT INTO connections (id, user_id, platform, handle, credentials_encrypted, meta_json, status, created_at, updated_at) VALUES ('${connId}', '${userId}', 'bluesky', '${handle}', 'enc', '{}', 'active', ${now}, ${now}); ` +
			`INSERT INTO drafts (id, user_id, title, base_body, status, created_at, updated_at) VALUES ('${draftId}', '${userId}', NULL, '${body}', '${scheduledFor === null ? 'draft' : 'scheduled'}', ${now}, ${now}); ` +
			`INSERT INTO publish_targets (id, draft_id, connection_id, status, scheduled_for, attempt_count, created_at, updated_at) VALUES ('${randomUUID()}', '${draftId}', '${connId}', '${status}', ${when}, 0, ${now}, ${now})`
	);
	seeded.push({ draftId, connId });
	return { draftId, connId };
}

/** Capture the schedule request the composer sends, answering it locally. */
async function captureSchedule(page: Page, draftId: string) {
	const sent: Array<{ connectionIds: string[]; runAt: string }> = [];
	await page.route(`**/api/drafts/${draftId}/schedule`, async (route) => {
		const body = route.request().postDataJSON();
		sent.push(body);
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ targets: [], scheduledFor: body.runAt })
		});
	});
	return sent;
}

async function openSchedulePanel(page: Page) {
	await clickUntilVisible(
		page,
		page.getByTestId('schedule-toggle'),
		page.getByTestId('schedule-panel')
	);
}

/** The one-hour default: Relative mode at "1 hours", and NOW + 1h underneath. */
async function expectOneHourDefault(page: Page) {
	await expect(page.getByTestId('schedule-offset-value')).toHaveValue('1');
	await expect(page.getByTestId('schedule-offset-unit')).toHaveValue('hours');
	await page.getByText('Specific date').click();
	await expect(page.getByTestId('schedule-date')).toHaveValue(DEFAULT_DATE);
	await expect(page.getByTestId('schedule-time')).toHaveValue(DEFAULT_TIME);
}

test.afterEach(() => {
	for (const { draftId, connId } of seeded.splice(0)) {
		d1(
			`DELETE FROM publish_targets WHERE draft_id='${draftId}'; ` +
				`DELETE FROM drafts WHERE id='${draftId}'; ` +
				`DELETE FROM connections WHERE id='${connId}'`
		);
	}
});

test.beforeEach(async ({ page }) => {
	await page.clock.setFixedTime(NOW);
	await page.goto('/compose');
	if (/\/login$/.test(new URL(page.url()).pathname)) {
		await page.getByLabel('Email').fill(E2E_ACCOUNT.email);
		await page.getByLabel('Password').fill(E2E_ACCOUNT.password);
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page).toHaveURL(/\/compose$/, { timeout: 20000 });
	}
});

test('a future scheduled post opens on its stored time and confirms it unchanged', async ({
	page
}) => {
	const body = `schedule preserve ${randomUUID().slice(0, 8)}`;
	const { draftId, connId } = await seedScheduledDraft(page, body, STORED_ISO);
	const sent = await captureSchedule(page, draftId);

	// The real path: Posts → Scheduled → Edit post.
	await page.goto('/posts?tab=scheduled');
	await page.locator(`a[href="/compose?id=${draftId}"]`, { hasText: 'Edit post' }).click();
	await expect(page).toHaveURL(new RegExp(`/compose\\?id=${draftId}$`), { timeout: 20000 });
	await expect(page.getByTestId('segment-input-0')).toHaveValue(body, { timeout: 20000 });

	// (1) Specific date mode, showing the stored local day and time.
	await openSchedulePanel(page);
	await expect(page.getByTestId('schedule-date')).toHaveValue(STORED_DATE);
	await expect(page.getByTestId('schedule-time')).toHaveValue(STORED_TIME);
	await expect(page.getByTestId('schedule-offsets')).toBeHidden();

	// (2) Confirming without an edit sends the exact stored instant.
	await page.getByTestId('schedule-confirm').click();
	await expect.poll(() => sent.length, { timeout: 20000 }).toBe(1);
	expect(sent[0].runAt).toBe(STORED_ISO);
	expect(sent[0].connectionIds).toEqual([connId]);
});

// (3) Nothing usable stored: behave like a new schedule.
for (const kind of ['missing', 'past', 'malformed'] as const) {
	test(`a ${kind} stored schedule falls back to the one-hour default`, async ({ page }) => {
		const body = `schedule fallback ${kind} ${randomUUID().slice(0, 8)}`;
		const stored = kind === 'missing' ? null : kind === 'past' ? PAST_ISO : STORED_ISO;
		const { draftId } = await seedScheduledDraft(page, body, stored);
		if (kind === 'malformed') {
			// SQLite's integer affinity still permits malformed legacy text.
			d1(`UPDATE publish_targets SET scheduled_for='not-a-date' WHERE draft_id='${draftId}'`);
		}

		await page.goto(`/compose?id=${draftId}`);
		await expect(page.getByTestId('segment-input-0')).toHaveValue(body, { timeout: 20000 });
		await openSchedulePanel(page);
		await expectOneHourDefault(page);
	});
}

test('(4) a new composer keeps the one-hour default', async ({ page }) => {
	await page.goto('/compose');
	expect(new URL(page.url()).searchParams.get('id')).toBeNull();
	await openSchedulePanel(page);
	await expectOneHourDefault(page);
});

test('(5) a schedule picked while the draft loads is not overwritten', async ({ page }) => {
	const body = `schedule race ${randomUUID().slice(0, 8)}`;
	const { draftId, connId } = await seedScheduledDraft(page, body, STORED_ISO);
	const sent = await captureSchedule(page, draftId);
	// Make this draft unavailable to compose's SSR loader so the editor must
	// use its client fallback, the path whose in-flight response is under test.
	d1(
		`DELETE FROM publish_targets WHERE draft_id='${draftId}'; DELETE FROM drafts WHERE id='${draftId}'`
	);

	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	await page.route(`**/api/drafts/${draftId}`, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		await gate;
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				draft: {
					id: draftId,
					baseBody: body,
					selectedConnectionIds: null,
					variants: [],
					media: [],
					targets: [{ connectionId: connId, scheduledFor: STORED_ISO }]
				}
			})
		});
	});

	await page.goto(`/compose?id=${draftId}`);
	await openSchedulePanel(page);
	await page.getByText('Specific date').click();
	await page.getByTestId('schedule-date').fill('2030-06-20');
	await page.getByTestId('schedule-time').fill('16:45');

	release();
	await expect(page.getByTestId('segment-input-0')).toHaveValue(body, { timeout: 20000 });
	await expect(page.getByTestId('schedule-date')).toHaveValue('2030-06-20');
	await expect(page.getByTestId('schedule-time')).toHaveValue('16:45');

	await page.getByTestId('schedule-confirm').click();
	await expect.poll(() => sent.length, { timeout: 20000 }).toBe(1);
	// 16:45 EDT.
	expect(sent[0].runAt).toBe('2030-06-20T20:45:00.000Z');
});

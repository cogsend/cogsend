import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import {
	DEFAULT_PROFILE_SETTINGS,
	normalizeProfileSettings,
	parseProfileSettings
} from '$lib/domain/profile-settings';
import { parseInstanceName } from '$lib/domain/instance-name';
import { parseTimeZone } from '$lib/domain/time-zone';
import { first } from '$lib/server/db/client';
import { users } from '$lib/server/db/schema';
import { fail, handleError, ok } from '$lib/server/http';
import { requireScope, requireUser } from '$lib/server/require';
import { readStoredAppName, rememberAppName } from '$lib/server/app-settings';

export const GET: RequestHandler = async ({ locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'read');
		const row = await first(
			locals.db
				.select({ settingsJson: users.settingsJson, displayName: users.displayName })
				.from(users)
				.where(eq(users.id, user.id))
		);
		return ok({
			settings: parseProfileSettings(row?.settingsJson ?? null),
			displayName: row?.displayName ?? null,
			// The effective name: what Settings → Instance should show.
			instanceName: (await readStoredAppName(locals.db)) ?? locals.env.APP_NAME
		});
	} catch (err) {
		return handleError(err);
	}
};

const SETTINGS_KEYS = Object.keys(DEFAULT_PROFILE_SETTINGS);

function normalizeDisplayName(input: unknown): { ok: true; name: string | null } | { ok: false } {
	if (input === undefined || input === null) return { ok: true, name: null };
	if (typeof input !== 'string') return { ok: false };
	const name = input.trim();
	if (name.length === 0) return { ok: true, name: null };
	if (name.length > 80) return { ok: false };
	return { ok: true, name };
}

export const PATCH: RequestHandler = async ({ request, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		const body = await request.json().catch(() => null);
		if (!body || typeof body !== 'object') return fail('Invalid payload', 400);

		// Fetch existing settings to merge partial updates
		const existingRow = await first(
			locals.db
				.select({ settingsJson: users.settingsJson })
				.from(users)
				.where(eq(users.id, user.id))
		);
		const existingSettings = parseProfileSettings(existingRow?.settingsJson);

		const mergedBody = { ...existingSettings, ...(body as Record<string, unknown>) };
		const normalized = normalizeProfileSettings(mergedBody);
		if (!normalized.ok) return fail(normalized.error, 400);
		const hasName =
			body !== null &&
			typeof body === 'object' &&
			Object.hasOwn(body as Record<string, unknown>, 'displayName');
		const hasInstanceName =
			body !== null &&
			typeof body === 'object' &&
			Object.hasOwn(body as Record<string, unknown>, 'instanceName');
		const display = normalizeDisplayName(
			hasName ? (body as Record<string, unknown>).displayName : undefined
		);
		const instanceName = parseInstanceName(
			hasInstanceName ? (body as Record<string, unknown>).instanceName : undefined
		);
		const hasTimeZone = Object.hasOwn(body as Record<string, unknown>, 'timezone');
		const timeZone = hasTimeZone ? parseTimeZone((body as Record<string, unknown>).timezone) : null;
		// Absent key = leave the stored name alone (older clients only send
		// visibility/defaults). Present key (incl. empty) sets or clears it.
		if (hasName && !display.ok) return fail('Invalid display name', 400);
		if (hasInstanceName && !instanceName.ok) return fail('Invalid instance name', 400);
		if (hasTimeZone && !timeZone) return fail('Invalid time zone', 400);
		if (hasInstanceName && instanceName.ok) {
			// One write of its own: the instance name is not a user setting.
			await rememberAppName(locals.db, instanceName.name ?? '');
		}
		// The layout sends the browser's time zone on its own, in the background.
		// Writing the settings column back from that request would overwrite a
		// profile save that landed in between, so it is written only when the
		// request carries a setting.
		const touchesSettings = SETTINGS_KEYS.some((key) =>
			Object.hasOwn(body as Record<string, unknown>, key)
		);
		await locals.db
			.update(users)
			.set({
				...(touchesSettings ? { settingsJson: JSON.stringify(normalized.settings) } : {}),
				...(hasName && display.ok ? { displayName: display.name } : {}),
				...(timeZone ? { timezone: timeZone } : {}),
				updatedAt: new Date()
			})
			.where(eq(users.id, user.id));
		const row = await first(
			locals.db.select({ displayName: users.displayName }).from(users).where(eq(users.id, user.id))
		);
		return ok({
			settings: normalized.settings,
			displayName: row?.displayName ?? null,
			instanceName: (await readStoredAppName(locals.db)) ?? locals.env.APP_NAME
		});
	} catch (err) {
		return handleError(err);
	}
};

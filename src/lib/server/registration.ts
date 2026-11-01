import {
	parseRegistrationMode,
	parseUserCap,
	resolveRegistration,
	type RegistrationConfig,
	type RegistrationMode
} from '#lib/domain/registration.js';
import { readAppSetting, writeAppSetting } from './app-settings';
import type { AppDb } from './db/client';
import type { AppEnv } from './env';
import { hasSeveralUsers } from './users';

export const REGISTRATION_MODE_SETTING = 'registration_mode';
export const REGISTRATION_CAP_SETTING = 'registration_cap';

/**
 * The sign-up configuration in force. While the environment has not opted in
 * this is answered without touching D1, so a single-user instance pays nothing
 * for the feature existing. Read fresh: an admin who pauses sign-up expects the
 * next request to see it, not one a minute later.
 */
export async function registrationConfig(db: AppDb, env: AppEnv): Promise<RegistrationConfig> {
	if ((parseRegistrationMode(env.REGISTRATION) ?? 'off') === 'off') {
		return resolveRegistration({ envMode: 'off', envCap: env.MAX_ACTIVE_USERS });
	}
	const [storedMode, storedCap] = await Promise.all([
		readAppSetting(db, REGISTRATION_MODE_SETTING, { fresh: true }),
		readAppSetting(db, REGISTRATION_CAP_SETTING, { fresh: true })
	]);
	return resolveRegistration({
		envMode: env.REGISTRATION,
		envCap: env.MAX_ACTIVE_USERS,
		storedMode,
		storedCap
	});
}

/** Save the admin's choices. `null` clears one, handing it back to the
 *  environment's value. */
export async function saveRegistrationSettings(
	db: AppDb,
	input: { mode?: RegistrationMode | null; cap?: number | null }
): Promise<void> {
	if (input.mode !== undefined) {
		await writeAppSetting(db, REGISTRATION_MODE_SETTING, input.mode ?? '');
	}
	if (input.cap !== undefined) {
		await writeAppSetting(db, REGISTRATION_CAP_SETTING, input.cap ? String(input.cap) : '');
	}
}

export function parseRegistrationPatch(
	body: Record<string, unknown>
):
	{ ok: true; mode?: RegistrationMode | null; cap?: number | null } | { ok: false; error: string } {
	const out: { mode?: RegistrationMode | null; cap?: number | null } = {};
	if (Object.hasOwn(body, 'mode')) {
		if (body.mode === null) out.mode = null;
		else {
			const mode = parseRegistrationMode(body.mode);
			if (!mode) return { ok: false, error: 'Mode must be off, waitlist or open' };
			out.mode = mode;
		}
	}
	if (Object.hasOwn(body, 'cap')) {
		if (body.cap === null || body.cap === '') out.cap = null;
		else {
			const cap = parseUserCap(body.cap);
			if (!cap) return { ok: false, error: 'The cap must be a whole number of at least 1' };
			out.cap = cap;
		}
	}
	if (out.mode === undefined && out.cap === undefined) {
		return { ok: false, error: 'Nothing to change' };
	}
	return { ok: true, ...out };
}

/**
 * Whether this instance shows its multi-user surfaces (the Users page): when
 * the environment opted in, or when accounts are left over from a time it did.
 * A single-user instance answers this with at most one two-row read.
 */
export async function multiUserActive(db: AppDb, env: AppEnv): Promise<boolean> {
	if ((parseRegistrationMode(env.REGISTRATION) ?? 'off') !== 'off') return true;
	return hasSeveralUsers(db);
}

/**
 * Email verification needs a sender that can reach anybody. Resend's shared
 * `onboarding@resend.dev` address only delivers to the Resend account's own
 * address, so without NOTIFY_FROM (a verified domain) there is no way to mail a
 * stranger, and approval by the admin is the check instead.
 */
export function canVerifyEmail(env: AppEnv): boolean {
	return Boolean(env.RESEND_API_KEY && env.NOTIFY_FROM);
}

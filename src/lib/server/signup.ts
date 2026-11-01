import { and, eq, lt, sql } from 'drizzle-orm';
import { timingSafeEqual, utf8Bytes } from '#lib/domain/bytes.js';
import type { RegistrationConfig, UserStatus } from '#lib/domain/registration.js';
import { hmacHex } from './crypto';
import { first, newId, type AppDb } from './db/client';
import { users } from './db/schema';
import type { AppEnv } from './env';
import { wasInvited } from './invites';

/**
 * Creating accounts for strangers: the part of public registration that writes.
 * The route (api/auth/signup) owns the request; this owns the rules that must
 * hold however it is reached.
 */

/** Nobody types an email and a password in under two seconds; a script posting
 *  straight at the endpoint never loaded the form at all. Cheap friction, not a
 *  wall: the edge rate limit and the admin's approval are what actually hold. */
export const SIGNUP_FORM_MIN_MS = 2_000;
export const SIGNUP_FORM_MAX_MS = 24 * 60 * 60_000;
/** An unconfirmed address is released after a day, so a stranger cannot squat
 *  on somebody else's email by signing up with it first. */
export const UNVERIFIED_HOLD_MS = 24 * 60 * 60_000;
export const VERIFY_LINK_TTL_MS = 24 * 60 * 60_000;

function sameMac(a: string, b: string): boolean {
	const ab = utf8Bytes(a);
	const bb = utf8Bytes(b);
	return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** A timestamp the sign-up page hands the form, signed so it cannot be forged. */
export async function signupFormToken(env: AppEnv, now = Date.now()): Promise<string> {
	return `${now}.${await hmacHex(env.AUTH_SECRET, `signup-form:${now}`)}`;
}

export async function checkSignupFormToken(
	env: AppEnv,
	token: unknown,
	now = Date.now()
): Promise<'ok' | 'too-fast' | 'invalid'> {
	if (typeof token !== 'string') return 'invalid';
	const [issued, mac] = token.split('.');
	const at = Number(issued);
	if (!Number.isSafeInteger(at) || !mac) return 'invalid';
	if (!sameMac(mac, await hmacHex(env.AUTH_SECRET, `signup-form:${at}`))) return 'invalid';
	if (now - at > SIGNUP_FORM_MAX_MS || at > now) return 'invalid';
	if (now - at < SIGNUP_FORM_MIN_MS) return 'too-fast';
	return 'ok';
}

/**
 * The status a fresh account is written with, or `cap` when it depends on how
 * many accounts are active at the moment of the insert (open sign-up), which
 * the INSERT decides itself so two sign-ups cannot both take the last place.
 */
export function plannedStatus(opts: {
	config: RegistrationConfig;
	invited: boolean;
	verifyEmail: boolean;
}): Exclude<UserStatus, 'suspended'> | 'cap' {
	if (opts.verifyEmail) return 'unverified';
	if (opts.invited) return 'active';
	if (opts.config.mode !== 'open') return 'pending';
	return 'cap';
}

function statusSql(planned: Exclude<UserStatus, 'suspended'> | 'cap', cap: number) {
	if (planned !== 'cap') return sql`${planned}`;
	return sql`CASE WHEN (SELECT COUNT(*) FROM users WHERE status = 'active') < ${cap} THEN 'active' ELSE 'pending' END`;
}

/**
 * Write a member account, unless the address is taken. Returns null when it is,
 * so the caller can answer exactly as it would for a new account. A day-old
 * unconfirmed sign-up does not count as taken (UNVERIFIED_HOLD_MS).
 */
export async function insertMember(
	db: AppDb,
	opts: {
		email: string;
		passwordHash: string;
		planned: Exclude<UserStatus, 'suspended'> | 'cap';
		cap: number;
		now?: Date;
	}
): Promise<{ id: string; status: UserStatus } | null> {
	const now = opts.now ?? new Date();
	await db
		.delete(users)
		.where(
			and(
				eq(users.email, opts.email),
				eq(users.status, 'unverified'),
				lt(users.createdAt, new Date(now.getTime() - UNVERIFIED_HOLD_MS))
			)
		);
	const id = newId();
	const at = now.getTime();
	// One statement: the address check and the cap check happen where the row
	// is written, so neither can be raced.
	await db.run(sql`
		INSERT INTO users (id, email, password_hash, display_name, timezone, created_at, updated_at,
			totp_enabled, totp_secret_enc, totp_enrolled_at, totp_last_step, settings_json, role, status)
		SELECT ${id}, ${opts.email}, ${opts.passwordHash}, NULL, 'UTC', ${at}, ${at},
			0, NULL, NULL, NULL, NULL, 'member', ${statusSql(opts.planned, opts.cap)}
		WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = ${opts.email})`);
	const row = await first(db.select({ status: users.status }).from(users).where(eq(users.id, id)));
	return row ? { id, status: row.status as UserStatus } : null;
}

/**
 * The link in the confirmation email: the account id, an expiry and a MAC over
 * both. Stateless, and single-use in effect, because confirming moves the
 * account out of `unverified` and a second use finds nothing to do.
 */
export async function verifyEmailToken(
	env: AppEnv,
	userId: string,
	now = Date.now()
): Promise<string> {
	const exp = now + VERIFY_LINK_TTL_MS;
	return `${userId}.${exp}.${await hmacHex(env.AUTH_SECRET, `verify-email:${userId}:${exp}`)}`;
}

export async function readVerifyEmailToken(
	env: AppEnv,
	token: unknown,
	now = Date.now()
): Promise<string | null> {
	if (typeof token !== 'string' || token.length > 200) return null;
	const [userId, rawExp, mac] = token.split('.');
	const exp = Number(rawExp);
	if (!userId || !mac || !Number.isSafeInteger(exp) || exp < now) return null;
	const expected = await hmacHex(env.AUTH_SECRET, `verify-email:${userId}:${exp}`);
	return sameMac(mac, expected) ? userId : null;
}

/**
 * Confirm an address and move the account on: active when it was invited or
 * open sign-up still has room, waiting for the admin otherwise. Null when the
 * account is gone or was not waiting for confirmation (a second click).
 */
export async function confirmEmail(
	db: AppDb,
	config: RegistrationConfig,
	userId: string
): Promise<UserStatus | null> {
	const invited = await wasInvited(db, userId);
	const planned: Exclude<UserStatus, 'suspended'> | 'cap' = invited
		? 'active'
		: config.mode === 'open'
			? 'cap'
			: 'pending';
	const updated = await db
		.update(users)
		.set({ status: statusSql(planned, config.cap), updatedAt: new Date() })
		.where(and(eq(users.id, userId), eq(users.status, 'unverified')))
		.returning({ status: users.status });
	return (updated[0]?.status as UserStatus | undefined) ?? null;
}

/** Send the confirmation link through Resend. Throws when the provider refuses,
 *  so the caller can say the email could not be sent. */
export async function sendVerificationEmail(
	env: AppEnv,
	opts: { to: string; link: string; appName: string; fetchImpl?: typeof fetch }
): Promise<void> {
	const send = opts.fetchImpl ?? fetch;
	const text = [
		`Confirm your email address to finish creating your ${opts.appName} account:`,
		'',
		opts.link,
		'',
		'The link works for 24 hours. If you did not sign up, ignore this email and nothing will happen.'
	].join('\n');
	const safeLink = opts.link.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
	const html = `<p>Confirm your email address to finish creating your account:</p><p><a href="${safeLink}">Confirm my email</a></p><p>The link works for 24 hours. If you did not sign up, ignore this email and nothing will happen.</p>`;
	const res = await send('https://api.resend.com/emails', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.RESEND_API_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			from: env.NOTIFY_FROM,
			to: [opts.to],
			subject: `Confirm your email for ${opts.appName}`,
			text,
			html
		})
	});
	if (!res.ok) {
		throw Object.assign(new Error(`Resend refused the email (${res.status})`), { status: 502 });
	}
}

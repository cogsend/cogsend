/**
 * The login's own rules: what an email address may look like and how long a
 * password has to be.
 *
 * They live here rather than inside a route because the same rules have to hold
 * in two places: the app (Settings → Account, in `api/account`) and the CLI that
 * creates the account (`scripts/lib/account.mjs`). A .mjs script cannot import
 * from src, so that file mirrors these, and a unit test compares the two
 * implementations case by case: a rule can only change in both at once.
 *
 * Delivery is deliberately not checked (no dot required, no DNS): the address
 * is only an identifier, never a place mail is sent.
 */
export const EMAIL_MAX = 254;
export const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

/** Emails are stored lowercased and trimmed, so lookups are case-insensitive. */
export function normalizeEmail(raw: string): string {
	return raw.trim().toLowerCase();
}

/** Null when the address is acceptable; otherwise the message to show. */
export function emailProblem(email: string): string | null {
	if (!EMAIL_SHAPE.test(email) || email.length > EMAIL_MAX) return 'Enter a valid email address';
	return null;
}

/** Null when the password is acceptable; otherwise the message to show. */
export function passwordProblem(password: string): string | null {
	if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters`;
	if (password.length > PASSWORD_MAX) return 'Password is too long';
	return null;
}

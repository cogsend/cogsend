/**
 * Creating the single account from the terminal.
 *
 * The account is seeded into D1 *before* the Worker is reachable. The browser
 * can also claim a fresh instance (api/auth/claim), but only with
 * APP_ENCRYPTION_KEY, so finding the URL first is never enough.
 *
 * Everything here that touches storage goes through `wrangler d1 execute`, so it
 * works against a Worker that does not exist yet. The password is hashed with
 * WebCrypto in exactly the format the app's `hashPassword` writes
 * (`pbkdf2$<iterations>$<b64 salt>$<b64 bits>`, SHA-256), and a unit test feeds
 * this module's output to the app's own `verifyPassword` so the two cannot
 * drift. Nothing here spawns a process or reads argv: the caller passes a
 * `wrangler(args, opts)` runner, which keeps the whole thing testable.
 *
 * The rules the app enforces on emails and passwords are mirrored below (a .mjs
 * script cannot import from src). `tests/setup-account-seed.test.ts` compares
 * this copy with `src/lib/domain/credentials.ts` case by case.
 */
import { timingSafeEqual } from 'node:crypto';

export const EMAIL_MAX = 254;
export const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

/**
 * PBKDF2-SHA256 iterations. 25,000 is what a Workers Free request can afford
 * (10 ms of CPU). Higher counts are not an option on Workers: workerd itself
 * rejects anything above 100,000, so `KDF_MAX_ITERATIONS` is a hard ceiling —
 * a hash above it could never be verified and would lock the operator out.
 * Keep both values in sync with PBKDF2_ITERS/PBKDF2_MAX_ITERS in
 * src/lib/server/crypto.ts.
 */
export const KDF_ITERATIONS = 25_000;
export const KDF_MAX_ITERATIONS = 100_000;

/**
 * @typedef {(args: string[], opts?: Record<string, unknown>) => Promise<{ status: number, stdout: string, stderr: string }>} WranglerRunner
 */

/** @param {unknown} err @returns {string} */
function messageOf(err) {
	return err instanceof Error ? err.message : String(err);
}

/** @param {string} raw @returns {string} */
export function normalizeEmail(raw) {
	return String(raw ?? '')
		.trim()
		.toLowerCase();
}

/** Null when the address is acceptable; otherwise the message the app shows.
 *  @param {string} email @returns {string | null} */
export function emailProblem(email) {
	if (!EMAIL_SHAPE.test(email) || email.length > EMAIL_MAX) return 'Enter a valid email address';
	return null;
}

/** Null when the password is acceptable; otherwise the message the app shows.
 *  @param {string} password @returns {string | null} */
export function passwordProblem(password) {
	if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters`;
	if (password.length > PASSWORD_MAX) return 'Password is too long';
	return null;
}

/** The app's own two helpers, so the container formats are byte-identical.
 *  @param {Uint8Array} bytes @returns {string} */
function toBase64(bytes) {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/** @param {string} b64 @returns {Uint8Array<ArrayBuffer>} */
function fromBase64(b64) {
	const binary = atob(b64);
	const out = new Uint8Array(new ArrayBuffer(binary.length));
	for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
	return out;
}

/** Random bytes, typed so WebCrypto accepts them without a cast.
 *  @param {number} length @returns {Uint8Array<ArrayBuffer>} */
function randomBytes(length) {
	const bytes = new Uint8Array(new ArrayBuffer(length));
	crypto.getRandomValues(bytes);
	return bytes;
}

/** A password nobody has to invent: 24 random bytes, base64url (32 characters).
 *  @param {number} [bytes] @returns {string} */
export function generatePassword(bytes = 24) {
	const raw = randomBytes(bytes);
	return toBase64(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The app's wire format, so a hash made here verifies there.
 *  @param {string} password @param {number} [iterations] @returns {Promise<string>} */
export async function hashPassword(password, iterations = KDF_ITERATIONS) {
	const salt = randomBytes(16);
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(password),
		'PBKDF2',
		false,
		['deriveBits']
	);
	const bits = new Uint8Array(
		await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256)
	);
	return `pbkdf2$${iterations}$${toBase64(salt)}$${toBase64(bits)}`;
}

/**
 * Verify a `hashPassword` value, mirroring src/lib/server/crypto.ts. Only used
 * to self-check a hash before it is written, and by tests: the real check
 * happens in the Worker when the operator signs in.
 *
 * @param {string} password @param {string} stored @returns {Promise<boolean>}
 */
export async function verifyPassword(password, stored) {
	const parts = String(stored ?? '').split('$');
	if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
	const iterations = Number.parseInt(parts[1], 10);
	if (!Number.isInteger(iterations) || iterations < 1 || iterations > KDF_MAX_ITERATIONS)
		return false;
	const salt = fromBase64(parts[2]);
	const expected = fromBase64(parts[3]);
	if (salt.length === 0 || expected.length === 0) return false;
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(password),
		'PBKDF2',
		false,
		['deriveBits']
	);
	const bits = new Uint8Array(
		await crypto.subtle.deriveBits(
			{ name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
			key,
			expected.length * 8
		)
	);
	if (bits.length !== expected.length) return false;
	return timingSafeEqual(bits, expected);
}

/** A single-quoted SQL string. Emails may legally contain a quote.
 *  @param {unknown} value @returns {string} */
export function sqlQuote(value) {
	return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * The insert that creates the account, and only while the table is empty. The
 * guard is what makes two concurrent seeds impossible, which matters because the
 * account is the whole instance: a second row would mean a second owner.
 *
 * @param {{ id: string, email: string, passwordHash: string, now: number }} row
 * @returns {string}
 */
export function seedUserSql({ id, email, passwordHash, now }) {
	return (
		'INSERT INTO users (id, email, password_hash, display_name, timezone, created_at, updated_at, ' +
		'totp_enabled, totp_secret_enc, totp_enrolled_at, totp_last_step, settings_json) ' +
		`SELECT ${sqlQuote(id)}, ${sqlQuote(email)}, ${sqlQuote(passwordHash)}, NULL, 'UTC', ` +
		`${Math.trunc(now)}, ${Math.trunc(now)}, 0, NULL, NULL, NULL, NULL ` +
		'WHERE NOT EXISTS (SELECT 1 FROM users);'
	);
}

/** The one row this instance is allowed to have.
 *  @returns {string} */
export function readAccountSql() {
	return 'SELECT email, totp_enabled FROM users LIMIT 1;';
}

/**
 * Replace an existing account's password. `rotateTotp` also throws the
 * authenticator away, which is what "lost the phone as well" needs; without it
 * the enrolled device keeps working, so a forgotten password alone does not
 * cost the operator their second factor.
 *
 * @param {{ email: string, passwordHash: string, now: number, rotateTotp?: boolean }} row
 * @returns {string}
 */
export function resetAccountSql({ email, passwordHash, now, rotateTotp = false }) {
	const sets = [
		`email = ${sqlQuote(email)}`,
		`password_hash = ${sqlQuote(passwordHash)}`,
		`updated_at = ${Math.trunc(now)}`,
		...(rotateTotp
			? [
					'totp_enabled = 0',
					'totp_secret_enc = NULL',
					'totp_enrolled_at = NULL',
					'totp_last_step = NULL'
				]
			: [])
	];
	return `UPDATE users SET ${sets.join(', ')};`;
}

/** Every session dies with a password change, on every device.
 *  @returns {string} */
export function clearSessionsSql() {
	return 'DELETE FROM sessions;';
}

/**
 * The failed-attempt counters live in `mfa_challenges`, keyed by a hash of the
 * user id — which a reset does not change. An operator who runs this *because*
 * they are locked out would otherwise be told "Too many attempts — try again in
 * 15 minutes" with the new password in hand. Every row in that table is
 * transient (a login challenge, an enrollment challenge, a lockout counter), so
 * a reset clears the table rather than picking rows apart.
 *  @returns {string} */
export function clearAuthGatesSql() {
	return 'DELETE FROM mfa_challenges;';
}

/**
 * `wrangler d1 execute --json` answers with one entry per statement:
 * `[{ results: [...], success: true, meta: {…} }]`.
 *
 * @param {string} stdout @returns {Record<string, unknown>[]}
 */
export function parseD1Rows(stdout) {
	const text = String(stdout ?? '').trim();
	if (!text) throw new Error('wrangler returned no output for a D1 query');
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`could not parse the D1 result as JSON: ${text.slice(0, 200)}`);
	}
	if (!Array.isArray(parsed)) throw new Error('unexpected D1 result shape (expected an array)');
	/** @type {Record<string, unknown>[]} */
	const rows = [];
	for (const entry of parsed) {
		if (Array.isArray(entry?.results)) rows.push(...entry.results);
	}
	return rows;
}

/**
 * @param {WranglerRunner} wrangler
 * @param {string} statement
 * @param {{ remote?: boolean, readOnly?: boolean, allowFailure?: boolean, extraArgs?: string[] }} [options]
 * @returns {Promise<string>}
 */
async function d1(wrangler, statement, { remote = true, extraArgs = [], ...options } = {}) {
	const result = await wrangler(
		[
			'd1',
			'execute',
			'DB',
			remote ? '--remote' : '--local',
			...extraArgs,
			'--yes',
			'--json',
			'--command',
			statement
		],
		{ quiet: true, ...options }
	);
	if (result.status !== 0) {
		const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
		throw new Error(`the D1 query failed${detail ? `:\n${detail}` : ''}`);
	}
	return result.stdout;
}

/**
 * The account this database holds, if any. A failed read is reported rather
 * than thrown: the caller can still try the guarded insert, which refuses to
 * create a second account on its own.
 *
 * @param {{ wrangler: WranglerRunner, remote?: boolean, extraArgs?: string[] }} options
 * @returns {Promise<{ ok: boolean, exists: boolean, email: string | null, totpEnrolled?: boolean, error?: string }>}
 */
export async function readAccount({ wrangler, remote = true, extraArgs = [] }) {
	let stdout;
	try {
		// `allowFailure`: a database that does not exist yet is a normal answer
		// ("no account"), not a reason to abort the run.
		stdout = await d1(wrangler, readAccountSql(), {
			remote,
			extraArgs,
			readOnly: true,
			allowFailure: true
		});
	} catch (err) {
		return { ok: false, exists: false, email: null, totpEnrolled: false, error: messageOf(err) };
	}
	try {
		const rows = parseD1Rows(stdout);
		const email = rows.length ? String(rows[0].email ?? '') : '';
		// D1 hands SQLite integers back as numbers; a NULL column (an account
		// that never enrolled) is falsy either way.
		const totpEnrolled = rows.length ? Number(rows[0].totp_enabled ?? 0) === 1 : false;
		return { ok: true, exists: Boolean(email), email: email || null, totpEnrolled };
	} catch (err) {
		return { ok: false, exists: false, email: null, error: messageOf(err) };
	}
}

/**
 * Create the account. Returns `{ created, email }`; throws when the insert
 * cannot be confirmed, so a setup run never claims to have done something that
 * did not happen.
 *
 * @param {{ wrangler: WranglerRunner, email: string, password: string, iterations?: number, now?: number, remote?: boolean, extraArgs?: string[] }} options
 * @returns {Promise<{ created: boolean, email: string, iterations: number }>}
 */
export async function seedAccount({
	wrangler,
	email,
	password,
	iterations = KDF_ITERATIONS,
	now = Date.now(),
	remote = true,
	extraArgs = []
}) {
	const address = normalizeEmail(email);
	const problem = emailProblem(address) ?? passwordProblem(password);
	if (problem) throw new Error(`refusing to create the account: ${problem}`);
	if (!Number.isInteger(iterations) || iterations < 1 || iterations > KDF_MAX_ITERATIONS) {
		throw new Error(`refusing to create the account: ${iterations} is not a sane iteration count`);
	}

	const passwordHash = await hashPassword(password, iterations);
	// Self-check before writing: a hash this process cannot verify would lock
	// the operator out of their own instance.
	if (!(await verifyPassword(password, passwordHash))) {
		throw new Error('refusing to create the account: the generated hash did not verify');
	}

	const id = crypto.randomUUID();
	await d1(wrangler, seedUserSql({ id, email: address, passwordHash, now }), {
		remote,
		extraArgs,
		allowFailure: true
	});

	const after = await readAccount({ wrangler, remote, extraArgs });
	if (!after.ok) throw new Error(after.error ?? 'could not confirm the account was created');
	if (!after.exists)
		throw new Error('the insert reported success but no account is in the database');
	if (after.email !== address) {
		throw new Error(`this database already holds the account ${after.email}; nothing was changed`);
	}
	return { created: true, email: address, iterations };
}

/**
 * Give the existing account a new password (and optionally a new second
 * factor). Throws when there is no account to reset, so a mistyped command
 * never silently invents one.
 *
 * @param {{ wrangler: WranglerRunner, email: string, password: string, iterations?: number, rotateTotp?: boolean, now?: number, remote?: boolean, extraArgs?: string[] }} options
 * @returns {Promise<{ email: string, iterations: number, rotateTotp: boolean }>}
 */
export async function resetAccount({
	wrangler,
	email,
	password,
	iterations = KDF_ITERATIONS,
	rotateTotp = false,
	now = Date.now(),
	remote = true,
	extraArgs = []
}) {
	const address = normalizeEmail(email);
	const problem = emailProblem(address) ?? passwordProblem(password);
	if (problem) throw new Error(`refusing to reset the login: ${problem}`);
	if (!Number.isInteger(iterations) || iterations < 1 || iterations > KDF_MAX_ITERATIONS) {
		throw new Error(`refusing to reset the login: ${iterations} is not a sane iteration count`);
	}

	const before = await readAccount({ wrangler, remote, extraArgs });
	if (!before.ok) throw new Error(before.error ?? 'could not read the account');
	if (!before.exists)
		throw new Error('there is no account to reset yet — run `npm run setup` first');

	const passwordHash = await hashPassword(password, iterations);
	if (!(await verifyPassword(password, passwordHash))) {
		throw new Error('refusing to reset the login: the generated hash did not verify');
	}
	await d1(wrangler, resetAccountSql({ email: address, passwordHash, now, rotateTotp }), {
		remote,
		extraArgs,
		allowFailure: true
	});
	await d1(wrangler, clearSessionsSql(), { remote, extraArgs, allowFailure: true });
	await d1(wrangler, clearAuthGatesSql(), { remote, extraArgs, allowFailure: true });

	const after = await readAccount({ wrangler, remote, extraArgs });
	if (!after.ok) throw new Error(after.error ?? 'could not confirm the reset');
	if (after.email !== address)
		throw new Error('the reset did not land — check the database by hand');
	return { email: address, iterations, rotateTotp };
}

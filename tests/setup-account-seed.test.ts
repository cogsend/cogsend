import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { AppDb } from '#lib/server/db/client.js';
import { createTestDb } from '#lib/server/db/test.js';
import {
	hashPassword as appHashPassword,
	verifyPassword as appVerifyPassword
} from '#lib/server/crypto.js';
import { authenticatePassword, needsSetup } from '#lib/server/auth.js';
import {
	EMAIL_MAX as APP_EMAIL_MAX,
	PASSWORD_MIN as APP_PASSWORD_MIN,
	emailProblem as appEmailProblem,
	normalizeEmail as appNormalizeEmail,
	passwordProblem as appPasswordProblem
} from '#lib/domain/credentials.js';
import {
	EMAIL_MAX,
	KDF_ITERATIONS,
	KDF_MAX_ITERATIONS,
	PASSWORD_MIN,
	emailProblem,
	generatePassword,
	hashPassword,
	normalizeEmail,
	parseD1Rows,
	passwordProblem,
	readAccount,
	resetAccount,
	seedAccount,
	seedUserSql,
	verifyPassword
} from '../scripts/lib/account.mjs';

/**
 * A stand-in for `scripts/wrangler.mjs`. The handler sees the SQL and answers
 * the way the real D1 would; `calls` records every statement in order.
 */
function fakeWrangler(
	handle: (command: string) => { rows?: unknown[]; stdout?: string; status?: number } = () => ({})
) {
	const calls: string[] = [];
	const runner = async (args: string[]) => {
		const command = args[args.indexOf('--command') + 1] ?? '';
		calls.push(command);
		const answer = handle(command) ?? {};
		const stdout =
			answer.stdout ??
			JSON.stringify([{ results: answer.rows ?? [], success: true, meta: { duration: 1 } }]);
		return { status: answer.status ?? 0, stdout, stderr: answer.status ? 'boom' : '' };
	};
	return { runner, calls };
}

describe('a CLI-seeded account, as the app sees it', () => {
	let db: AppDb;
	let close: () => void;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
	});
	afterAll(() => close());

	// One database, in order: the quote in the first address is the escaping
	// test, and it stays the only row for the rest of the block.
	const address = "o'brien@example.com";
	const password = 'a password the operator chose';

	it('writes a row the app will accept, with a quote in the address intact', async () => {
		const hash = await hashPassword(password);
		const statement = seedUserSql({ id: 'seed-1', email: address, passwordHash: hash, now: 1 });
		expect(statement).toContain(`'o''brien@example.com'`);

		await db.run(sql.raw(statement));

		// The claim page is unreachable: there is already an account, so
		// `needsSetup` is false from the instance's very first request.
		expect(await needsSetup(db)).toBe(false);

		const user = await authenticatePassword(db, "O'BRIEN@Example.com", password);
		expect(user?.email).toBe(address);
		// TOTP is enrolled in the browser on the first sign-in, not here.
		expect(user?.totpEnabled).toBe(false);
	});

	it('refuses a second account, so a race cannot leave two owners behind', async () => {
		const hash = await hashPassword('someone else');
		await db.run(
			sql.raw(seedUserSql({ id: 'seed-2', email: 'other@example.com', passwordHash: hash, now: 2 }))
		);
		const rows = await db.all<{ email: string; count: number }>(
			sql.raw('SELECT email, (SELECT COUNT(*) FROM users) AS count FROM users LIMIT 1')
		);
		expect(rows).toEqual([{ email: address, count: 1 }]);
	});
});

describe('crypto parity with the Worker', () => {
	it('hashes in the format the app verifies', async () => {
		const hash = await hashPassword('correct horse battery staple');
		expect(hash).toMatch(/^pbkdf2\$25000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
		expect(await appVerifyPassword('correct horse battery staple', hash)).toBe(true);
		expect(await appVerifyPassword('wrong', hash)).toBe(false);
	});

	it('verifies a hash the app itself wrote', async () => {
		const hash = await appHashPassword('something the app hashed');
		expect(await verifyPassword('something the app hashed', hash)).toBe(true);
		expect(await verifyPassword('nope', hash)).toBe(false);
	});

	it('refuses an iteration count the Worker could not verify', async () => {
		const { runner } = fakeWrangler();
		await expect(
			seedAccount({
				wrangler: runner,
				email: 'paid@example.com',
				password: 'paid plan password',
				iterations: 600_000
			})
		).rejects.toThrow(/not a sane iteration count/);
	});

	it('keeps its count in step with the app, and a free-plan-safe default', () => {
		// The count lives inside each hash, so raising the app's constant must
		// raise this one too — otherwise new deployments quietly get the old cost.
		const source = readFileSync('src/lib/server/crypto.ts', 'utf8');
		const match = source.match(/const PBKDF2_ITERS = ([\d_]+)/);
		expect(match?.[1].replace(/_/g, '')).toBe(String(KDF_ITERATIONS));
		const maxMatch = source.match(/const PBKDF2_MAX_ITERS = ([\d_]+)/);
		expect(maxMatch?.[1].replace(/_/g, '')).toBe(String(KDF_MAX_ITERATIONS));
		expect(KDF_ITERATIONS).toBe(25_000);
		expect(KDF_MAX_ITERATIONS).toBe(100_000);
	});
});

describe('rules parity with the app', () => {
	const cases = [
		'a@b',
		'a@b.c',
		'first.last@sub.example.com',
		"o'brien@example.com",
		'no-at-sign',
		'two@@at.example',
		'spaces in@example.com',
		'newline\n@example.com',
		'@example.com',
		'user@',
		`${'a'.repeat(EMAIL_MAX)}@example.com`,
		`${'a'.repeat(EMAIL_MAX - 12)}@example.com`
	];

	it('agrees with the app on every address', () => {
		expect(EMAIL_MAX).toBe(APP_EMAIL_MAX);
		for (const value of cases) {
			const email = normalizeEmail(value);
			expect(appNormalizeEmail(value)).toBe(email);
			expect(emailProblem(email)).toBe(appEmailProblem(email));
		}
	});

	it('agrees with the app on every password length that matters', () => {
		expect(PASSWORD_MIN).toBe(APP_PASSWORD_MIN);
		for (const value of [
			'',
			'short',
			'a'.repeat(PASSWORD_MIN - 1),
			'a'.repeat(PASSWORD_MIN),
			'a'.repeat(500)
		]) {
			expect(passwordProblem(value)).toBe(appPasswordProblem(value));
		}
	});
});

describe('what the CLI refuses to do', () => {
	it('will not write an account it cannot verify, or one with an invalid address', async () => {
		const { runner, calls } = fakeWrangler();
		await expect(
			seedAccount({ wrangler: runner, email: 'not-an-email', password: 'long enough password' })
		).rejects.toThrow('refusing to create the account');
		await expect(
			seedAccount({ wrangler: runner, email: 'ok@example.com', password: 'short' })
		).rejects.toThrow('refusing to create the account');
		expect(calls).toEqual([]);
	});

	it('reports a failed read instead of pretending the table is empty', async () => {
		const { runner } = fakeWrangler(() => ({ status: 1 }));
		const result = await readAccount({ wrangler: runner });
		expect(result.ok).toBe(false);
		expect(result.exists).toBe(false);
		expect(result.error).toContain('D1 query failed');
	});

	it('does not pass off someone else’s account as the one it created', async () => {
		const { runner } = fakeWrangler((command) =>
			command.startsWith('INSERT') ? {} : { rows: [{ email: 'already@example.com' }] }
		);
		await expect(
			seedAccount({ wrangler: runner, email: 'mine@example.com', password: 'long enough password' })
		).rejects.toThrow('already holds the account already@example.com');
	});

	it('refuses to reset a login that does not exist', async () => {
		const { runner, calls } = fakeWrangler(() => ({ rows: [] }));
		await expect(
			resetAccount({
				wrangler: runner,
				email: 'mine@example.com',
				password: 'long enough password'
			})
		).rejects.toThrow('no account to reset');
		expect(calls.filter((command) => !command.startsWith('SELECT'))).toEqual([]);
	});
});

describe('resetting a login', () => {
	it('replaces the password, keeps the authenticator, and revokes every session', async () => {
		const { runner, calls } = fakeWrangler((command) =>
			command.startsWith('SELECT') ? { rows: [{ email: 'me@example.com' }] } : {}
		);
		await resetAccount({
			wrangler: runner,
			email: 'me@example.com',
			password: 'a brand new password'
		});

		const update = calls.find((command) => command.startsWith('UPDATE'));
		expect(update).toBeDefined();
		expect(update).toContain('password_hash =');
		expect(update).not.toContain('totp_secret_enc = NULL');
		expect(calls).toContain('DELETE FROM sessions;');
	});

	it('throws the authenticator away only when asked', async () => {
		const { runner, calls } = fakeWrangler((command) =>
			command.startsWith('SELECT') ? { rows: [{ email: 'me@example.com' }] } : {}
		);
		await resetAccount({
			wrangler: runner,
			email: 'me@example.com',
			password: 'a brand new password',
			rotateTotp: true
		});
		const update = calls.find((command) => command.startsWith('UPDATE'));
		expect(update).toContain('totp_enabled = 0');
		expect(update).toContain('totp_secret_enc = NULL');
		expect(update).toContain('totp_last_step = NULL');
	});
});

describe('reading wrangler’s JSON', () => {
	it('understands the shape `wrangler d1 execute --json` prints', () => {
		expect(
			parseD1Rows('[{"results":[{"email":"a@b"}],"success":true,"meta":{"duration":3}}]')
		).toEqual([{ email: 'a@b' }]);
		expect(parseD1Rows('[{"results":[],"success":true,"meta":{}}]')).toEqual([]);
	});

	it('says so instead of guessing when the output is not JSON', () => {
		expect(() => parseD1Rows('')).toThrow('no output');
		expect(() => parseD1Rows('✘ [ERROR] no such table: users')).toThrow('could not parse');
		expect(() => parseD1Rows('{"results":[]}')).toThrow('unexpected D1 result shape');
	});
});

describe('generated passwords', () => {
	it('are long, unambiguous enough to store, and accepted by the app', () => {
		const first = generatePassword();
		const second = generatePassword();
		expect(first).toHaveLength(32);
		expect(first).not.toBe(second);
		expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(appPasswordProblem(first)).toBeNull();
	});
});

describe('scripts/setup.mjs ordering', () => {
	it('creates the account before the URL exists', () => {
		// The whole point of seeding from the CLI: by the time the Worker answers
		// its first request, the users table already holds the account.
		const source = readFileSync('scripts/setup.mjs', 'utf8');
		const seed = source.indexOf('await seedAccount(');
		const deploy = source.indexOf("say('8. Deploy')");
		expect(seed).toBeGreaterThan(0);
		expect(deploy).toBeGreaterThan(0);
		expect(seed).toBeLessThan(deploy);
	});

	it('never writes an admin password into .dev.vars or a Worker secret', () => {
		// The password exists in memory and as a PBKDF2 hash in D1, nowhere else.
		for (const file of ['scripts/setup.mjs', 'scripts/admin-reset.mjs', 'scripts/seed-local.mjs']) {
			const source = readFileSync(file, 'utf8');
			expect(source, file).not.toContain('ADMIN_PASSWORD');
			expect(source, file).not.toContain('ADMIN_EMAIL');
		}
	});
});

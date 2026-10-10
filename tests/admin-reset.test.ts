import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyPassword } from '$lib/server/crypto';
import { assertAuthGateOpen, recordAuthGateFailure } from '$lib/server/auth-gate';
import { createTestAdmin, createTestDb, TEST_ENV } from '$lib/server/db/test';
import { clearAuthGatesSql } from '../scripts/lib/account.mjs';

// Each test starts real Node processes, which take far longer than vitest's
// 5 s default on a busy machine.
const RUNS_A_SCRIPT = { timeout: 30_000 };

/**
 * `npm run admin:reset` as the operator runs it: a stubbed `npx` that answers
 * like D1, no network and no Cloudflare account.
 */
describe('admin:reset', RUNS_A_SCRIPT, () => {
	let dir: string | null = null;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = null;
	});

	/** `accountEmail: null` stands for an instance with no account yet. */
	function scratch(accountEmail: string | null, { failRead = false } = {}) {
		const created = mkdtempSync(join(tmpdir(), 'cogsend-admin-'));
		dir = created;
		writeFileSync(join(created, 'wrangler.jsonc'), '{\n\t"name": "cogsend"\n}\n');
		const bin = join(created, 'bin');
		mkdirSync(bin);
		const rows = accountEmail ? `[{ "email": ${JSON.stringify(accountEmail)} }]` : '[]';
		writeFileSync(
			join(bin, 'npx'),
			`#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
const i = args.indexOf('--command');
const sql = i >= 0 ? args[i + 1] : '';
appendFileSync(${JSON.stringify(join(created, 'calls.log'))}, JSON.stringify([sql || args.join(' ')]) + '\\n');
if (sql.startsWith('SELECT')) {
  if (${failRead ? 'true' : 'false'}) { console.log('no such table: users'); process.exit(1); }
  console.log(JSON.stringify([{ results: ${rows}, success: true, meta: {} }]));
  process.exit(0);
}
console.log(JSON.stringify([{ results: [], success: true, meta: {} }]));
process.exit(0);
`
		);
		chmodSync(join(bin, 'npx'), 0o755);
		return { root: created, bin };
	}

	function runReset(bin: string, args: string[] = []) {
		return spawnSync('node', ['scripts/admin-reset.mjs', ...args], {
			encoding: 'utf8',
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }
		});
	}

	const calls = (root: string) =>
		readFileSync(join(root, 'calls.log'), 'utf8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line).at(-1) as string);

	/** Writes only: the account check's `secret list` and `whoami` are reads too. */
	function statements(root: string) {
		return calls(root).filter(
			(sql) => !sql.startsWith('SELECT') && !/^wrangler (secret list|whoami)\b/.test(sql)
		);
	}

	it('sets a new password, revokes every session, and keeps the authenticator', () => {
		const { root, bin } = scratch('me@example.com');
		const result = runReset(bin, ['--password', 'a brand new password']);

		expect(result.status).toBe(0);
		const update = statements(root).find((sql) => sql.startsWith('UPDATE users SET'));
		expect(update).toContain(`email = 'me@example.com'`);
		expect(update).not.toContain('totp_enabled = 0');
		expect(statements(root)).toContain('DELETE FROM sessions;');
		// The lockout lives in mfa_challenges, keyed by a hash of the user id —
		// which a reset does not change, so a reset that skipped this table would
		// answer "Too many attempts" to the operator who ran it *because* they
		// were locked out.
		expect(statements(root)).toContain('DELETE FROM mfa_challenges;');
		expect(result.stdout).toContain('new password set for me@example.com');
		// A password the operator typed is never echoed back.
		expect(result.stdout).not.toContain('a brand new password');
	});

	it('can throw the authenticator away too, for a lost phone as well', () => {
		const { root, bin } = scratch('me@example.com');
		const result = runReset(bin, ['--all', '--password', 'a brand new password']);

		expect(result.status).toBe(0);
		const update = statements(root).find((sql) => sql.startsWith('UPDATE users SET'));
		expect(update).toContain('totp_enabled = 0');
		expect(update).toContain('totp_secret_enc = NULL');
		expect(result.stdout).toContain('the authenticator was cleared');
	});

	it('generates a password when there is no terminal, and that password really is the new one', async () => {
		const { root, bin } = scratch('me@example.com');
		const result = runReset(bin);

		expect(result.status).toBe(0);
		const printed = result.stdout.match(/New password — shown once[\s\S]*?\n\s+(\S+)/)?.[1];
		expect(printed, result.stdout).toBeTruthy();

		// The hash written to D1 must verify against the password that was shown,
		// using the app's own verifier: this is the lockout-or-not path.
		const hash = statements(root)
			.find((sql) => sql.startsWith('UPDATE users SET'))
			?.match(/password_hash = '([^']+)'/)?.[1];
		expect(hash).toBeTruthy();
		expect(await verifyPassword(printed as string, hash as string)).toBe(true);
	});

	it('clears a locked-out account, proven against the app own gate', async () => {
		const { db, close } = await createTestDb();
		try {
			const row = await createTestAdmin(db, { email: 'locked@example.com' });
			// Eight failures is the lockout, exactly as the login route counts it.
			for (let i = 0; i < 8; i++) {
				await recordAuthGateFailure(db, TEST_ENV, row.id, 'password');
			}
			await expect(assertAuthGateOpen(db, TEST_ENV, row.id, 'password')).rejects.toThrow(
				/Too many attempts/
			);

			// The statement the reset runs, applied to the same database.
			for (const sql of clearAuthGatesSql()
				.split(';')
				.filter((s) => s.trim())) {
				await db.run(sql);
			}
			await expect(assertAuthGateOpen(db, TEST_ENV, row.id, 'password')).resolves.toBeUndefined();
		} finally {
			close();
		}
	});

	it('changes nothing on a dry run', () => {
		const { root, bin } = scratch('me@example.com');
		const result = runReset(bin, ['--dry-run']);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('Would:');
		expect(statements(root)).toEqual([]);
	});

	it('refuses an instance that has no account, pointing at setup', () => {
		const { bin } = scratch(null);
		const result = runReset(bin, ['--password', 'a brand new password']);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain('no account yet');
		expect(result.stderr).toContain('npm run setup');
	});

	it('reports an unreadable database instead of pretending it is empty', () => {
		const { bin } = scratch('me@example.com', { failRead: true });
		const result = runReset(bin, ['--password', 'a brand new password']);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain('could not read the account');
	});

	it('will not silently move the account to another address', () => {
		const { root, bin } = scratch('me@example.com');
		const result = runReset(bin, [
			'--email',
			'other@example.com',
			'--password',
			'a brand new password'
		]);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain('the account is me@example.com');
		expect(statements(root)).toEqual([]);
	});

	it('refuses the removed --strong-kdf flag', () => {
		const { root, bin } = scratch('me@example.com');
		const result = runReset(bin, ['--strong-kdf', '--password', 'a brand new password']);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain('--strong-kdf was removed');
		// Refused before it touches the database: the stubbed wrangler never ran.
		expect(existsSync(join(root, 'calls.log'))).toBe(false);
	});
});

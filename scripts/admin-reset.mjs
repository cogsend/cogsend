#!/usr/bin/env node
/**
 * Recover the login of an instance you own, from the terminal.
 *
 * There is no emailed reset link and no public reset route, because there is no
 * mail provider in the login path and no reason for one: whoever can run this
 * script can already read the database and the Worker's secrets, so possession
 * of the Cloudflare account *is* the recovery factor. That keeps the trust
 * boundary identical to installing, and leaves nothing for anyone to phish.
 *
 * Two shapes of "I am locked out":
 *
 *   * forgot the password, still have the authenticator app →
 *     a new password is written and every session is revoked; the enrolled
 *     authenticator keeps working.
 *   * lost both → `--all` also clears the authenticator, and the next browser
 *     sign-in walks through enrollment again with a fresh QR and fresh codes.
 *
 * Usage:
 *   npm run admin:reset                    # new password (prompted, or generated once and printed)
 *   npm run admin:reset -- --all           # also throw the authenticator away
 *   npm run admin:reset -- --password '…'  # no prompt (which puts it in shell history: prefer the prompt)
 *   npm run admin:reset -- --email you@example.com
 *   npm run admin:reset -- --dry-run       # read-only: says what it would do
 *
 * `npm run setup -- --reset-login` does the same thing as the default case while
 * it is creating or re-checking the resources; this script exists for the day
 * the password is simply gone.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	KDF_ITERATIONS,
	PASSWORD_MIN,
	emailProblem,
	generatePassword,
	normalizeEmail,
	passwordProblem,
	readAccount,
	resetAccount
} from './lib/account.mjs';
import { ask, askSecret } from './lib/prompt.mjs';
import { guardTarget } from './lib/target-account.mjs';

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '..'));

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const value = (name, fallback = null) => {
	const i = argv.indexOf(name);
	const next = argv[i + 1];
	return i >= 0 && next && !next.startsWith('--') ? next : fallback;
};

const DRY = has('--dry-run');
const ASSUME_YES = has('--yes');
const ROTATE_TOTP = has('--all');

const info = (message) => console.log(`  ${message}`);
const warn = (message) => console.log(`  ! ${message}`);
const fail = (message) => {
	console.error(`\n✘ ${message}`);
	process.exit(1);
};

/** Always through the repo wrapper, so `wrangler.personal.jsonc` and
 *  `WRANGLER_PROFILE` apply exactly as they do for the npm scripts. Failures are
 *  returned rather than fatal: `lib/account.mjs` decides what they mean. */
function wrangler(args, opts = {}) {
	if (DRY && !opts.readOnly) {
		console.log(`  $ node scripts/wrangler.mjs ${args.join(' ')}   (skipped: dry run)`);
		return { status: 0, stdout: '', stderr: '' };
	}
	console.log(`  $ node scripts/wrangler.mjs ${args.join(' ')}`);
	const result = spawnSync('node', ['scripts/wrangler.mjs', ...args], { encoding: 'utf8' });
	if (!opts.quiet) {
		if (result.stdout?.trim()) console.log(result.stdout.trimEnd());
		if (result.stderr?.trim()) console.error(result.stderr.trimEnd());
	}
	return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

async function main() {
	console.log(`CogSend admin reset${DRY ? ' (dry run — nothing will be changed)' : ''}`);
	// Removed because workerd rejects PBKDF2 counts above 100,000: the old 600k
	// option wrote a hash the Worker could never verify.
	if (has('--strong-kdf')) {
		fail('--strong-kdf was removed: Workers cannot verify PBKDF2 counts above 100,000');
	}

	guardTarget({
		print: (headline, notes) => {
			info(headline);
			for (const line of notes) info(line);
		},
		refuse: (headline, notes) => fail([headline, ...notes.map((line) => `  ${line}`)].join('\n'))
	});

	const account = await readAccount({ wrangler });
	if (!account.ok) {
		fail(
			`could not read the account: ${account.error}\n` +
				'Run `npm run setup` first — it creates the database, the migrations and the account.'
		);
	}
	if (!account.exists) {
		fail('this instance has no account yet. Run `npm run setup` to create one.');
	}

	const email = normalizeEmail(value('--email', account.email));
	const emailIssue = emailProblem(email);
	if (emailIssue) fail(`${email}: ${emailIssue}`);
	if (email !== account.email) {
		fail(
			`the account is ${account.email}; this script rewrites it rather than moving it.\n` +
				'Sign in and change the address in Settings → Account if you want a different one.'
		);
	}

	const interactive = !DRY && !ASSUME_YES && Boolean(process.stdin.isTTY);
	if (ROTATE_TOTP) {
		warn('--all: the authenticator app for this account will stop working.');
		warn('The next sign-in will ask you to set up a new one and show new backup codes.');
		if (interactive) {
			const answer = await ask('Type "yes" to continue', '');
			if (answer.toLowerCase() !== 'yes') fail('nothing was changed');
		}
	}

	const iterations = KDF_ITERATIONS;
	let password = value('--password', '') ?? '';
	let generated = false;
	if (DRY) {
		console.log(`
Would:
  - give ${email} a new password (PBKDF2-SHA256, ${iterations} iterations)
  - revoke every session, on every device${ROTATE_TOTP ? '\n  - clear the enrolled authenticator, so the next sign-in sets up a new one' : ''}

Nothing was changed. Re-run without --dry-run to do it.`);
		return;
	}
	if (!password) {
		const typed = await askSecret('New password (press enter to generate one)', { interactive });
		password = typed || generatePassword();
		generated = !typed;
	}
	const passwordIssue = passwordProblem(password);
	if (passwordIssue) fail(`${passwordIssue} — at least ${PASSWORD_MIN} characters`);

	await resetAccount({ wrangler, email, password, iterations, rotateTotp: ROTATE_TOTP });
	info(`new password set for ${email}`);
	info('every session revoked: every device signs in again');
	if (ROTATE_TOTP) info('the authenticator was cleared: the next sign-in will set up a new one');

	if (generated) {
		console.log(`
  New password — shown once, store it in a password manager:

      ${password}

  Nothing else changed: the account, its drafts, connections and keys are all
  still there.`);
	} else {
		console.log(
			'\n  Nothing else changed: the account, its drafts, connections and keys are all still there.'
		);
	}
}

main().catch((err) => fail(err?.message ?? String(err)));

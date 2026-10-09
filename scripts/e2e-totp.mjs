#!/usr/bin/env node
/**
 * Run the 2FA enrollment spec with the test fixture but without SKIP_TOTP.
 * A temporary env file is passed to Wrangler and Playwright; the developer's
 * `.dev.vars` is never read, replaced, or rewritten.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE = 'tests/e2e/fixtures/dev.vars';
const tempDir = mkdtempSync(join(tmpdir(), 'cogsend-e2e-totp-'));
const envFile = join(tempDir, 'dev.vars');

try {
	const withoutSkipTotp = readFileSync(FIXTURE, 'utf8')
		.split(/\r?\n/)
		.filter((line) => !/^\s*SKIP_TOTP\s*=/.test(line))
		.join('\n');
	writeFileSync(envFile, withoutSkipTotp, { mode: 0o600 });
	console.error('e2e: 2FA required for this run (developer .dev.vars is untouched)');

	const result = spawnSync(
		'npx',
		// --no-deps: the shared sign-in (tests/e2e/sign-in.setup.ts) expects no
		// second factor, and this journey signs itself in anyway.
		['playwright', 'test', 'tests/e2e/smoke.e2e.ts', '-g', 'signs in and enrolls 2fa', '--no-deps'],
		{
			stdio: 'inherit',
			env: { ...process.env, COGSEND_E2E_VARS_FILE: envFile }
		}
	);
	process.exitCode = result.status ?? 1;
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}

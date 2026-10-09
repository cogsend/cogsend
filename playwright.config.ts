import { defineConfig } from '@playwright/test';
import { E2E_ACCOUNT, E2E_PERSIST_TO, E2E_VARS_FILE } from './tests/e2e/e2e-env';

export default defineConfig({
	// Fresh local D1 on every run, in its own state directory so a test run never
	// deletes the data a developer uses for `npm run dev`.
	webServer: {
		// Order matters: a clean state directory, a build, the account (seeded, so
		// the run skips the claim page), and only then the server.
		command:
			`rm -rf ${E2E_PERSIST_TO} && npm run build && ` +
			`node scripts/seed-local.mjs --persist-to ${E2E_PERSIST_TO} --reset ` +
			`--email ${E2E_ACCOUNT.email} --password ${E2E_ACCOUNT.password} && ` +
			`node scripts/wrangler.mjs dev .svelte-kit/cloudflare/_worker.js --port 4173 --persist-to ${E2E_PERSIST_TO} --env-file "${E2E_VARS_FILE}"`,
		port: 4173
	},
	workers: 1,
	testMatch: 'tests/e2e/**/*.e2e.{ts,js}'
});

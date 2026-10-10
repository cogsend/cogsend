/**
 * The output layer: what a step prints, and what it reads back out of the tools.
 *
 * The fixtures below are copies of real runs — a `wrangler deploy`, and a
 * `wrangler d1 migrations apply` that reprints its table after every migration.
 * They are the reason the setup log used to be several hundred lines.
 */
import { describe, expect, it, vi } from 'vitest';
import {
	box,
	clearProgress,
	colorsEnabled,
	deployFacts,
	isTerminal,
	migrationNames,
	migrationsSummary,
	parseBuildMs,
	progress,
	stripToolNoise,
	visibleWidth
} from '../scripts/lib/cli.mjs';

const DEPLOY = ` ⛅️ wrangler 4.131.2 (update available 4.136.1)
───────────────────────────────────────────────
🌀 Building list of assets...
✨ Read 52 files from the assets directory /tmp/cogsend/.svelte-kit/cloudflare
🌀 Starting asset upload...
+ /_app/immutable/chunks/BvRk9kiK.js
+ /robots.txt
✨ Success! Uploaded 41 files (2.16 sec)

Total Upload: 2174.43 KiB / gzip: 401.01 KiB
Worker Startup Time: 34 ms
Your Worker has access to the following bindings:
Binding                                      Resource
env.DB (cogsend)                             D1 Database
env.MEDIA (cogsend-media)                    R2 Bucket
env.AUTH_RATE_LIMITER (20 requests/60s)      Rate Limit
env.ASSETS                                   Assets

Uploaded cogsend (10.91 sec)
Deployed cogsend triggers (4.35 sec)
  https://cogsend.your-subdomain.workers.dev
  schedule: * * * * *
Current Version ID: 93116b57-041a-416e-8224-aeaddd3ab446`;

/** The same two migrations, listed once and then reprinted as each is applied. */
const MIGRATIONS = `⛅️ wrangler 4.131.2 (update available 4.136.1)
───────────────────────────────────────────────
Resource location: remote

Migrations to be applied:
┌───────────────────────┐
│ name                  │
├───────────────────────┤
│ 0001_init.sql         │
├───────────────────────┤
│ 0002_totp.sql         │
└───────────────────────┘
? About to apply 2 migration(s)
🤖 Using fallback value in non-interactive context: yes
🌀 Executing on remote database DB (8204170f-a950-4ba9-948c-1500f6f8b2f1):
🌀 To execute on your local development database, remove the --remote flag.
│ 0001_init.sql         │ ✅     │
│ 0002_totp.sql         │ 🕒️    │
🌀 Executing on remote database DB (8204170f-a950-4ba9-948c-1500f6f8b2f1):
│ 0001_init.sql         │ ✅     │
│ 0002_totp.sql         │ ✅     │`;

describe('tool output', () => {
	it('drops wrangler chrome and keeps what it actually said', () => {
		const cleaned = stripToolNoise(DEPLOY);
		expect(cleaned).not.toContain('update available');
		expect(cleaned).not.toContain('─────');
		expect(cleaned).not.toContain('Using fallback value');
		expect(cleaned).toContain('env.DB (cogsend)');
		expect(cleaned).toContain('https://cogsend.your-subdomain.workers.dev');
	});

	it('keeps the migration tables themselves out of the summary path', () => {
		const cleaned = stripToolNoise(MIGRATIONS);
		// The table is data, not chrome: only the banner, the rule and the
		// prompt fallbacks go.
		expect(cleaned).toContain('0001_init.sql');
		expect(cleaned).not.toContain('Resource location');
		expect(cleaned).not.toContain('remove the --remote flag');
	});
});

describe('deployFacts', () => {
	it('reads the URL, bindings and version out of the deploy output', () => {
		const facts = deployFacts(DEPLOY);
		expect(facts.url).toBe('https://cogsend.your-subdomain.workers.dev');
		expect(facts.bindings).toEqual(['DB', 'MEDIA', 'AUTH_RATE_LIMITER', 'ASSETS']);
		expect(facts.versionId).toBe('93116b57-041a-416e-8224-aeaddd3ab446');
		expect(facts.startupMs).toBe(34);
	});

	it('does not invent a URL', () => {
		const facts = deployFacts('Deployed sent https://cogsend.invalid');
		expect(facts.url).toBe(null);
		expect(facts.bindings).toEqual([]);
	});
});

describe('migrationsSummary', () => {
	it('counts each migration once, however often wrangler reprints the table', () => {
		expect(migrationNames(MIGRATIONS)).toEqual(['0001_init.sql', '0002_totp.sql']);
		expect(migrationsSummary(MIGRATIONS)).toBe('2 migrations applied');
	});

	it('pluralises, and reports the empty case', () => {
		expect(migrationsSummary('│ 0001_init.sql │ ✅ │')).toBe('1 migration applied');
		expect(migrationsSummary('✅ No migrations to apply!')).toBe('no pending migrations');
		expect(migrationsSummary('something else entirely')).toBe(null);
	});
});

describe('build times', () => {
	it('reads vite’s own number', () => {
		expect(parseBuildMs('✓ built in 5.21s')).toBe(5210);
		expect(parseBuildMs('✓ built in 340ms')).toBe(null);
	});
});

describe('printing', () => {
	it('stays plain text when nobody is watching', () => {
		expect(colorsEnabled()).toBe(false);
		expect(box(['x'])).not.toContain('\u001b[');
	});

	it('pads a box to one visible width, colour aside', () => {
		const lines = box(['CogSend is live', 'https://cogsend.your-subdomain.workers.dev']).split(
			'\n'
		);
		expect(lines).toHaveLength(4);
		expect(new Set(lines.map(visibleWidth)).size).toBe(1);
	});

	it('keeps progress notes out of a pipe, where a log wants one line per step', () => {
		const written: string[] = [];
		const spy = vi
			.spyOn(process.stdout, 'write')
			.mockImplementation((chunk: unknown) => (written.push(String(chunk)), true));
		progress('building');
		clearProgress();
		spy.mockRestore();
		expect(isTerminal()).toBe(false);
		expect(written).toEqual([]);
	});
});

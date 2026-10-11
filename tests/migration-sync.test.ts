import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { INIT_SQL } from '#lib/server/db/init-sql.js';
import {
	D1_MIGRATIONS_DDL,
	INITIAL_TABLES,
	INTROSPECTION_SQL,
	insertMigrationsSql,
	readState,
	satisfiedMigrations,
	syncMigrations
} from '../scripts/lib/migration-sync.mjs';

/**
 * A database the app bootstrapped has the schema and no migration history.
 * Replaying migrations into it used to abort — 0001 is a plain `CREATE TABLE`,
 * 0013 a plain `ALTER TABLE ADD COLUMN` — so both documented upgrade commands
 * failed on any instance deployed without `npm run setup`. These tests pin the
 * fix from both ends: the postconditions must be true of the bootstrap DDL, and
 * the wrapper must record them before wrangler replays anything.
 */
async function introspectionOnBootstrap() {
	const client = createClient({ url: ':memory:' });
	await client.executeMultiple(INIT_SQL);
	// The real flow creates the history table before asking; do the same here.
	await client.execute(D1_MIGRATIONS_DDL);
	const rows = (await client.execute(INTROSPECTION_SQL)).rows as unknown as Array<
		Record<string, unknown>
	>;
	client.close();
	return readState(rows[0]);
}

describe('satisfiedMigrations', () => {
	it('finds nothing to record on an empty database', () => {
		expect(satisfiedMigrations(readState(undefined))).toEqual([]);
	});

	it('leaves a bootstrapped database with a replayable remainder', async () => {
		// The property that matters: whatever is *not* recorded must actually be
		// replayable. A migration whose effects the bootstrap DDL already has
		// (0001's tables, 0013's columns) aborts the upgrade unless it is
		// recorded first; a genuinely new migration must still run.
		const client = createClient({ url: ':memory:' });
		await client.executeMultiple(INIT_SQL);
		await client.execute(D1_MIGRATIONS_DDL);
		const rows = (await client.execute(INTROSPECTION_SQL)).rows as unknown as Array<
			Record<string, unknown>
		>;
		const satisfied = new Set(satisfiedMigrations(readState(rows[0])));
		const files = readdirSync('drizzle')
			.filter((f) => f.endsWith('.sql'))
			.sort();
		const failed: string[] = [];
		for (const file of files) {
			if (satisfied.has(file)) continue;
			try {
				await client.executeMultiple(readFileSync(`drizzle/${file}`, 'utf8'));
			} catch (err) {
				failed.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		client.close();
		expect(failed).toEqual([]);
		// The migrations the bootstrap DDL squashes are recorded, not replayed.
		expect([...satisfied]).toContain('0001_init.sql');
		expect([...satisfied]).toContain('0013_sessions_security.sql');
		expect([...satisfied]).toContain('0016_mfa_challenges_expires_idx.sql');
	});

	it('keeps the 0001 table list in step with the migration', () => {
		const created = [
			...readFileSync('drizzle/0001_init.sql', 'utf8').matchAll(/CREATE TABLE `([a-z_]+)`/g)
		].map((m) => m[1]!);
		expect([...INITIAL_TABLES].sort()).toEqual(created.sort());
	});

	it('does not treat a stub database as having 0001', () => {
		expect(satisfiedMigrations(readState({ tables: 'users sessions' }))).not.toContain(
			'0001_init.sql'
		);
		expect(satisfiedMigrations(readState({ tables: INITIAL_TABLES.join(' ') }))).toContain(
			'0001_init.sql'
		);
	});

	it('leaves a migration unrecorded when its postcondition is missing', async () => {
		const client = createClient({ url: ':memory:' });
		await client.executeMultiple(INIT_SQL);
		await client.execute(D1_MIGRATIONS_DDL);
		await client.execute('DROP INDEX IF EXISTS mfa_challenges_expires_idx');
		await client.execute('ALTER TABLE drafts DROP COLUMN selected_connection_ids');
		const rows = (await client.execute(INTROSPECTION_SQL)).rows as unknown as Array<
			Record<string, unknown>
		>;
		client.close();

		const satisfied = satisfiedMigrations(readState(rows[0]));
		expect(satisfied).not.toContain('0016_mfa_challenges_expires_idx.sql');
		expect(satisfied).not.toContain('0015_draft_selected_connections.sql');
		expect(satisfied).toContain('0014_notification_digest.sql');
	});

	it('treats the draft/connection index as satisfied only when it is unique', () => {
		const state = (unique: string) =>
			readState({
				tables: 'users',
				publish_targets_idx: `publish_targets_draft_conn_idx:${unique}`
			});
		expect(satisfiedMigrations(state('0'))).toContain('0003_publish_targets_draft_conn_idx.sql');
		expect(satisfiedMigrations(state('0'))).not.toContain('0004_publish_targets_draft_conn_uq.sql');
		expect(satisfiedMigrations(state('1'))).toContain('0004_publish_targets_draft_conn_uq.sql');
	});
});

describe('syncMigrations', () => {
	it('records the satisfied set in one statement and skips what is recorded', async () => {
		const state = await introspectionOnBootstrap();
		const executed: string[] = [];
		const recorded = await syncMigrations({
			exec: async (sql: string) => {
				executed.push(sql);
			},
			query: async () => [rowFor(state)]
		});
		expect(recorded.recorded.length).toBeGreaterThan(10);
		// DDL, the introspection read, then exactly one INSERT.
		expect(executed).toHaveLength(2);
		expect(executed[1]).toContain('INSERT INTO d1_migrations (name) VALUES');
		expect(executed[1]).toContain("('0001_init.sql')");
	});

	it('does nothing when everything is already recorded', async () => {
		const state = await introspectionOnBootstrap();
		const applied = satisfiedMigrations(state);
		const executed: string[] = [];
		const result = await syncMigrations({
			exec: async (sql: string) => {
				executed.push(sql);
			},
			query: async () => [{ ...rowFor(state), applied: applied.join(' ') }]
		});
		expect(result.recorded).toEqual([]);
		expect(executed).toHaveLength(1); // just the DDL
	});

	it('quotes a migration name with an apostrophe', () => {
		expect(insertMigrationsSql(["o'brien.sql"])).toBe(
			"INSERT INTO d1_migrations (name) VALUES ('o''brien.sql')"
		);
	});
});

/** Rebuild the aggregate row a state came from, so the sync can be driven
 *  without a live database. */
function rowFor(state: ReturnType<typeof readState>) {
	const row: Record<string, unknown> = { tables: [...state.tables].join(' ') };
	for (const [table, cols] of state.columns) row[`${table}_cols`] = [...cols].join(' ');
	for (const [table, idx] of state.indexes) {
		row[`${table}_idx`] = [...idx].map(([name, unique]) => `${name}:${unique ? 1 : 0}`).join(' ');
	}
	return row;
}

/**
 * The wrapper as the operator experiences it: a fake `wrangler` that answers the
 * introspection query, so the real script runs with no network.
 */
describe('db:migrate wrapper', () => {
	let dir: string | null = null;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = null;
	});

	it('records what a bootstrapped database satisfies, then applies the rest', async () => {
		const state = await introspectionOnBootstrap();
		const created = mkdtempSync(join(tmpdir(), 'cogsend-migrate-'));
		dir = created;
		writeFileSync(join(created, 'wrangler.jsonc'), '{\n\t"name": "cogsend"\n}\n');
		const bin = join(created, 'bin');
		mkdirSync(bin);
		const payload = JSON.stringify([{ results: [rowFor(state)], success: true, meta: {} }]);
		// Records every call; answers the introspection query with the state of a
		// bootstrapped database and everything else with an empty result.
		writeFileSync(
			join(bin, 'npx'),
			`#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(created, 'calls.log'))}, JSON.stringify(args) + '\\n');
if (args.includes('--json')) { process.stdout.write(${JSON.stringify(payload)}); process.exit(0); }
process.exit(0);
`
		);
		chmodSync(join(bin, 'npx'), 0o755);

		const result = spawnSync('node', [join(process.cwd(), 'scripts/migrate-remote.mjs')], {
			cwd: created,
			encoding: 'utf8',
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }
		});
		expect(result.status).toBe(0);
		const calls = readFileSync(join(created, 'calls.log'), 'utf8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as string[]);
		const insert = calls.find((args) => args.join(' ').includes('INSERT INTO d1_migrations'));
		expect(insert).toBeDefined();
		expect(insert!.join(' ')).toContain("('0016_mfa_challenges_expires_idx.sql')");
		expect(calls.at(-1)!.join(' ')).toContain('d1 migrations apply DB --remote');
	});
});

describe('npm run setup', () => {
	let dir: string | null = null;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = null;
	});

	/**
	 * `setup` builds before it migrates, so this runs the whole script in a
	 * scratch checkout with `npm` stubbed out (the build) and `npx` stubbed out
	 * (wrangler). The database it meets is a bootstrapped one — schema complete,
	 * history empty — which is the state the documented manual deploy leaves
	 * behind, because the cron trigger fires a request within a minute of the
	 * first deploy and the app creates its own tables.
	 */
	it('records what the database satisfies before replaying migrations', async () => {
		const state = await introspectionOnBootstrap();
		const created = mkdtempSync(join(tmpdir(), 'cogsend-setup-'));
		dir = created;
		cpSync(join(process.cwd(), 'scripts'), join(created, 'scripts'), { recursive: true });
		cpSync(join(process.cwd(), 'wrangler.jsonc'), join(created, 'wrangler.jsonc'));
		writeFileSync(
			join(created, '.dev.vars'),
			'APP_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n'
		);
		const bin = join(created, 'bin');
		mkdirSync(bin);
		// The build is the one step that cannot run here.
		writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 0\n');
		chmodSync(join(bin, 'npm'), 0o755);
		const payload = JSON.stringify([{ results: [rowFor(state)], success: true, meta: {} }]);
		writeFileSync(
			join(bin, 'npx'),
			`#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(created, 'calls.log'))}, JSON.stringify(args) + '\\n');
if (args.includes('whoami')) {
	console.log(JSON.stringify({ loggedIn: true, email: 'me@example.com', accounts: [{ name: 'Acme' }] }));
	process.exit(0);
}
if (args.includes('secret') && args.includes('list')) {
	console.log(JSON.stringify([{ name: 'APP_ENCRYPTION_KEY' }]));
	process.exit(0);
}
if (args.includes('d1') && args.includes('list')) {
	console.log(JSON.stringify([{ name: 'cogsend', uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }]));
	process.exit(0);
}
if (args.includes('d1') && args.includes('execute')) {
	const sql = args[args.indexOf('--command') + 1] || '';
	if (sql.includes('pragma_table_info')) {
		process.stdout.write(${JSON.stringify(payload)});
		process.exit(0);
	}
	// An account that is already there and already has an authenticator: the
	// re-run case, which must leave the login alone and say so.
	if (sql.startsWith('SELECT email')) {
		console.log(JSON.stringify([{ results: [{ email: 'me@example.com', totp_enabled: 1 }], success: true, meta: {} }]));
		process.exit(0);
	}
	console.log(JSON.stringify([{ results: [], success: true, meta: {} }]));
	process.exit(0);
}
if (args.includes('r2') && args.includes('create')) {
	// The re-run case: the bucket is already there, and Cloudflare says so with
	// a red ERROR block (code 10004).
	console.error('ERROR A request to the Cloudflare API (/accounts/x/r2/buckets) failed.\\n  The bucket you tried to create already exists, and you own it. [code: 10004]');
	process.exit(1);
}
if (args.includes('deploy')) { console.log('Deployed sent https://cogsend.invalid'); process.exit(0); }
process.exit(0);
`
		);
		chmodSync(join(bin, 'npx'), 0o755);

		const result = spawnSync(
			process.execPath,
			[
				join(created, 'scripts/setup.mjs'),
				'--yes',
				// `--yes` cannot invent the address to attach the account to.
				'--admin-email',
				'me@example.com'
			],
			{
				cwd: created,
				encoding: 'utf8',
				env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }
			}
		);
		expect(result.status).toBe(0);
		const calls = readFileSync(join(created, 'calls.log'), 'utf8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as string[])
			.map((args) => args.join(' '));
		const insert = calls.findIndex((line) => line.includes('INSERT INTO d1_migrations'));
		const apply = calls.findIndex((line) => line.includes('migrations apply DB --remote'));
		// Both happened, and the history was written first: a plain replay into a
		// bootstrapped database aborts on 0001 ("table `users` already exists").
		expect(insert).toBeGreaterThan(-1);
		expect(apply).toBeGreaterThan(-1);
		expect(insert).toBeLessThan(apply);
		// Re-running is safe and says so: the login is left alone, and a promise
		// about enrolling an authenticator is only made when one is needed.
		expect(result.stdout).toContain('an account already exists (me@example.com) — left alone');
		expect(result.stdout).toContain('The authenticator you enrolled is unchanged.');
		expect(calls.some((line) => line.includes('INSERT INTO users'))).toBe(false);
		// A bucket that already exists is the normal answer on a re-run, so the
		// operator gets the verdict, not wrangler's red error block.
		expect(result.stdout).toContain('cogsend-media already exists');
		expect(result.stdout + result.stderr).not.toContain('The bucket you tried to create');
	});
});

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import {
	ensureSchema,
	ensureSchemaOnce,
	INIT_SQL,
	SCHEMA_FINGERPRINT,
	SCHEMA_MARKER_KEY
} from '#lib/server/db/init-sql.js';

/**
 * The bootstrap DDL is what a cold Worker runs before anything else, and until
 * now no test executed a single one of its statements. Running it against real
 * SQLite (via the same libsql driver the other tests use) proves the SQL is
 * valid, creates the tables the app queries, and stays idempotent on the
 * migration path an existing database takes.
 */
function d1Shim(client: Client): D1Database {
	const run = (sql: string, args: unknown[] = []) =>
		client.execute({ sql, args: args as never }) as Promise<unknown>;
	return {
		exec: (sql: string) => client.executeMultiple(sql) as unknown as Promise<unknown>,
		prepare: (sql: string) => {
			const stmt = (bindArgs: unknown[] = []) => ({
				run: () => run(sql, bindArgs),
				all: async () => {
					const res = (await client.execute({ sql, args: bindArgs as never })) as {
						rows: unknown[];
					};
					return { results: res.rows, success: true, meta: {} };
				},
				first: async () => {
					const res = (await client.execute({ sql, args: bindArgs as never })) as {
						rows: unknown[];
					};
					return res.rows[0] ?? null;
				},
				bind: (...args: unknown[]) => stmt(args)
			});
			return stmt();
		}
	} as unknown as D1Database;
}

async function freshDb() {
	const client = createClient({ url: ':memory:' });
	return { client, binding: d1Shim(client) };
}

/** What a database bootstrapped by an older release looks like: no marker. */
async function forgetBootstrap(client: Client) {
	await client.execute({
		sql: 'DELETE FROM app_settings WHERE key = ?',
		args: [SCHEMA_MARKER_KEY]
	});
}

function countingPrepare(binding: D1Database) {
	const seen: string[] = [];
	const proxy = new Proxy(binding as unknown as Record<string, unknown>, {
		get(target, prop, receiver) {
			if (prop === 'prepare') {
				return (sql: string) => {
					seen.push(sql);
					return (target.prepare as (s: string) => unknown).call(target, sql);
				};
			}
			return Reflect.get(target, prop, receiver);
		}
	}) as unknown as D1Database;
	return { proxy, seen };
}

async function tableNames(client: Client): Promise<string[]> {
	const res = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
	return res.rows.map((r) => String((r as unknown as { name: string }).name));
}

describe('ensureSchema', () => {
	it('creates the full schema on an empty database', async () => {
		const { client, binding } = await freshDb();
		await ensureSchema(binding);

		const names = await tableNames(client);
		for (const table of [
			'users',
			'drafts',
			'draft_variants',
			'draft_media',
			'connections',
			'publish_targets',
			'publish_attempts',
			'sessions',
			'oauth_pending',
			'api_keys',
			'mfa_challenges',
			'totp_backup_codes',
			'notification_state'
		]) {
			expect(names).toContain(table);
		}
		client.close();
	});

	it('is idempotent, including the migration path', async () => {
		const { client, binding } = await freshDb();
		await ensureSchema(binding);
		// Without the marker, the second call takes the "users already exists"
		// branch: column adds, the rewritten DDL, index creation and the
		// unique-index dance.
		await forgetBootstrap(client);
		await expect(ensureSchema(binding)).resolves.toBeUndefined();
		await expect(ensureSchema(binding)).resolves.toBeUndefined();
		const names = await tableNames(client);
		expect(names.filter((n) => n === 'publish_targets')).toHaveLength(1);

		const indexes = await client.execute(
			"SELECT name FROM sqlite_master WHERE type='index' AND name='publish_targets_draft_conn_idx'"
		);
		expect(indexes.rows).toHaveLength(1);
		client.close();
	});

	it('runs the bootstrap once per binding and retries after a failure', async () => {
		const { client, binding } = await freshDb();
		let calls = 0;
		const counting = new Proxy(binding as unknown as Record<string, unknown>, {
			get(target, prop, receiver) {
				if (prop === 'prepare') {
					return (sql: string) => {
						calls += 1;
						return (target.prepare as (s: string) => unknown).call(target, sql);
					};
				}
				return Reflect.get(target, prop, receiver);
			}
		}) as unknown as D1Database;

		await ensureSchemaOnce(counting);
		const first = calls;
		expect(first).toBeGreaterThan(0);
		// Memoized: the second request in the same isolate does no DDL.
		await ensureSchemaOnce(counting);
		expect(calls).toBe(first);
		client.close();

		// A failure must not be cached, or a transient D1 error would wedge the
		// isolate for its whole lifetime.
		let attempts = 0;
		const failing = {
			exec: async () => {},
			prepare: () => {
				attempts += 1;
				return {
					run: async () => {},
					all: async () => ({ results: [] }),
					first: async () => {
						throw new Error('D1_ERROR: unavailable');
					},
					bind: () => ({ run: async () => {}, all: async () => ({ results: [] }) })
				};
			}
		} as unknown as D1Database;
		await expect(ensureSchemaOnce(failing)).rejects.toThrow(/D1_ERROR/);
		await expect(ensureSchemaOnce(failing)).rejects.toThrow(/D1_ERROR/);
		expect(attempts).toBeGreaterThan(1);
	});

	/**
	 * The bootstrap is the *only* schema step a database created by it ever
	 * takes, so an index that arrives later as a migration has to be mirrored
	 * here or it never exists. 0016's was missing for exactly that reason, and
	 * nothing noticed because the other test only checks table names. Both
	 * halves are asserted: a fresh bootstrap, and the incremental path an
	 * already-bootstrapped database takes.
	 */
	it('creates every index the migrations create', async () => {
		const fromMigrations = new Set<string>();
		for (const file of readdirSync('drizzle').filter((f) => f.endsWith('.sql'))) {
			const sql = readFileSync(`drizzle/${file}`, 'utf8');
			for (const m of sql.matchAll(
				/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([a-z0-9_]+)`?/gi
			)) {
				fromMigrations.add(m[1]!);
			}
		}
		expect(fromMigrations.size).toBeGreaterThan(10);

		const indexNames = async (client: Client) =>
			new Set(
				(await client.execute("SELECT name FROM sqlite_master WHERE type='index'")).rows.map((r) =>
					String((r as unknown as { name: string }).name)
				)
			);

		// Fresh database: INIT_SQL alone must produce every migration index.
		const fresh = await freshDb();
		await ensureSchema(fresh.binding);
		const freshIndexes = await indexNames(fresh.client);
		expect([...fromMigrations].filter((name) => !freshIndexes.has(name))).toEqual([]);
		fresh.client.close();

		// Already-bootstrapped database: the incremental branch has to backfill
		// the same indexes without being asked twice.
		const older = await freshDb();
		await ensureSchema(older.binding);
		await older.client.execute('DROP INDEX IF EXISTS mfa_challenges_expires_idx');
		await forgetBootstrap(older.client);
		await ensureSchema(older.binding);
		const healed = await indexNames(older.client);
		expect([...fromMigrations].filter((name) => !healed.has(name))).toEqual([]);
		older.client.close();
	});

	it('checks an up-to-date database with a single query', async () => {
		const { client, binding } = await freshDb();
		await ensureSchema(binding);
		const marker = await client.execute({
			sql: 'SELECT value FROM app_settings WHERE key = ?',
			args: [SCHEMA_MARKER_KEY]
		});
		expect(marker.rows[0]?.value).toBe(SCHEMA_FINGERPRINT);

		// A new isolate on a current database: one read, no DDL.
		const warm = countingPrepare(binding);
		await ensureSchema(warm.proxy);
		expect(warm.seen).toHaveLength(1);
		expect(warm.seen[0]).toMatch(/FROM app_settings/);

		// A database an older release bootstrapped takes the full path once,
		// then records the marker so the next isolate does not.
		await forgetBootstrap(client);
		const cold = countingPrepare(binding);
		await ensureSchema(cold.proxy);
		expect(cold.seen.length).toBeGreaterThan(10);
		const again = countingPrepare(binding);
		await ensureSchema(again.proxy);
		expect(again.seen).toHaveLength(1);
		client.close();
	});

	it('runs the full check again when the recorded bootstrap is a different one', async () => {
		const { client, binding } = await freshDb();
		await ensureSchema(binding);
		await client.execute({
			sql: 'UPDATE app_settings SET value = ? WHERE key = ?',
			args: ['an-older-release', SCHEMA_MARKER_KEY]
		});
		await client.execute('DROP INDEX IF EXISTS sessions_expires_idx');
		await ensureSchema(binding);
		const idx = await client.execute(
			"SELECT name FROM sqlite_master WHERE type='index' AND name='sessions_expires_idx'"
		);
		expect(idx.rows).toHaveLength(1);
		client.close();
	});

	it('keeps the bootstrap DDL statement-splittable', async () => {
		// execStatements splits on `;`, so a stray semicolon inside a literal
		// would break one statement into fragments.
		expect(INIT_SQL).not.toMatch(/;\s*;/);
		const statements = INIT_SQL.split(';').filter((s) => s.trim().length > 0);
		expect(statements.length).toBeGreaterThan(10);
		for (const statement of statements) {
			expect(statement.trim().toUpperCase()).toMatch(/^(CREATE|INSERT|DROP|ALTER)/);
		}
	});
});

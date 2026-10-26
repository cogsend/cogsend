/**
 * Keep `d1_migrations` in step with what a database actually contains.
 *
 * The app bootstraps its own schema on the first request (src/lib/server/db/
 * init-sql.ts), which means a database can exist with every table and column
 * already in place and no migration history at all. Replaying migrations into
 * that database aborts — 0001 is a plain `CREATE TABLE`, 0013 a plain
 * `ALTER TABLE ADD COLUMN` — so `npm run deploy:release` and
 * `npm run db:migrate:remote` both died on any instance deployed that way.
 *
 * The rule here: a migration is recorded as applied when its postcondition is
 * already true in the database, and left alone otherwise, so `migrations apply`
 * runs exactly the ones that still have work to do. Every postcondition is a
 * read, never a guess, because marking a migration that is *not* satisfied
 * skips it forever.
 *
 * Used by deploy.mjs, migrate-remote.mjs and seed-local.mjs, so the update
 * paths cannot drift from one another.
 */

/**
 * @typedef {object} DbState
 * @property {Set<string>} tables
 * @property {Map<string, Set<string>>} columns
 * @property {Map<string, Map<string, boolean>>} indexes
 * @property {Set<string>} applied
 */

/** Every table 0001_init.sql creates. `users` alone is not enough: a database
 *  with one stub table must not be recorded as having 0001's schema.
 *  tests/migration-sync.test.ts compares this list against the migration. */
export const INITIAL_TABLES = [
	'connections',
	'draft_media',
	'draft_variants',
	'drafts',
	'oauth_pending',
	'publish_attempts',
	'publish_targets',
	'scheduler_heartbeats',
	'sessions',
	'users'
];

/** Wrangler's own migrations table. Shape copied from what `wrangler d1
 *  migrations apply` creates, so both writers agree on the same table. */
export const D1_MIGRATIONS_DDL = `CREATE TABLE IF NOT EXISTS d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

/**
 * One round trip for everything the postconditions need. D1's SQLite build
 * refuses a compound SELECT with more than a handful of terms ("too many terms
 * in compound SELECT"), so this is one row of `group_concat` subqueries rather
 * than a UNION ALL: a table-valued pragma for a table that does not exist
 * yields NULL instead of an error, which keeps it safe on an empty database.
 * `d1_migrations` is created before this runs, so the last column is readable.
 */
export const INTROSPECTION_SQL = `SELECT
  (SELECT group_concat(name, ' ') FROM sqlite_master WHERE type = 'table') AS tables,
  (SELECT group_concat(name, ' ') FROM pragma_table_info('users')) AS users_cols,
  (SELECT group_concat(name, ' ') FROM pragma_table_info('sessions')) AS sessions_cols,
  (SELECT group_concat(name, ' ') FROM pragma_table_info('api_keys')) AS api_keys_cols,
  (SELECT group_concat(name, ' ') FROM pragma_table_info('drafts')) AS drafts_cols,
  (SELECT group_concat(name, ' ') FROM pragma_table_info('draft_media')) AS draft_media_cols,
  (SELECT group_concat(name || ':' || "unique", ' ') FROM pragma_index_list('publish_targets')) AS publish_targets_idx,
  (SELECT group_concat(name, ' ') FROM pragma_index_list('oauth_pending')) AS oauth_pending_idx,
  (SELECT group_concat(name, ' ') FROM pragma_index_list('mfa_challenges')) AS mfa_challenges_idx,
  (SELECT group_concat(name, ' ') FROM pragma_index_list('draft_media')) AS draft_media_idx,
  (SELECT group_concat(name, ' ') FROM pragma_index_list('drafts')) AS drafts_idx,
  (SELECT group_concat(name, ' ') FROM pragma_index_list('connections')) AS connections_idx,
  (SELECT group_concat(name, ' ') FROM pragma_index_list('sessions')) AS sessions_idx,
  (SELECT group_concat(name, ' ') FROM d1_migrations) AS applied`;

/**
 * Fold that single row into the shape the postconditions read. Column names are
 * space-separated; index entries are `name:1` for a unique index.
 * @param {Record<string, unknown> | undefined} row
 * @returns {DbState}
 */
export function readState(row) {
	/** @type {(value: unknown) => string[]} */
	const list = (value) =>
		String(value ?? '')
			.split(/\s+/)
			.filter(Boolean);
	/** @type {Map<string, Set<string>>} */
	const columns = new Map();
	for (const table of ['users', 'sessions', 'api_keys', 'drafts', 'draft_media']) {
		columns.set(table, new Set(list(row?.[`${table}_cols`])));
	}
	/** @type {Map<string, Map<string, boolean>>} */
	const indexes = new Map();
	for (const table of [
		'publish_targets',
		'oauth_pending',
		'mfa_challenges',
		'draft_media',
		'drafts',
		'connections',
		'sessions'
	]) {
		/** @type {Map<string, boolean>} */
		const entries = new Map();
		for (const entry of list(row?.[`${table}_idx`])) {
			const [name, unique] = entry.split(':');
			if (name) entries.set(name, unique === '1');
		}
		indexes.set(table, entries);
	}
	return {
		tables: new Set(list(row?.tables)),
		columns,
		indexes,
		applied: new Set(list(row?.applied))
	};
}

/**
 * Which migrations the database already satisfies, in file order. Keep this in
 * lockstep with drizzle/*.sql: a migration added there without an entry here
 * simply runs for real, which is the safe direction — the failure mode this
 * guards against is a migration that *cannot* run on a bootstrapped database.
 * @param {DbState} state
 */
export function satisfiedMigrations(state) {
	const { tables, columns, indexes } = state;
	/** @param {string} table @param {string} name */
	const col = (table, name) => columns.get(table)?.has(name) ?? false;
	/** @param {string} table @param {string} name */
	const idx = (table, name) => indexes.get(table)?.has(name) ?? false;
	/** @param {boolean} unique */
	const draftConnIdx = (unique) => {
		const found = indexes.get('publish_targets')?.get('publish_targets_draft_conn_idx');
		return found !== undefined && (!unique || found);
	};
	/** @param {...boolean} checks */
	const all = (...checks) => checks.every(Boolean);
	return [
		['0001_init.sql', INITIAL_TABLES.every((table) => tables.has(table))],
		['0002_totp.sql', col('users', 'totp_enabled')],
		['0003_publish_targets_draft_conn_idx.sql', draftConnIdx(false)],
		['0004_publish_targets_draft_conn_uq.sql', draftConnIdx(true)],
		['0005_profile_settings.sql', col('users', 'settings_json')],
		['0006_oauth_pending_fk.sql', idx('oauth_pending', 'oauth_pending_user_idx')],
		['0007_api_keys.sql', tables.has('api_keys')],
		['0008_display_name.sql', col('users', 'display_name')],
		[
			'0009_publish_targets_conn_status_idx.sql',
			idx('publish_targets', 'publish_targets_conn_status_idx')
		],
		['0010_api_keys_scopes.sql', col('api_keys', 'scopes')],
		[
			'0011_perf_indexes.sql',
			all(
				idx('drafts', 'drafts_user_updated_idx'),
				idx('connections', 'connections_user_status_idx'),
				idx('connections', 'connections_user_created_idx'),
				idx('publish_targets', 'publish_targets_status_updated_idx'),
				idx('sessions', 'sessions_expires_idx')
			)
		],
		['0012_media_storage_key_idx.sql', idx('draft_media', 'draft_media_storage_key_idx')],
		['0013_sessions_security.sql', all(col('sessions', 'pwd_fp'), col('sessions', 'last_seen_at'))],
		['0014_notification_digest.sql', tables.has('notification_state')],
		['0015_draft_selected_connections.sql', col('drafts', 'selected_connection_ids')],
		['0016_mfa_challenges_expires_idx.sql', idx('mfa_challenges', 'mfa_challenges_expires_idx')],
		['0017_app_settings.sql', tables.has('app_settings')],
		['0018_draft_media_meta.sql', col('draft_media', 'meta_json')],
		['0019_draft_shares.sql', tables.has('draft_shares')]
	]
		.filter(([, ok]) => ok)
		.map(([name]) => String(name));
}

/** One statement instead of one round trip per migration.
 *  @param {string[]} names */
export function insertMigrationsSql(names) {
	const values = names.map((name) => `('${name.replace(/'/g, "''")}')`).join(', ');
	return `INSERT INTO d1_migrations (name) VALUES ${values}`;
}

/**
 * @param {object} io
 * @param {(sql: string) => Promise<unknown>} io.exec   run a statement, ignore rows
 * @param {(sql: string) => Promise<Array<Record<string, unknown>>>} io.query
 * @param {(line: string) => void} [io.log]
 * @returns {Promise<{ recorded: string[] }>}
 */
export async function syncMigrations({ exec, query, log = () => {} }) {
	await exec(D1_MIGRATIONS_DDL);
	const rows = await query(INTROSPECTION_SQL);
	const state = readState(rows[0]);
	const satisfied = satisfiedMigrations(state);
	const missing = satisfied.filter((name) => !state.applied.has(name));
	if (!missing.length) return { recorded: [] };
	await exec(insertMigrationsSql(missing));
	for (const name of missing) log(`  already present, recording as applied: ${name}`);
	return { recorded: missing };
}

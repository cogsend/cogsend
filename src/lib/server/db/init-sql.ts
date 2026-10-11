import { fnv1a } from '#lib/domain/hash.js';
import { rawBinding } from '../budget';

/** Bootstrap DDL for first request. Squashed to latest: 0001 + 0002 + 0004-final + 0005 + 0007 + 0008 + 0009 + 0010 + 0012 + 0014 + 0015 + 0016 + 0017 (+ 0003 transient). Keep in lockstep with drizzle/*.sql; `tests/schema-bootstrap.test.ts` fails when an index a migration creates is missing here. */
export const INIT_SQL = `
CREATE TABLE IF NOT EXISTS \`users\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`email\` text NOT NULL,
	\`password_hash\` text NOT NULL,
	\`timezone\` text NOT NULL DEFAULT 'UTC',
	\`created_at\` integer NOT NULL,
	\`updated_at\` integer NOT NULL,
	\`totp_enabled\` integer NOT NULL DEFAULT 0,
	\`totp_secret_enc\` text,
	\`totp_enrolled_at\` integer,
	\`totp_last_step\` integer,
	\`settings_json\` text,
	\`display_name\` text
);
CREATE UNIQUE INDEX IF NOT EXISTS \`users_email_uq\` ON \`users\` (\`email\`);

CREATE TABLE IF NOT EXISTS \`sessions\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`token\` text NOT NULL,
	\`user_id\` text NOT NULL,
	\`expires_at\` integer NOT NULL,
	\`remember\` integer NOT NULL DEFAULT 1,
	\`mfa_verified\` integer NOT NULL DEFAULT 0,
	\`created_at\` integer NOT NULL,
	\`pwd_fp\` text,
	\`last_seen_at\` integer,
	FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS \`sessions_token_uq\` ON \`sessions\` (\`token\`);
CREATE INDEX IF NOT EXISTS \`sessions_user_idx\` ON \`sessions\` (\`user_id\`);
CREATE INDEX IF NOT EXISTS \`sessions_expires_idx\` ON \`sessions\` (\`expires_at\`);

CREATE TABLE IF NOT EXISTS \`oauth_pending\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`user_id\` text NOT NULL REFERENCES \`users\`(\`id\`) ON DELETE CASCADE,
	\`instance_url\` text NOT NULL,
	\`client_id\` text NOT NULL,
	\`client_secret_enc\` text NOT NULL,
	\`expires_at\` integer NOT NULL,
	\`created_at\` integer NOT NULL
);
CREATE INDEX IF NOT EXISTS \`oauth_pending_expires_idx\` ON \`oauth_pending\` (\`expires_at\`);
CREATE INDEX IF NOT EXISTS \`oauth_pending_user_idx\` ON \`oauth_pending\` (\`user_id\`);

CREATE TABLE IF NOT EXISTS \`connections\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`user_id\` text NOT NULL,
	\`platform\` text NOT NULL,
	\`display_name\` text,
	\`handle\` text,
	\`avatar_url\` text,
	\`instance_url\` text,
	\`credentials_encrypted\` text NOT NULL,
	\`meta_json\` text NOT NULL DEFAULT '{}',
	\`status\` text NOT NULL DEFAULT 'active',
	\`created_at\` integer NOT NULL,
	\`updated_at\` integer NOT NULL,
	FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS \`connections_user_platform_idx\` ON \`connections\` (\`user_id\`, \`platform\`);
CREATE INDEX IF NOT EXISTS \`connections_user_status_idx\` ON \`connections\` (\`user_id\`, \`status\`);
CREATE INDEX IF NOT EXISTS \`connections_user_created_idx\` ON \`connections\` (\`user_id\`, \`created_at\`);

CREATE TABLE IF NOT EXISTS \`drafts\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`user_id\` text NOT NULL,
	\`title\` text,
	\`base_body\` text NOT NULL DEFAULT '',
	\`selected_connection_ids\` text,
	\`status\` text NOT NULL DEFAULT 'draft',
	\`created_at\` integer NOT NULL,
	\`updated_at\` integer NOT NULL,
	FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS \`drafts_user_status_idx\` ON \`drafts\` (\`user_id\`, \`status\`);
CREATE INDEX IF NOT EXISTS \`drafts_user_updated_idx\` ON \`drafts\` (\`user_id\`, \`updated_at\`);

CREATE TABLE IF NOT EXISTS \`draft_variants\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`draft_id\` text NOT NULL,
	\`platform\` text NOT NULL,
	\`body\` text,
	\`options_json\` text NOT NULL DEFAULT '{}',
	\`created_at\` integer NOT NULL,
	\`updated_at\` integer NOT NULL,
	FOREIGN KEY (\`draft_id\`) REFERENCES \`drafts\`(\`id\`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS \`draft_variants_draft_platform_uq\` ON \`draft_variants\` (\`draft_id\`, \`platform\`);

CREATE TABLE IF NOT EXISTS \`draft_media\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`draft_id\` text NOT NULL,
	\`storage_key\` text NOT NULL,
	\`mime\` text NOT NULL,
	\`size\` integer NOT NULL,
	\`width\` integer,
	\`height\` integer,
	\`alt_text\` text,
	\`sort_order\` integer NOT NULL DEFAULT 0,
	\`segment_index\` integer NOT NULL DEFAULT 0,
	\`created_at\` integer NOT NULL,
	FOREIGN KEY (\`draft_id\`) REFERENCES \`drafts\`(\`id\`) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS \`draft_media_draft_idx\` ON \`draft_media\` (\`draft_id\`);
CREATE INDEX IF NOT EXISTS \`draft_media_draft_segment_idx\` ON \`draft_media\` (\`draft_id\`, \`segment_index\`);
CREATE INDEX IF NOT EXISTS \`draft_media_storage_key_idx\` ON \`draft_media\` (\`storage_key\`);

CREATE TABLE IF NOT EXISTS \`publish_targets\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`draft_id\` text NOT NULL,
	\`connection_id\` text NOT NULL,
	\`variant_id\` text,
	\`status\` text NOT NULL DEFAULT 'pending',
	\`scheduled_for\` integer,
	\`remote_post_id\` text,
	\`remote_url\` text,
	\`error_message\` text,
	\`attempt_count\` integer NOT NULL DEFAULT 0,
	\`job_id\` text,
	\`created_at\` integer NOT NULL,
	\`updated_at\` integer NOT NULL,
	FOREIGN KEY (\`draft_id\`) REFERENCES \`drafts\`(\`id\`) ON DELETE CASCADE,
	FOREIGN KEY (\`connection_id\`) REFERENCES \`connections\`(\`id\`) ON DELETE CASCADE,
	FOREIGN KEY (\`variant_id\`) REFERENCES \`draft_variants\`(\`id\`) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS \`publish_targets_status_when_idx\` ON \`publish_targets\` (\`status\`, \`scheduled_for\`);
CREATE INDEX IF NOT EXISTS \`publish_targets_status_updated_idx\` ON \`publish_targets\` (\`status\`, \`updated_at\`);
CREATE INDEX IF NOT EXISTS \`publish_targets_draft_idx\` ON \`publish_targets\` (\`draft_id\`);
CREATE INDEX IF NOT EXISTS \`publish_targets_conn_status_idx\` ON \`publish_targets\` (\`connection_id\`, \`status\`, \`scheduled_for\`);
CREATE UNIQUE INDEX IF NOT EXISTS \`publish_targets_draft_conn_idx\` ON \`publish_targets\` (\`draft_id\`, \`connection_id\`);

CREATE TABLE IF NOT EXISTS \`publish_attempts\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`publish_target_id\` text NOT NULL,
	\`started_at\` integer NOT NULL,
	\`finished_at\` integer,
	\`success\` integer NOT NULL DEFAULT 0,
	\`error\` text,
	\`response_summary\` text,
	FOREIGN KEY (\`publish_target_id\`) REFERENCES \`publish_targets\`(\`id\`) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS \`publish_attempts_target_idx\` ON \`publish_attempts\` (\`publish_target_id\`);

CREATE TABLE IF NOT EXISTS \`scheduler_heartbeats\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`last_ok_at\` integer NOT NULL
);

CREATE TABLE IF NOT EXISTS \`notification_state\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`last_failure_digest_at\` integer
);

CREATE TABLE IF NOT EXISTS \`app_settings\` (
	\`key\` text PRIMARY KEY NOT NULL,
	\`value\` text NOT NULL,
	\`updated_at\` integer NOT NULL
);

CREATE TABLE IF NOT EXISTS \`totp_backup_codes\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`user_id\` text NOT NULL,
	\`code_hash\` text NOT NULL,
	\`used_at\` integer,
	\`created_at\` integer NOT NULL,
	FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS \`totp_backup_user_idx\` ON \`totp_backup_codes\` (\`user_id\`);

CREATE TABLE IF NOT EXISTS \`mfa_challenges\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`user_id\` text NOT NULL,
	\`token_hash\` text NOT NULL,
	\`kind\` text NOT NULL,
	\`secret_enc\` text,
	\`backup_codes_enc\` text,
	\`remember\` integer NOT NULL DEFAULT 1,
	\`failed_attempts\` integer NOT NULL DEFAULT 0,
	\`expires_at\` integer NOT NULL,
	\`created_at\` integer NOT NULL,
	FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS \`mfa_challenges_token_uq\` ON \`mfa_challenges\` (\`token_hash\`);
CREATE INDEX IF NOT EXISTS \`mfa_challenges_user_idx\` ON \`mfa_challenges\` (\`user_id\`);
CREATE INDEX IF NOT EXISTS \`mfa_challenges_expires_idx\` ON \`mfa_challenges\` (\`expires_at\`);

CREATE TABLE IF NOT EXISTS \`api_keys\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`user_id\` text NOT NULL,
	\`key_hash\` text NOT NULL,
	\`prefix\` text NOT NULL,
	\`scopes\` text,
	\`created_at\` integer NOT NULL,
	\`last_used_at\` integer,
	\`revoked_at\` integer,
	FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS \`api_keys_hash_uq\` ON \`api_keys\` (\`key_hash\`);
CREATE INDEX IF NOT EXISTS \`api_keys_user_idx\` ON \`api_keys\` (\`user_id\`);
`;

async function execStatements(d1: D1Database, sql: string) {
	const statements = sql
		.split(';')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	for (const statement of statements) {
		await d1.prepare(statement).run();
	}
}

/**
 * Indexes a migration added after the first release's bootstrap DDL. A database
 * bootstrapped by an older INIT_SQL never runs the migration that creates them
 * (`ensureSchema` is the only schema step such a database takes), so they are
 * recreated here, idempotently, on the first request in each new isolate.
 * 0009's and 0011's indexes predate the release and are listed for the same
 * reason: cheap, and it keeps one list rather than a comment about which is
 * which. 0012's index was already in the first release's DDL.
 */
const BACKFILL_INDEXES = [
	'CREATE INDEX IF NOT EXISTS publish_targets_conn_status_idx ON publish_targets (connection_id, status, scheduled_for)',
	'CREATE INDEX IF NOT EXISTS drafts_user_updated_idx ON drafts (user_id, updated_at)',
	'CREATE INDEX IF NOT EXISTS connections_user_status_idx ON connections (user_id, status)',
	'CREATE INDEX IF NOT EXISTS connections_user_created_idx ON connections (user_id, created_at)',
	'CREATE INDEX IF NOT EXISTS publish_targets_status_updated_idx ON publish_targets (status, updated_at)',
	'CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at)',
	'CREATE INDEX IF NOT EXISTS mfa_challenges_expires_idx ON mfa_challenges (expires_at)'
];

async function tableColumns(d1: D1Database, table: string): Promise<Set<string>> {
	const res = await d1.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
	return new Set((res.results ?? []).map((r) => r.name));
}

/** One `table_info` per table, then only the columns that are actually missing. */
async function addMissingColumns(
	d1: D1Database,
	table: string,
	columns: { name: string; ddl: string }[]
) {
	const cols = await tableColumns(d1, table);
	// No rows means the table is not there yet. The CREATE that follows builds
	// it with these columns, so an ALTER here would only fail.
	if (cols.size === 0) return;
	for (const column of columns) {
		if (cols.has(column.name)) continue;
		await d1.prepare(`ALTER TABLE ${table} ADD COLUMN ${column.ddl}`).run();
	}
}

// Memoized per binding: Workers isolates reuse the same D1 binding across
// requests, so the (idempotent) schema check runs once per isolate. A fresh
// binding (tests, new deployment) is ensured again. Failures are not cached.
const ensuredBindings = new WeakMap<object, Promise<void>>();

export function ensureSchemaOnce(d1: D1Database): Promise<void> {
	// Keyed on the real binding: each request hands in its own counting
	// wrapper around it (see #lib/server/budget).
	const key = rawBinding(d1);
	const existing = ensuredBindings.get(key);
	if (existing) return existing;
	const run = ensureSchema(d1).catch((err) => {
		ensuredBindings.delete(key);
		throw err;
	});
	ensuredBindings.set(key, run);
	return run;
}

/**
 * Columns a migration added after the first release's bootstrap DDL, added
 * here too for databases that bootstrapped before them.
 */
const COLUMN_BACKFILLS: Array<{ table: string; columns: { name: string; ddl: string }[] }> = [
	{
		table: 'users',
		columns: [
			{ name: 'totp_enabled', ddl: 'totp_enabled integer NOT NULL DEFAULT 0' },
			{ name: 'totp_secret_enc', ddl: 'totp_secret_enc text' },
			{ name: 'totp_enrolled_at', ddl: 'totp_enrolled_at integer' },
			{ name: 'totp_last_step', ddl: 'totp_last_step integer' },
			{ name: 'settings_json', ddl: 'settings_json text' },
			{ name: 'display_name', ddl: 'display_name text' }
		]
	},
	{
		table: 'drafts',
		columns: [{ name: 'selected_connection_ids', ddl: 'selected_connection_ids text' }]
	},
	{ table: 'api_keys', columns: [{ name: 'scopes', ddl: 'scopes text' }] },
	{
		table: 'sessions',
		columns: [{ name: 'mfa_verified', ddl: 'mfa_verified integer NOT NULL DEFAULT 0' }]
	}
];

/** Tables a database bootstrapped by an older release may be missing. */
const LEGACY_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS totp_backup_codes (
	id text PRIMARY KEY NOT NULL,
	user_id text NOT NULL,
	code_hash text NOT NULL,
	used_at integer,
	created_at integer NOT NULL,
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS totp_backup_user_idx ON totp_backup_codes (user_id);
CREATE TABLE IF NOT EXISTS mfa_challenges (
	id text PRIMARY KEY NOT NULL,
	user_id text NOT NULL,
	token_hash text NOT NULL,
	kind text NOT NULL,
	secret_enc text,
	backup_codes_enc text,
	remember integer NOT NULL DEFAULT 1,
	failed_attempts integer NOT NULL DEFAULT 0,
	expires_at integer NOT NULL,
	created_at integer NOT NULL,
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS notification_state (
	id text PRIMARY KEY NOT NULL,
	last_failure_digest_at integer
);
CREATE TABLE IF NOT EXISTS app_settings (
	key text PRIMARY KEY NOT NULL,
	value text NOT NULL,
	updated_at integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS mfa_challenges_token_uq ON mfa_challenges (token_hash);
CREATE INDEX IF NOT EXISTS mfa_challenges_user_idx ON mfa_challenges (user_id);
CREATE TABLE IF NOT EXISTS api_keys (
	id text PRIMARY KEY NOT NULL,
	user_id text NOT NULL,
	key_hash text NOT NULL,
	prefix text NOT NULL,
	scopes text,
	created_at integer NOT NULL,
	last_used_at integer,
	revoked_at integer,
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash_uq ON api_keys (key_hash);
CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys (user_id);
`;

/**
 * Which bootstrap a database has had, stored in `app_settings`. Checking it is
 * one query; the full check below is two dozen, and on the Workers Free plan
 * every one of them comes out of the same 50-call budget a publish needs.
 */
export const SCHEMA_MARKER_KEY = 'schema_bootstrap';

/**
 * Derived from the DDL itself, so any change to the bootstrap (a new table,
 * column or index) makes every database take the full path once more. The
 * trailing label names the one step that is code rather than DDL.
 */
export const SCHEMA_FINGERPRINT = fnv1a(
	[
		INIT_SQL,
		LEGACY_TABLES_SQL,
		JSON.stringify(COLUMN_BACKFILLS),
		BACKFILL_INDEXES.join('\n'),
		'publish_targets_draft_conn_idx:unique'
	].join('\n--\n')
).toString(16);

async function schemaIsCurrent(d1: D1Database): Promise<boolean> {
	try {
		const row = await d1
			.prepare('SELECT value FROM app_settings WHERE key = ?')
			.bind(SCHEMA_MARKER_KEY)
			.first<{ value: string }>();
		return row?.value === SCHEMA_FINGERPRINT;
	} catch {
		// No app_settings table yet: an older or empty database.
		return false;
	}
}

async function recordSchema(d1: D1Database) {
	try {
		await d1
			.prepare(
				'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ' +
					'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
			)
			.bind(SCHEMA_MARKER_KEY, SCHEMA_FINGERPRINT, Date.now())
			.run();
	} catch {
		// Only an optimisation: without the marker the next isolate runs the
		// full (idempotent) check again.
	}
}

export async function ensureSchema(d1: D1Database) {
	// Best-effort FK enforcement: D1/SQLite defaults foreign_keys OFF per
	// connection. Tests enable it explicitly; prod must too or ON DELETE
	// CASCADE silently no-ops. Failure is non-fatal (some drivers reject PRAGMA).
	try {
		await d1.exec('PRAGMA foreign_keys = ON');
	} catch {
		// ignore; enforcement depends on engine default
	}
	if (await schemaIsCurrent(d1)) return;
	const row = await d1
		.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
		.first();
	if (!row) {
		await execStatements(d1, INIT_SQL);
		await recordSchema(d1);
		return;
	}
	for (const { table, columns } of COLUMN_BACKFILLS) {
		await addMissingColumns(d1, table, columns);
	}
	await execStatements(d1, LEGACY_TABLES_SQL);
	await ensureDraftConnUnique(d1);
	for (const ddl of BACKFILL_INDEXES) {
		await d1.prepare(ddl).run();
	}
	await recordSchema(d1);
}

async function ensureDraftConnUnique(d1: D1Database) {
	const listed = await d1
		.prepare('PRAGMA index_list(publish_targets)')
		.all<{ name: string; unique: number }>();
	const existing = (listed.results ?? []).find(
		(row) => row.name === 'publish_targets_draft_conn_idx'
	);
	if (existing?.unique) return;

	await d1
		.prepare(
			`DELETE FROM publish_targets
			WHERE id NOT IN (
				SELECT id FROM (
					SELECT id,
						ROW_NUMBER() OVER (
							PARTITION BY draft_id, connection_id
							ORDER BY
								CASE WHEN remote_post_id IS NOT NULL THEN 0 ELSE 1 END,
								updated_at DESC,
								id DESC
						) AS rn
					FROM publish_targets
				) AS ranked
				WHERE rn = 1
			)`
		)
		.run();
	await d1.prepare('DROP INDEX IF EXISTS publish_targets_draft_conn_idx').run();
	await d1
		.prepare(
			'CREATE UNIQUE INDEX IF NOT EXISTS publish_targets_draft_conn_idx ON publish_targets (draft_id, connection_id)'
		)
		.run();
}

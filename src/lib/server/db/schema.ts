import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable(
	'users',
	{
		id: text('id').primaryKey(),
		email: text('email').notNull(),
		passwordHash: text('password_hash').notNull(),
		displayName: text('display_name'),
		timezone: text('timezone').notNull().default('UTC'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
		totpEnabled: integer('totp_enabled', { mode: 'boolean' }).notNull().default(false),
		totpSecretEnc: text('totp_secret_enc'),
		totpEnrolledAt: integer('totp_enrolled_at', { mode: 'timestamp_ms' }),
		totpLastStep: integer('totp_last_step'),
		settingsJson: text('settings_json')
	},
	// Explicit name matches drizzle/0001_init.sql + init-sql.ts (users_email_uq).
	// Inline .unique() generates a different auto name and drifts tooling diffs.
	(t) => [uniqueIndex('users_email_uq').on(t.email)]
);

export const sessions = sqliteTable(
	'sessions',
	{
		id: text('id').primaryKey(),
		token: text('token').notNull(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
		remember: integer('remember', { mode: 'boolean' }).notNull().default(true),
		mfaVerified: integer('mfa_verified', { mode: 'boolean' }).notNull().default(false),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		pwdFp: text('pwd_fp'),
		lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' })
	},
	(t) => [
		uniqueIndex('sessions_token_uq').on(t.token),
		index('sessions_user_idx').on(t.userId),
		index('sessions_expires_idx').on(t.expiresAt)
	]
);

export const oauthPending = sqliteTable(
	'oauth_pending',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		instanceUrl: text('instance_url').notNull(),
		clientId: text('client_id').notNull(),
		clientSecretEnc: text('client_secret_enc').notNull(),
		expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [
		index('oauth_pending_expires_idx').on(t.expiresAt),
		index('oauth_pending_user_idx').on(t.userId)
	]
);

export const connections = sqliteTable(
	'connections',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		platform: text('platform').notNull(),
		displayName: text('display_name'),
		handle: text('handle'),
		avatarUrl: text('avatar_url'),
		instanceUrl: text('instance_url'),
		credentialsEncrypted: text('credentials_encrypted').notNull(),
		metaJson: text('meta_json').notNull().default('{}'),
		status: text('status').notNull().default('active'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [
		index('connections_user_platform_idx').on(t.userId, t.platform),
		index('connections_user_status_idx').on(t.userId, t.status),
		index('connections_user_created_idx').on(t.userId, t.createdAt)
	]
);

export const drafts = sqliteTable(
	'drafts',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		title: text('title'),
		baseBody: text('base_body').notNull().default(''),
		// JSON array of the connection ids the composer had selected. NULL
		// means "never saved" (fall back to publish targets / defaults); an
		// empty array is an explicit "no accounts" selection.
		selectedConnectionIds: text('selected_connection_ids'),
		status: text('status').notNull().default('draft'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [
		index('drafts_user_status_idx').on(t.userId, t.status),
		index('drafts_user_updated_idx').on(t.userId, t.updatedAt)
	]
);

export const draftVariants = sqliteTable(
	'draft_variants',
	{
		id: text('id').primaryKey(),
		draftId: text('draft_id')
			.notNull()
			.references(() => drafts.id, { onDelete: 'cascade' }),
		platform: text('platform').notNull(),
		body: text('body'),
		optionsJson: text('options_json').notNull().default('{}'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [uniqueIndex('draft_variants_draft_platform_uq').on(t.draftId, t.platform)]
);

export const draftMedia = sqliteTable(
	'draft_media',
	{
		id: text('id').primaryKey(),
		draftId: text('draft_id')
			.notNull()
			.references(() => drafts.id, { onDelete: 'cascade' }),
		storageKey: text('storage_key').notNull(),
		mime: text('mime').notNull(),
		size: integer('size').notNull(),
		width: integer('width'),
		height: integer('height'),
		altText: text('alt_text'),
		sortOrder: integer('sort_order').notNull().default(0),
		segmentIndex: integer('segment_index').notNull().default(0),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [
		index('draft_media_draft_idx').on(t.draftId),
		index('draft_media_draft_segment_idx').on(t.draftId, t.segmentIndex),
		index('draft_media_storage_key_idx').on(t.storageKey)
	]
);

export const publishTargets = sqliteTable(
	'publish_targets',
	{
		id: text('id').primaryKey(),
		draftId: text('draft_id')
			.notNull()
			.references(() => drafts.id, { onDelete: 'cascade' }),
		connectionId: text('connection_id')
			.notNull()
			.references(() => connections.id, { onDelete: 'cascade' }),
		variantId: text('variant_id').references(() => draftVariants.id, { onDelete: 'set null' }),
		status: text('status').notNull().default('pending'),
		scheduledFor: integer('scheduled_for', { mode: 'timestamp_ms' }),
		remotePostId: text('remote_post_id'),
		remoteUrl: text('remote_url'),
		errorMessage: text('error_message'),
		attemptCount: integer('attempt_count').notNull().default(0),
		jobId: text('job_id'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [
		index('publish_targets_status_when_idx').on(t.status, t.scheduledFor),
		index('publish_targets_status_updated_idx').on(t.status, t.updatedAt),
		index('publish_targets_draft_idx').on(t.draftId),
		index('publish_targets_conn_status_idx').on(t.connectionId, t.status, t.scheduledFor),
		uniqueIndex('publish_targets_draft_conn_idx').on(t.draftId, t.connectionId)
	]
);

export const publishAttempts = sqliteTable(
	'publish_attempts',
	{
		id: text('id').primaryKey(),
		publishTargetId: text('publish_target_id')
			.notNull()
			.references(() => publishTargets.id, { onDelete: 'cascade' }),
		startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
		finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
		success: integer('success', { mode: 'boolean' }).notNull().default(false),
		error: text('error'),
		responseSummary: text('response_summary')
	},
	(t) => [index('publish_attempts_target_idx').on(t.publishTargetId)]
);

export const schedulerHeartbeats = sqliteTable('scheduler_heartbeats', {
	id: text('id').primaryKey(),
	lastOkAt: integer('last_ok_at', { mode: 'timestamp_ms' }).notNull()
});

export const totpBackupCodes = sqliteTable(
	'totp_backup_codes',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		codeHash: text('code_hash').notNull(),
		usedAt: integer('used_at', { mode: 'timestamp_ms' }),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [index('totp_backup_user_idx').on(t.userId)]
);

export const apiKeys = sqliteTable(
	'api_keys',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		keyHash: text('key_hash').notNull(),
		prefix: text('prefix').notNull(),
		scopes: text('scopes'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
		revokedAt: integer('revoked_at', { mode: 'timestamp_ms' })
	},
	(t) => [uniqueIndex('api_keys_hash_uq').on(t.keyHash), index('api_keys_user_idx').on(t.userId)]
);

export const mfaChallenges = sqliteTable(
	'mfa_challenges',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		tokenHash: text('token_hash').notNull(),
		kind: text('kind').notNull(),
		secretEnc: text('secret_enc'),
		backupCodesEnc: text('backup_codes_enc'),
		remember: integer('remember', { mode: 'boolean' }).notNull().default(true),
		failedAttempts: integer('failed_attempts').notNull().default(0),
		expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [
		uniqueIndex('mfa_challenges_token_uq').on(t.tokenHash),
		index('mfa_challenges_user_idx').on(t.userId),
		index('mfa_challenges_expires_idx').on(t.expiresAt)
	]
);

export const notificationState = sqliteTable('notification_state', {
	id: text('id').primaryKey(),
	lastFailureDigestAt: integer('last_failure_digest_at', { mode: 'timestamp_ms' })
});

/** Instance-level values discovered or set at runtime rather than configured —
 *  see drizzle/0017_app_settings.sql and the keys in #lib/server/app-settings. */
export const appSettings = sqliteTable('app_settings', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
});

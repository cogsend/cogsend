-- 0019: read-only preview links for drafts, one per draft. Only a hash of the
-- link's token is stored; the token itself is derived from the row id with a
-- key the database never sees, so the owner can be shown the same link again
-- without it being readable from a copy of the database.
CREATE TABLE IF NOT EXISTS `draft_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`draft_id` text NOT NULL REFERENCES `drafts`(`id`) ON DELETE CASCADE,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS `draft_shares_token_uq` ON `draft_shares` (`token_hash`);
CREATE UNIQUE INDEX IF NOT EXISTS `draft_shares_draft_uq` ON `draft_shares` (`draft_id`);

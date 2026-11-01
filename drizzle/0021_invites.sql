-- 0021: single-use, expiring invite links an admin hands out so somebody can
-- skip the waitlist. Only a hash of the code is stored, like API keys.
CREATE TABLE IF NOT EXISTS `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`note` text,
	`created_by` text REFERENCES `users`(`id`) ON DELETE SET NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`used_by` text REFERENCES `users`(`id`) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS `invites_code_uq` ON `invites` (`code_hash`);

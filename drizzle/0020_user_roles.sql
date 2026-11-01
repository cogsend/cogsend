-- 0020: roles and account states, for instances that opt into public
-- registration (REGISTRATION=waitlist|open). The defaults make every existing
-- row what it already was, the instance's one active admin, so a single-user
-- instance is unchanged; sign-up writes `member` and its status explicitly.
-- `last_login_at` feeds the admin's user list.
ALTER TABLE `users` ADD COLUMN `role` text NOT NULL DEFAULT 'admin';
ALTER TABLE `users` ADD COLUMN `status` text NOT NULL DEFAULT 'active';
ALTER TABLE `users` ADD COLUMN `last_login_at` integer;

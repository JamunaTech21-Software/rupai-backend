-- CreateTable
CREATE TABLE `auth_session` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `last_used_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `expires_at` DATETIME(0) NOT NULL,
    `revoked_at` DATETIME(0) NULL,
    `revoked_reason` VARCHAR(30) NULL,
    `ip_address` VARCHAR(45) NULL,
    `user_agent` VARCHAR(255) NULL,

    INDEX `ix_auth_session_user_revoked`(`user_id`, `revoked_at`),
    INDEX `ix_auth_session_expires`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `auth_refresh_token` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `session_id` BIGINT UNSIGNED NOT NULL,
    `token_hash` CHAR(64) NOT NULL,
    `issued_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `expires_at` DATETIME(0) NOT NULL,
    `used_at` DATETIME(0) NULL,

    INDEX `ix_auth_refresh_token_session`(`session_id`),
    UNIQUE INDEX `ux_auth_refresh_token_hash`(`token_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `password_reset_token` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `token_hash` CHAR(64) NOT NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `expires_at` DATETIME(0) NOT NULL,
    `used_at` DATETIME(0) NULL,
    `requested_ip` VARCHAR(45) NULL,

    INDEX `ix_password_reset_token_user`(`user_id`),
    UNIQUE INDEX `ux_password_reset_token_hash`(`token_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `auth_session` ADD CONSTRAINT `fk_auth_session_user` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `auth_refresh_token` ADD CONSTRAINT `fk_auth_refresh_token_session` FOREIGN KEY (`session_id`) REFERENCES `auth_session`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `password_reset_token` ADD CONSTRAINT `fk_password_reset_token_user` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- HAND-EDIT: CHECK constraints (prisma/README.md). A revoked session always says why.
ALTER TABLE `auth_session`
  ADD CONSTRAINT `ck_auth_session_revoked_reason` CHECK (`revoked_reason` IS NULL OR `revoked_reason` IN
    ('logout', 'logout_all', 'session_revoked', 'refresh_reuse', 'user_disabled', 'password_changed', 'password_reset')),
  ADD CONSTRAINT `ck_auth_session_revoked_pair` CHECK ((`revoked_at` IS NULL) = (`revoked_reason` IS NULL)),
  ADD CONSTRAINT `ck_auth_session_expiry` CHECK (`expires_at` > `created_at`);

ALTER TABLE `auth_refresh_token`
  ADD CONSTRAINT `ck_auth_refresh_token_hash` CHECK (`token_hash` REGEXP '^[0-9a-f]{64}$'),
  ADD CONSTRAINT `ck_auth_refresh_token_expiry` CHECK (`expires_at` > `issued_at`);

ALTER TABLE `password_reset_token`
  ADD CONSTRAINT `ck_password_reset_token_hash` CHECK (`token_hash` REGEXP '^[0-9a-f]{64}$'),
  ADD CONSTRAINT `ck_password_reset_token_expiry` CHECK (`expires_at` > `created_at`);

-- HAND-EDIT: per-table rights for the app account. Sessions and tokens are revoked or marked used,
-- never deleted by the application: they are the evidence of who was signed in when. Rows go only
-- with their user (FK cascade). Purging expired rows is a scheduled job's concern (P1.15).
GRANT UPDATE ON `auth_session` TO 'rupai_app'@'%';
GRANT UPDATE ON `auth_refresh_token` TO 'rupai_app'@'%';
GRANT UPDATE ON `password_reset_token` TO 'rupai_app'@'%';

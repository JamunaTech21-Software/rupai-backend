-- CreateTable
CREATE TABLE `user_scope` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `scope_type` VARCHAR(30) NOT NULL,
    `scope_id` BIGINT UNSIGNED NULL,
    -- HAND-EDIT: generated column so ux_user_scope also holds for all_estates/self, whose scope_id is
    -- NULL (MySQL lets NULLs repeat in a unique index). P3 §28.2 ux_user_scope (user_id, scope_type, scope_id).
    `scope_key` BIGINT UNSIGNED GENERATED ALWAYS AS (IFNULL(`scope_id`, 0)) STORED,
    `granted_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `granted_by` BIGINT UNSIGNED NOT NULL,
    `expires_at` DATETIME(0) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_user_scope_expires`(`expires_at`),
    INDEX `ix_user_scope_target`(`scope_type`, `scope_id`),
    INDEX `ix_user_scope_granted_by`(`granted_by`),
    INDEX `ix_user_scope_created_by`(`created_by`),
    INDEX `ix_user_scope_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_user_scope`(`user_id`, `scope_type`, `scope_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `user_scope` ADD CONSTRAINT `fk_user_scope_user` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `user_scope` ADD CONSTRAINT `fk_user_scope_granted_by` FOREIGN KEY (`granted_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `user_scope` ADD CONSTRAINT `fk_user_scope_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `user_scope` ADD CONSTRAINT `fk_user_scope_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- HAND-EDIT: CHECK constraints (prisma/README.md). all_estates and self name no target; every other
-- type names exactly one.
ALTER TABLE `user_scope`
  ADD CONSTRAINT `ck_user_scope_type` CHECK (`scope_type` IN
    ('all_estates', 'estate', 'division', 'section', 'department', 'facility', 'self')),
  ADD CONSTRAINT `ck_user_scope_target` CHECK ((`scope_type` IN ('all_estates', 'self')) = (`scope_id` IS NULL)),
  ADD CONSTRAINT `ck_user_scope_expiry` CHECK (`expires_at` IS NULL OR `expires_at` > `granted_at`),
  ADD CONSTRAINT `ck_user_scope_version` CHECK (`version` >= 1);

-- HAND-EDIT: per-table rights for the app account. Grants are edited (expiry) and removed; their
-- history is the audit log's (P1.05).
GRANT UPDATE, DELETE ON `user_scope` TO 'rupai_app'@'%';

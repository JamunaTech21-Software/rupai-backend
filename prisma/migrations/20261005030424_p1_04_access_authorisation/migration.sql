-- CreateTable
CREATE TABLE `access_authorisation` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `kind` VARCHAR(30) NOT NULL,
    `rule_code` VARCHAR(20) NOT NULL,
    `authorisation_key` VARCHAR(255) NOT NULL,
    `permissions` VARCHAR(500) NOT NULL,
    `reason` VARCHAR(1000) NOT NULL,
    `authorised_by` BIGINT UNSIGNED NOT NULL,
    `authorised_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `removed_at` DATETIME(0) NULL,
    `removed_by` BIGINT UNSIGNED NULL,
    -- HAND-EDIT: generated column so a user holds at most ONE active authorisation per key, while removed
    -- ones are kept as history (MySQL lets NULLs repeat in a unique index).
    `active_key` VARCHAR(255) GENERATED ALWAYS AS (CASE WHEN `removed_at` IS NULL THEN `authorisation_key` END) STORED,

    INDEX `ix_access_authorisation_kind`(`kind`, `removed_at`),
    INDEX `ix_access_authorisation_by`(`authorised_by`),
    INDEX `ix_access_authorisation_removed_by`(`removed_by`),
    UNIQUE INDEX `ux_access_authorisation_active`(`user_id`, `active_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `access_authorisation` ADD CONSTRAINT `fk_access_authorisation_user` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `access_authorisation` ADD CONSTRAINT `fk_access_authorisation_by` FOREIGN KEY (`authorised_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `access_authorisation` ADD CONSTRAINT `fk_access_authorisation_removed_by` FOREIGN KEY (`removed_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- HAND-EDIT: CHECK constraints (prisma/README.md). An authorisation always has a real reason (P6 §9.1),
-- and a removal always says who removed it.
ALTER TABLE `access_authorisation`
  ADD CONSTRAINT `ck_access_authorisation_kind` CHECK (`kind` IN ('sod_override', 'sensitive_grant')),
  ADD CONSTRAINT `ck_access_authorisation_rule` CHECK (
    (`kind` = 'sensitive_grant' AND `rule_code` = 'SENSITIVE') OR (`kind` = 'sod_override' AND `rule_code` REGEXP '^SOD-[0-9]+$')),
  ADD CONSTRAINT `ck_access_authorisation_reason` CHECK (CHAR_LENGTH(TRIM(`reason`)) >= 10),
  ADD CONSTRAINT `ck_access_authorisation_removed_pair` CHECK ((`removed_at` IS NULL) = (`removed_by` IS NULL));

-- HAND-EDIT: per-table rights for the app account. Authorisations are removed by marking them
-- (UPDATE), never deleted: the history is what an auditor asks for (P6 §9.2).
GRANT UPDATE ON `access_authorisation` TO 'rupai_app'@'%';

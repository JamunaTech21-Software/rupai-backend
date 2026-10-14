-- CreateTable
CREATE TABLE `number_format` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `document_type` VARCHAR(40) NOT NULL,
    `prefix` VARCHAR(20) NOT NULL,
    `include_fiscal_year` BOOLEAN NOT NULL DEFAULT false,
    `include_season` BOOLEAN NOT NULL DEFAULT false,
    `include_estate_code` BOOLEAN NOT NULL DEFAULT false,
    `separator` VARCHAR(5) NOT NULL DEFAULT '-',
    `sequence_width` SMALLINT NOT NULL DEFAULT 5,
    `reset_frequency` VARCHAR(30) NOT NULL DEFAULT 'never',
    `is_gapless` BOOLEAN NOT NULL DEFAULT false,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_number_format_created_by`(`created_by`),
    INDEX `ix_number_format_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_number_format_document_type`(`document_type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `number_sequence` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `document_type` VARCHAR(40) NOT NULL,
    `scope_key` VARCHAR(120) NOT NULL,
    `last_number` BIGINT UNSIGNED NOT NULL DEFAULT 0,
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `ux_number_sequence`(`document_type`, `scope_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `system_setting` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `setting_key` VARCHAR(100) NOT NULL,
    `setting_value` TEXT NULL,
    `value_type` VARCHAR(30) NOT NULL,
    `setting_group` VARCHAR(50) NOT NULL,
    `is_encrypted` BOOLEAN NOT NULL DEFAULT false,
    `description` VARCHAR(500) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_system_setting_group`(`setting_group`),
    INDEX `ix_system_setting_created_by`(`created_by`),
    INDEX `ix_system_setting_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_system_setting_key`(`setting_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `number_format` ADD CONSTRAINT `fk_number_format_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `number_format` ADD CONSTRAINT `fk_number_format_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `system_setting` ADD CONSTRAINT `fk_system_setting_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `system_setting` ADD CONSTRAINT `fk_system_setting_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- HAND-EDIT: CHECK constraints (prisma/README.md).
ALTER TABLE `number_format`
  ADD CONSTRAINT `ck_number_format_type` CHECK (`document_type` REGEXP '^[a-z][a-z0-9_]*$'),
  ADD CONSTRAINT `ck_number_format_prefix` CHECK (`prefix` REGEXP '^[A-Z0-9]{1,20}$'),
  ADD CONSTRAINT `ck_number_format_separator` CHECK (`separator` IN ('-', '/', '.', '')),
  ADD CONSTRAINT `ck_number_format_width` CHECK (`sequence_width` BETWEEN 3 AND 12),
  ADD CONSTRAINT `ck_number_format_reset` CHECK (`reset_frequency` IN ('never', 'yearly', 'monthly'));

ALTER TABLE `system_setting`
  ADD CONSTRAINT `ck_system_setting_key` CHECK (`setting_key` REGEXP '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$'),
  ADD CONSTRAINT `ck_system_setting_type` CHECK (`value_type` IN ('string', 'integer', 'decimal', 'boolean', 'json'));

-- HAND-EDIT: per-table rights for the app account. A number format is edited, never deleted (there is
-- one per document type). A sequence only ever counts up: UPDATE, no DELETE. Settings may be removed.
GRANT UPDATE ON `number_format` TO 'rupai_app'@'%';
GRANT UPDATE ON `number_sequence` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `system_setting` TO 'rupai_app'@'%';

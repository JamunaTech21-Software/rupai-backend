-- CreateTable
CREATE TABLE `document_file` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `owner_type` VARCHAR(50) NOT NULL,
    `owner_id` BIGINT UNSIGNED NOT NULL,
    `document_type_id` BIGINT UNSIGNED NOT NULL,
    `series_no` INTEGER NOT NULL DEFAULT 1,
    `title` VARCHAR(150) NULL,
    `file_name` VARCHAR(200) NOT NULL,
    `stored_path` VARCHAR(255) NOT NULL,
    `mime_type` VARCHAR(100) NOT NULL,
    `file_size_bytes` INTEGER UNSIGNED NOT NULL,
    `checksum` VARCHAR(64) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `issue_date` DATE NULL,
    `expiry_date` DATE NULL,
    `is_current` BOOLEAN NOT NULL DEFAULT true,
    `uploaded_by` BIGINT UNSIGNED NOT NULL,
    `status` VARCHAR(30) NOT NULL DEFAULT 'active',
    -- HAND-EDIT: generated: the series (owner, type, series_no) while this row is its current version, else
    -- NULL. Its unique index makes "one current version per document" a database guarantee.
    `current_key` VARCHAR(120) GENERATED ALWAYS AS (CASE WHEN `is_current` = 1 THEN CONCAT(`owner_type`, ':', `owner_id`, ':', `document_type_id`, ':', `series_no`) END) STORED,
    `row_version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_document_expiry`(`expiry_date`, `is_current`),
    INDEX `ix_document_file_type`(`document_type_id`),
    INDEX `ix_document_file_uploaded_by`(`uploaded_by`),
    INDEX `ix_document_file_created_by`(`created_by`),
    INDEX `ix_document_file_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_document_version`(`owner_type`, `owner_id`, `document_type_id`, `series_no`, `version`),
    UNIQUE INDEX `ux_document_current`(`current_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `document_file` ADD CONSTRAINT `fk_document_file_type` FOREIGN KEY (`document_type_id`) REFERENCES `document_type`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `document_file` ADD CONSTRAINT `fk_document_file_uploaded_by` FOREIGN KEY (`uploaded_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `document_file` ADD CONSTRAINT `fk_document_file_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `document_file` ADD CONSTRAINT `fk_document_file_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- HAND-EDIT: CHECK constraints (prisma/README.md).
ALTER TABLE `document_file`
  ADD CONSTRAINT `ck_document_file_owner_type` CHECK (`owner_type` REGEXP '^[a-z][a-z0-9_]*$'),
  ADD CONSTRAINT `ck_document_file_status` CHECK (`status` IN ('active', 'superseded', 'archived')),
  -- The current version is the active one; a superseded or archived row is never current.
  ADD CONSTRAINT `ck_document_file_current` CHECK ((`is_current` = 1) = (`status` = 'active')),
  ADD CONSTRAINT `ck_document_file_numbers` CHECK (`series_no` >= 1 AND `version` >= 1 AND `file_size_bytes` > 0),
  ADD CONSTRAINT `ck_document_file_checksum` CHECK (`checksum` IS NULL OR `checksum` REGEXP '^[0-9a-f]{64}$'),
  -- A relative storage key: never absolute, never climbing out of the storage root (P2 §6.2).
  ADD CONSTRAINT `ck_document_file_path` CHECK (`stored_path` REGEXP '^[a-z0-9]+(/[A-Za-z0-9]+)+$'),
  ADD CONSTRAINT `ck_document_file_dates` CHECK (`issue_date` IS NULL OR `expiry_date` IS NULL OR `expiry_date` >= `issue_date`);

-- HAND-EDIT: per-table rights for the app account. A document row is superseded or archived, never
-- deleted: the file and its history are retained (P4 §6.6). UPDATE, no DELETE.
GRANT UPDATE ON `document_file` TO 'rupai_app'@'%';

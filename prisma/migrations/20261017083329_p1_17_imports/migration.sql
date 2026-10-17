-- CreateTable
CREATE TABLE `import_batch` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `import_type` VARCHAR(60) NOT NULL,
    `state` VARCHAR(20) NOT NULL DEFAULT 'validating',
    `file_name` VARCHAR(255) NOT NULL,
    `file_format` VARCHAR(10) NOT NULL,
    `file_key` VARCHAR(100) NULL,
    `file_sha256` CHAR(64) NOT NULL,
    `file_size` INTEGER NOT NULL,
    `row_count` INTEGER NOT NULL DEFAULT 0,
    `valid_count` INTEGER NOT NULL DEFAULT 0,
    `error_count` INTEGER NOT NULL DEFAULT 0,
    `committed_count` INTEGER NOT NULL DEFAULT 0,
    `failed_count` INTEGER NOT NULL DEFAULT 0,
    `problems` JSON NULL,
    `validate_job_id` BIGINT UNSIGNED NULL,
    `commit_job_id` BIGINT UNSIGNED NULL,
    `validated_at` DATETIME(0) NULL,
    `committed_at` DATETIME(0) NULL,
    `cancelled_at` DATETIME(0) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_import_batch_type`(`import_type`, `created_at`),
    INDEX `ix_import_batch_state`(`state`),
    INDEX `ix_import_batch_created_by`(`created_by`, `created_at`),
    INDEX `ix_import_batch_updated_by`(`updated_by`),
    INDEX `ix_import_batch_validate_job`(`validate_job_id`),
    INDEX `ix_import_batch_commit_job`(`commit_job_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `import_row` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `import_batch_id` BIGINT UNSIGNED NOT NULL,
    `row_number` INTEGER NOT NULL,
    `data` JSON NOT NULL,
    `state` VARCHAR(20) NOT NULL,
    `errors` JSON NULL,
    `target_id` VARCHAR(26) NULL,
    `committed_at` DATETIME(0) NULL,

    INDEX `ix_import_row_state`(`import_batch_id`, `state`),
    UNIQUE INDEX `ux_import_row`(`import_batch_id`, `row_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `import_batch` ADD CONSTRAINT `fk_import_batch_validate_job` FOREIGN KEY (`validate_job_id`) REFERENCES `job`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `import_batch` ADD CONSTRAINT `fk_import_batch_commit_job` FOREIGN KEY (`commit_job_id`) REFERENCES `job`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `import_batch` ADD CONSTRAINT `fk_import_batch_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `import_batch` ADD CONSTRAINT `fk_import_batch_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `import_row` ADD CONSTRAINT `fk_import_row_batch` FOREIGN KEY (`import_batch_id`) REFERENCES `import_batch`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- HAND-EDIT: CHECK constraints (prisma/README.md).
ALTER TABLE `import_batch`
  ADD CONSTRAINT `ck_import_batch_state` CHECK (`state` IN
    ('validating', 'validated', 'rejected', 'committing', 'committed', 'cancelled')),
  ADD CONSTRAINT `ck_import_batch_format` CHECK (`file_format` IN ('xlsx', 'csv')),
  ADD CONSTRAINT `ck_import_batch_counts` CHECK (
    `row_count` >= 0 AND `valid_count` >= 0 AND `error_count` >= 0 AND `committed_count` >= 0
    AND `failed_count` >= 0 AND `valid_count` + `error_count` <= `row_count`
    AND `committed_count` + `failed_count` <= `valid_count`);
ALTER TABLE `import_row`
  ADD CONSTRAINT `ck_import_row_state` CHECK (`state` IN ('valid', 'invalid', 'committed', 'failed')),
  ADD CONSTRAINT `ck_import_row_number` CHECK (`row_number` >= 2);

-- HAND-EDIT: per-table rights for the app account. A batch moves through its states (UPDATE). Rows are
-- marked as they commit (UPDATE); cancelling a batch discards its staging rows (DELETE). A committed
-- batch keeps its rows: nothing deletes them.
GRANT UPDATE ON `import_batch` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `import_row` TO 'rupai_app'@'%';

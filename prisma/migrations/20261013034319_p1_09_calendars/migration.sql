-- CreateTable
CREATE TABLE `season` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `estate_id` BIGINT UNSIGNED NOT NULL,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `start_date` DATE NOT NULL,
    `end_date` DATE NOT NULL,
    `state` VARCHAR(30) NOT NULL DEFAULT 'planned',
    `closed_at` DATETIME(0) NULL,
    `closed_by` BIGINT UNSIGNED NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_season_dates`(`estate_id`, `start_date`, `end_date`),
    INDEX `ix_season_state`(`state`),
    INDEX `ix_season_closed_by`(`closed_by`),
    INDEX `ix_season_created_by`(`created_by`),
    INDEX `ix_season_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_season_code`(`estate_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `fiscal_year` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `organisation_id` BIGINT UNSIGNED NOT NULL,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `start_date` DATE NOT NULL,
    `end_date` DATE NOT NULL,
    `state` VARCHAR(30) NOT NULL DEFAULT 'future',
    `closed_at` DATETIME(0) NULL,
    `closed_by` BIGINT UNSIGNED NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_fiscal_year_dates`(`start_date`, `end_date`),
    INDEX `ix_fiscal_year_state`(`state`),
    INDEX `ix_fiscal_year_closed_by`(`closed_by`),
    INDEX `ix_fiscal_year_created_by`(`created_by`),
    INDEX `ix_fiscal_year_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_fiscal_year_code`(`organisation_id`, `code`),
    UNIQUE INDEX `ux_fiscal_year_start`(`organisation_id`, `start_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `accounting_period` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `fiscal_year_id` BIGINT UNSIGNED NOT NULL,
    `period_number` SMALLINT NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `start_date` DATE NOT NULL,
    `end_date` DATE NOT NULL,
    `state` VARCHAR(30) NOT NULL DEFAULT 'future',
    `closed_at` DATETIME(0) NULL,
    `closed_by` BIGINT UNSIGNED NULL,
    `reopened_at` DATETIME(0) NULL,
    `reopened_by` BIGINT UNSIGNED NULL,
    `reopen_reason` VARCHAR(500) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_accounting_period_dates`(`start_date`, `end_date`),
    INDEX `ix_accounting_period_state`(`state`),
    INDEX `ix_accounting_period_closed_by`(`closed_by`),
    INDEX `ix_accounting_period_reopened_by`(`reopened_by`),
    INDEX `ix_accounting_period_created_by`(`created_by`),
    INDEX `ix_accounting_period_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_period`(`fiscal_year_id`, `period_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `season` ADD CONSTRAINT `fk_season_estate` FOREIGN KEY (`estate_id`) REFERENCES `estate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `season` ADD CONSTRAINT `fk_season_closed_by` FOREIGN KEY (`closed_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `season` ADD CONSTRAINT `fk_season_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `season` ADD CONSTRAINT `fk_season_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `fiscal_year` ADD CONSTRAINT `fk_fiscal_year_organisation` FOREIGN KEY (`organisation_id`) REFERENCES `organisation`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `fiscal_year` ADD CONSTRAINT `fk_fiscal_year_closed_by` FOREIGN KEY (`closed_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `fiscal_year` ADD CONSTRAINT `fk_fiscal_year_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `fiscal_year` ADD CONSTRAINT `fk_fiscal_year_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `accounting_period` ADD CONSTRAINT `fk_accounting_period_fiscal_year` FOREIGN KEY (`fiscal_year_id`) REFERENCES `fiscal_year`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `accounting_period` ADD CONSTRAINT `fk_accounting_period_closed_by` FOREIGN KEY (`closed_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `accounting_period` ADD CONSTRAINT `fk_accounting_period_reopened_by` FOREIGN KEY (`reopened_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `accounting_period` ADD CONSTRAINT `fk_accounting_period_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `accounting_period` ADD CONSTRAINT `fk_accounting_period_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- HAND-EDIT: CHECK constraints (prisma/README.md).
-- end_date > start_date is P3 §4.8's own CHECK. A closed season always says when and by whom.
ALTER TABLE `season`
  ADD CONSTRAINT `ck_season_dates` CHECK (`end_date` > `start_date`),
  ADD CONSTRAINT `ck_season_state` CHECK (`state` IN ('planned', 'active', 'closed')),
  ADD CONSTRAINT `ck_season_closed` CHECK ((`state` = 'closed') = (`closed_at` IS NOT NULL) AND (`closed_at` IS NULL) = (`closed_by` IS NULL));

ALTER TABLE `fiscal_year`
  ADD CONSTRAINT `ck_fiscal_year_dates` CHECK (`end_date` > `start_date`),
  ADD CONSTRAINT `ck_fiscal_year_state` CHECK (`state` IN ('future', 'open', 'closed')),
  ADD CONSTRAINT `ck_fiscal_year_closed` CHECK ((`state` = 'closed') = (`closed_at` IS NOT NULL) AND (`closed_at` IS NULL) = (`closed_by` IS NULL));

-- Period 13 is the year-end adjustment period (P3 §4.10): one day, the last of the year.
ALTER TABLE `accounting_period`
  ADD CONSTRAINT `ck_accounting_period_number` CHECK (`period_number` BETWEEN 1 AND 13),
  ADD CONSTRAINT `ck_accounting_period_dates` CHECK (`end_date` >= `start_date`),
  ADD CONSTRAINT `ck_accounting_period_state` CHECK (`state` IN ('future', 'open', 'soft_closed', 'closed', 'reopened')),
  ADD CONSTRAINT `ck_accounting_period_reopen` CHECK ((`reopened_at` IS NULL) = (`reopen_reason` IS NULL) AND (`reopened_at` IS NULL) = (`reopened_by` IS NULL));

-- HAND-EDIT: per-table rights for the app account. A planned season or a future fiscal year (with its
-- periods) may be deleted; anything that has been in use is closed, never deleted.
GRANT UPDATE, DELETE ON `season` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `fiscal_year` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `accounting_period` TO 'rupai_app'@'%';

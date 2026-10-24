-- AlterTable
ALTER TABLE `approval_request` ADD COLUMN `cost_centre_id` BIGINT UNSIGNED NULL;

-- CreateTable
CREATE TABLE `cost_centre` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `description` VARCHAR(500) NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `is_system` BOOLEAN NOT NULL DEFAULT false,
    `parent_cost_centre_id` BIGINT UNSIGNED NULL,
    `estate_id` BIGINT UNSIGNED NULL,
    `centre_type` VARCHAR(30) NOT NULL,
    `manager_profile_id` BIGINT UNSIGNED NULL,
    `status` VARCHAR(30) NOT NULL DEFAULT 'active',
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_cost_centre_parent`(`parent_cost_centre_id`),
    INDEX `ix_cost_centre_estate`(`estate_id`),
    INDEX `ix_cost_centre_type`(`centre_type`),
    INDEX `ix_cost_centre_manager`(`manager_profile_id`),
    INDEX `ix_cost_centre_status`(`status`),
    INDEX `ix_cost_centre_created_by`(`created_by`),
    INDEX `ix_cost_centre_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_cost_centre_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `budget_head` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `description` VARCHAR(500) NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `is_system` BOOLEAN NOT NULL DEFAULT false,
    `parent_head_id` BIGINT UNSIGNED NULL,
    `account_id` BIGINT UNSIGNED NULL,
    `head_type` VARCHAR(30) NOT NULL,
    `is_controlled` BOOLEAN NOT NULL DEFAULT true,
    `status` VARCHAR(30) NOT NULL DEFAULT 'active',
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_budget_head_parent`(`parent_head_id`),
    INDEX `ix_budget_head_account`(`account_id`),
    INDEX `ix_budget_head_type`(`head_type`),
    INDEX `ix_budget_head_status`(`status`),
    INDEX `ix_budget_head_created_by`(`created_by`),
    INDEX `ix_budget_head_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_budget_head_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `bank_account` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `account_id` BIGINT UNSIGNED NOT NULL,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `account_kind` VARCHAR(30) NOT NULL,
    `bank_name` VARCHAR(150) NULL,
    `branch_name` VARCHAR(150) NULL,
    `account_number` VARCHAR(40) NULL,
    `currency_id` BIGINT UNSIGNED NOT NULL,
    `estate_id` BIGINT UNSIGNED NULL,
    `opening_balance` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `current_balance` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `last_reconciled_on` DATE NULL,
    `status` VARCHAR(30) NOT NULL DEFAULT 'active',
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_bank_account_currency`(`currency_id`),
    INDEX `ix_bank_account_estate`(`estate_id`),
    INDEX `ix_bank_account_status`(`status`),
    INDEX `ix_bank_account_created_by`(`created_by`),
    INDEX `ix_bank_account_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_bank_account_code`(`code`),
    UNIQUE INDEX `ux_bank_chart_account`(`account_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `ix_employment_assignment_cost_centre` ON `employment_assignment`(`cost_centre_id`);

-- CreateIndex
CREATE INDEX `ix_training_program_budget_head` ON `training_program`(`budget_head_id`);

-- CreateIndex
CREATE INDEX `ix_welfare_case_budget_head` ON `welfare_case`(`budget_head_id`);

-- HAND-EDIT: these columns had no FK and were refused or absent in the API until now (D-2.03-7,
-- D-2.08-6, D-2.09-4); clear any stray value so the FKs apply.
UPDATE `employment_assignment` SET `cost_centre_id` = NULL WHERE `cost_centre_id` IS NOT NULL;
UPDATE `welfare_case` SET `budget_head_id` = NULL WHERE `budget_head_id` IS NOT NULL;
UPDATE `training_program` SET `budget_head_id` = NULL WHERE `budget_head_id` IS NOT NULL;

-- AddForeignKey
ALTER TABLE `employment_assignment` ADD CONSTRAINT `fk_employment_assignment_cost_centre` FOREIGN KEY (`cost_centre_id`) REFERENCES `cost_centre`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `welfare_case` ADD CONSTRAINT `fk_welfare_case_budget_head` FOREIGN KEY (`budget_head_id`) REFERENCES `budget_head`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `training_program` ADD CONSTRAINT `fk_training_program_budget_head` FOREIGN KEY (`budget_head_id`) REFERENCES `budget_head`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `cost_centre` ADD CONSTRAINT `fk_cost_centre_parent` FOREIGN KEY (`parent_cost_centre_id`) REFERENCES `cost_centre`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `cost_centre` ADD CONSTRAINT `fk_cost_centre_estate` FOREIGN KEY (`estate_id`) REFERENCES `estate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `cost_centre` ADD CONSTRAINT `fk_cost_centre_manager` FOREIGN KEY (`manager_profile_id`) REFERENCES `employment_profile`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `cost_centre` ADD CONSTRAINT `fk_cost_centre_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `cost_centre` ADD CONSTRAINT `fk_cost_centre_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget_head` ADD CONSTRAINT `fk_budget_head_parent` FOREIGN KEY (`parent_head_id`) REFERENCES `budget_head`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget_head` ADD CONSTRAINT `fk_budget_head_account` FOREIGN KEY (`account_id`) REFERENCES `account`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget_head` ADD CONSTRAINT `fk_budget_head_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget_head` ADD CONSTRAINT `fk_budget_head_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `bank_account` ADD CONSTRAINT `fk_bank_account_account` FOREIGN KEY (`account_id`) REFERENCES `account`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `bank_account` ADD CONSTRAINT `fk_bank_account_currency` FOREIGN KEY (`currency_id`) REFERENCES `currency`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `bank_account` ADD CONSTRAINT `fk_bank_account_estate` FOREIGN KEY (`estate_id`) REFERENCES `estate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `bank_account` ADD CONSTRAINT `fk_bank_account_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `bank_account` ADD CONSTRAINT `fk_bank_account_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- HAND-EDIT: CHECK constraints (prisma/README.md). D-3.02-3, D-3.02-5, D-3.02-6. "Not its own parent"
-- cannot be a CHECK (MySQL refuses one on the auto-increment id): the services enforce the tree rules.
ALTER TABLE `cost_centre`
  ADD CONSTRAINT `ck_cost_centre_type` CHECK (`centre_type` IN ('estate', 'division', 'factory', 'department', 'project')),
  -- An estate's or a division's cost centre names its estate.
  ADD CONSTRAINT `ck_cost_centre_estate` CHECK (`centre_type` NOT IN ('estate', 'division') OR `estate_id` IS NOT NULL),
  ADD CONSTRAINT `ck_cost_centre_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `budget_head`
  ADD CONSTRAINT `ck_budget_head_type` CHECK (`head_type` IN ('revenue', 'expense', 'capital')),
  ADD CONSTRAINT `ck_budget_head_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `bank_account`
  ADD CONSTRAINT `ck_bank_account_kind` CHECK (`account_kind` IN ('bank', 'cash', 'mobile_money')),
  -- A bank account names its bank and its number.
  ADD CONSTRAINT `ck_bank_account_bank` CHECK (
    `account_kind` <> 'bank' OR (`bank_name` IS NOT NULL AND `account_number` IS NOT NULL)),
  ADD CONSTRAINT `ck_bank_account_status` CHECK (`status` IN ('active', 'inactive'));

-- HAND-EDIT: per-table rights for the app account. Masters: edited, deactivated, deleted while unused.
GRANT UPDATE, DELETE ON `cost_centre` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `budget_head` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `bank_account` TO 'rupai_app'@'%';

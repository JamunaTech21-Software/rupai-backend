-- CreateTable
CREATE TABLE `account` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `parent_id` BIGINT UNSIGNED NULL,
    `code` VARCHAR(30) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `account_type` VARCHAR(30) NOT NULL,
    `account_subtype` VARCHAR(40) NULL,
    `normal_balance` VARCHAR(10) NOT NULL,
    `is_postable` BOOLEAN NOT NULL DEFAULT false,
    `is_control_account` BOOLEAN NOT NULL DEFAULT false,
    `control_subledger` VARCHAR(30) NULL,
    `is_bank_or_cash` BOOLEAN NOT NULL DEFAULT false,
    `currency_id` BIGINT UNSIGNED NULL,
    `requires_cost_centre` BOOLEAN NOT NULL DEFAULT false,
    `requires_estate` BOOLEAN NOT NULL DEFAULT false,
    `is_clearing` BOOLEAN NOT NULL DEFAULT false,
    `system_key` VARCHAR(50) NULL,
    `is_system` BOOLEAN NOT NULL DEFAULT false,
    `level` SMALLINT NOT NULL,
    `path` VARCHAR(255) NULL,
    `status` VARCHAR(30) NOT NULL DEFAULT 'inactive',
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_account_parent`(`parent_id`),
    INDEX `ix_account_name`(`name`),
    INDEX `ix_account_type`(`account_type`),
    INDEX `ix_account_subtype`(`account_subtype`),
    INDEX `ix_account_postable`(`is_postable`),
    INDEX `ix_account_path`(`path`),
    INDEX `ix_account_status`(`status`),
    INDEX `ix_account_currency`(`currency_id`),
    INDEX `ix_account_created_by`(`created_by`),
    INDEX `ix_account_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_account_code`(`code`),
    UNIQUE INDEX `ux_account_system_key`(`system_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `ix_benefit_type_expense_account` ON `benefit_type`(`expense_account_id`);

-- HAND-EDIT: expense_account_id had no FK and no writer until now (D-2.08-6); clear any stray value so the FK applies.
UPDATE `benefit_type` SET `expense_account_id` = NULL WHERE `expense_account_id` IS NOT NULL;

-- AddForeignKey
ALTER TABLE `benefit_type` ADD CONSTRAINT `fk_benefit_type_expense_account` FOREIGN KEY (`expense_account_id`) REFERENCES `account`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `account` ADD CONSTRAINT `fk_account_parent` FOREIGN KEY (`parent_id`) REFERENCES `account`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `account` ADD CONSTRAINT `fk_account_currency` FOREIGN KEY (`currency_id`) REFERENCES `currency`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `account` ADD CONSTRAINT `fk_account_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `account` ADD CONSTRAINT `fk_account_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- HAND-EDIT: CHECK constraints (prisma/README.md). P3 §27.1 and D-3.01-2..10. "No postable account has
-- children" spans rows, so the application enforces it (P3 §27.1 note).
ALTER TABLE `account`
  ADD CONSTRAINT `ck_account_type` CHECK (`account_type` IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  ADD CONSTRAINT `ck_account_subtype` CHECK (
    `account_subtype` IS NULL
    OR (`account_type` = 'asset' AND `account_subtype` IN ('current_asset', 'fixed_asset'))
    OR (`account_type` = 'liability' AND `account_subtype` IN ('current_liability', 'long_term_liability'))
    OR (`account_type` = 'revenue' AND `account_subtype` IN ('operating_revenue', 'other_revenue'))
    OR (`account_type` = 'expense' AND `account_subtype` IN ('direct_expense', 'operating_expense', 'financing'))),
  ADD CONSTRAINT `ck_account_normal_balance` CHECK (`normal_balance` IN ('debit', 'credit')),
  -- A control account is a postable account that names its sub-ledger (P8 §2.4).
  ADD CONSTRAINT `ck_account_control` CHECK (
    `is_control_account` = (`control_subledger` IS NOT NULL)
    AND (`is_control_account` = 0 OR `is_postable` = 1)
    AND (`control_subledger` IS NULL OR `control_subledger` IN
      ('receivable', 'payable', 'inventory', 'payroll_liability', 'pf_liability', 'advance'))),
  -- Cash and bank are postable asset accounts; only they carry a currency (P3 §27.1).
  ADD CONSTRAINT `ck_account_bank_or_cash` CHECK (
    (`is_bank_or_cash` = 0 OR (`is_postable` = 1 AND `account_type` = 'asset'))
    AND (`currency_id` IS NULL OR `is_bank_or_cash` = 1)),
  -- Four levels at most (P8 §4.2); a top-level account has no parent.
  ADD CONSTRAINT `ck_account_level` CHECK (`level` BETWEEN 1 AND 4 AND (`parent_id` IS NULL) = (`level` = 1)),
  ADD CONSTRAINT `ck_account_system_key` CHECK (`system_key` IS NULL OR `is_system` = 1),
  ADD CONSTRAINT `ck_account_status` CHECK (`status` IN ('active', 'inactive'));

-- HAND-EDIT: per-table rights for the app account. A master: edited, deactivated, and deleted while unused.
GRANT UPDATE, DELETE ON `account` TO 'rupai_app'@'%';

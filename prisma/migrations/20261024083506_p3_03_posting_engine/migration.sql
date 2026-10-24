-- CreateTable
CREATE TABLE `posting_rule` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `rule_code` VARCHAR(30) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `description` VARCHAR(500) NULL,
    `source_type` VARCHAR(40) NOT NULL,
    `purpose` VARCHAR(40) NOT NULL,
    `condition_json` JSON NOT NULL,
    `sequence` INTEGER NOT NULL DEFAULT 10,
    `is_active` BOOLEAN NOT NULL DEFAULT false,
    `effective_from` DATE NOT NULL,
    `effective_to` DATE NULL,
    `approved_at` DATETIME(0) NULL,
    `approved_by` BIGINT UNSIGNED NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_posting_rule_source`(`source_type`, `purpose`, `is_active`),
    INDEX `ix_posting_rule_approved_by`(`approved_by`),
    INDEX `ix_posting_rule_created_by`(`created_by`),
    INDEX `ix_posting_rule_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_posting_rule_code`(`rule_code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `posting_rule_line` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `posting_rule_id` BIGINT UNSIGNED NOT NULL,
    `side` VARCHAR(10) NOT NULL,
    `account_resolution` VARCHAR(30) NOT NULL,
    `account_id` BIGINT UNSIGNED NULL,
    `resolution_key` VARCHAR(50) NULL,
    `amount_source` VARCHAR(50) NOT NULL,
    `sequence` INTEGER NOT NULL,
    `narration` VARCHAR(300) NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,

    INDEX `ix_posting_rule_line_account`(`account_id`),
    INDEX `ix_posting_rule_line_created_by`(`created_by`),
    UNIQUE INDEX `ux_posting_rule_line`(`posting_rule_id`, `sequence`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `journal` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `journal_number` VARCHAR(30) NULL,
    `journal_type` VARCHAR(30) NOT NULL,
    `journal_date` DATE NOT NULL,
    `accounting_period_id` BIGINT UNSIGNED NOT NULL,
    `fiscal_year_id` BIGINT UNSIGNED NOT NULL,
    `narration` VARCHAR(500) NOT NULL,
    `reference` VARCHAR(50) NULL,
    `source_type` VARCHAR(40) NULL,
    `source_id` BIGINT UNSIGNED NULL,
    `posting_rule_id` BIGINT UNSIGNED NULL,
    `estate_id` BIGINT UNSIGNED NULL,
    `currency_id` BIGINT UNSIGNED NOT NULL,
    `exchange_rate` DECIMAL(18, 8) NOT NULL DEFAULT 1,
    `total_debit` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `total_credit` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `reversal_of_id` BIGINT UNSIGNED NULL,
    `is_reversed` BOOLEAN NOT NULL DEFAULT false,
    `state` VARCHAR(30) NOT NULL DEFAULT 'draft',
    `state_changed_at` DATETIME(0) NULL,
    `submitted_at` DATETIME(0) NULL,
    `submitted_by` BIGINT UNSIGNED NULL,
    `approved_at` DATETIME(0) NULL,
    `approved_by` BIGINT UNSIGNED NULL,
    `rejected_at` DATETIME(0) NULL,
    `rejected_by` BIGINT UNSIGNED NULL,
    `rejection_reason` VARCHAR(500) NULL,
    `posted_at` DATETIME(0) NULL,
    `posted_by` BIGINT UNSIGNED NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_journal_type`(`journal_type`),
    INDEX `ix_journal_date`(`journal_date`),
    INDEX `ix_journal_period`(`accounting_period_id`),
    INDEX `ix_journal_fiscal_year`(`fiscal_year_id`),
    INDEX `ix_journal_reference`(`reference`),
    INDEX `ix_journal_source`(`source_type`, `source_id`),
    INDEX `ix_journal_posting_rule`(`posting_rule_id`),
    INDEX `ix_journal_estate`(`estate_id`),
    INDEX `ix_journal_currency`(`currency_id`),
    INDEX `ix_journal_reversal_of`(`reversal_of_id`),
    INDEX `ix_journal_is_reversed`(`is_reversed`),
    INDEX `ix_journal_state`(`state`),
    INDEX `ix_journal_submitted_by`(`submitted_by`),
    INDEX `ix_journal_approved_by`(`approved_by`),
    INDEX `ix_journal_rejected_by`(`rejected_by`),
    INDEX `ix_journal_posted_by`(`posted_by`),
    INDEX `ix_journal_created_by`(`created_by`),
    INDEX `ix_journal_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_journal_number`(`journal_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `journal_line` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `journal_id` BIGINT UNSIGNED NOT NULL,
    `line_number` INTEGER NOT NULL,
    `account_id` BIGINT UNSIGNED NOT NULL,
    `debit` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `credit` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `transaction_debit` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `transaction_credit` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `cost_centre_id` BIGINT UNSIGNED NULL,
    `estate_id` BIGINT UNSIGNED NULL,
    `department_id` BIGINT UNSIGNED NULL,
    `budget_head_id` BIGINT UNSIGNED NULL,
    `party_type` VARCHAR(40) NULL,
    `party_id` BIGINT UNSIGNED NULL,
    `narration` VARCHAR(300) NULL,
    `accounting_period_id` BIGINT UNSIGNED NOT NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `ix_jl_account_period`(`account_id`, `accounting_period_id`),
    INDEX `ix_jl_cost_centre`(`cost_centre_id`, `account_id`),
    INDEX `ix_jl_party`(`party_type`, `party_id`),
    INDEX `ix_jl_estate`(`estate_id`),
    INDEX `ix_jl_department`(`department_id`),
    INDEX `ix_jl_budget_head`(`budget_head_id`),
    INDEX `ix_jl_period`(`accounting_period_id`),
    UNIQUE INDEX `ux_journal_line`(`journal_id`, `line_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `posting_link` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `source_type` VARCHAR(40) NOT NULL,
    `source_id` BIGINT UNSIGNED NOT NULL,
    `purpose` VARCHAR(40) NOT NULL,
    `journal_id` BIGINT UNSIGNED NOT NULL,
    `posted_at` DATETIME(0) NOT NULL,
    `posted_by` BIGINT UNSIGNED NOT NULL,

    INDEX `ix_posting_link_journal`(`journal_id`),
    INDEX `ix_posting_link_posted_by`(`posted_by`),
    UNIQUE INDEX `ux_posting_link`(`source_type`, `source_id`, `purpose`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ledger_balance` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `account_id` BIGINT UNSIGNED NOT NULL,
    `accounting_period_id` BIGINT UNSIGNED NOT NULL,
    `cost_centre_id` BIGINT UNSIGNED NULL,
    `estate_id` BIGINT UNSIGNED NULL,
    -- HAND-EDIT: the four dimensions, NULL-safe, so ux_ledger_balance holds one row per combination (D-3.03-6).
    `balance_key` VARCHAR(100) GENERATED ALWAYS AS (CONCAT(`account_id`, ':', `accounting_period_id`, ':', IFNULL(`cost_centre_id`, 0), ':', IFNULL(`estate_id`, 0))) STORED,
    `opening_debit` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `opening_credit` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `period_debit` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `period_credit` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `closing_debit` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `closing_credit` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `last_rebuilt_at` DATETIME(0) NULL,
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `ix_ledger_balance_period`(`accounting_period_id`, `account_id`),
    INDEX `ix_ledger_balance_account`(`account_id`),
    INDEX `ix_ledger_balance_cost_centre`(`cost_centre_id`),
    INDEX `ix_ledger_balance_estate`(`estate_id`),
    UNIQUE INDEX `ux_ledger_balance`(`balance_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `posting_rule` ADD CONSTRAINT `fk_posting_rule_approved_by` FOREIGN KEY (`approved_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `posting_rule` ADD CONSTRAINT `fk_posting_rule_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `posting_rule` ADD CONSTRAINT `fk_posting_rule_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `posting_rule_line` ADD CONSTRAINT `fk_posting_rule_line_rule` FOREIGN KEY (`posting_rule_id`) REFERENCES `posting_rule`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `posting_rule_line` ADD CONSTRAINT `fk_posting_rule_line_account` FOREIGN KEY (`account_id`) REFERENCES `account`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `posting_rule_line` ADD CONSTRAINT `fk_posting_rule_line_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `journal` ADD CONSTRAINT `fk_journal_period` FOREIGN KEY (`accounting_period_id`) REFERENCES `accounting_period`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `journal` ADD CONSTRAINT `fk_journal_fiscal_year` FOREIGN KEY (`fiscal_year_id`) REFERENCES `fiscal_year`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `journal` ADD CONSTRAINT `fk_journal_posting_rule` FOREIGN KEY (`posting_rule_id`) REFERENCES `posting_rule`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `journal` ADD CONSTRAINT `fk_journal_estate` FOREIGN KEY (`estate_id`) REFERENCES `estate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `journal` ADD CONSTRAINT `fk_journal_currency` FOREIGN KEY (`currency_id`) REFERENCES `currency`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `journal` ADD CONSTRAINT `fk_journal_reversal_of` FOREIGN KEY (`reversal_of_id`) REFERENCES `journal`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `journal` ADD CONSTRAINT `fk_journal_submitted_by` FOREIGN KEY (`submitted_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `journal` ADD CONSTRAINT `fk_journal_approved_by` FOREIGN KEY (`approved_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `journal` ADD CONSTRAINT `fk_journal_rejected_by` FOREIGN KEY (`rejected_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `journal` ADD CONSTRAINT `fk_journal_posted_by` FOREIGN KEY (`posted_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `journal` ADD CONSTRAINT `fk_journal_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `journal` ADD CONSTRAINT `fk_journal_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `journal_line` ADD CONSTRAINT `fk_journal_line_journal` FOREIGN KEY (`journal_id`) REFERENCES `journal`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `journal_line` ADD CONSTRAINT `fk_journal_line_account` FOREIGN KEY (`account_id`) REFERENCES `account`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `journal_line` ADD CONSTRAINT `fk_journal_line_cost_centre` FOREIGN KEY (`cost_centre_id`) REFERENCES `cost_centre`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `journal_line` ADD CONSTRAINT `fk_journal_line_estate` FOREIGN KEY (`estate_id`) REFERENCES `estate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `journal_line` ADD CONSTRAINT `fk_journal_line_department` FOREIGN KEY (`department_id`) REFERENCES `department`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `journal_line` ADD CONSTRAINT `fk_journal_line_budget_head` FOREIGN KEY (`budget_head_id`) REFERENCES `budget_head`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `journal_line` ADD CONSTRAINT `fk_journal_line_period` FOREIGN KEY (`accounting_period_id`) REFERENCES `accounting_period`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `posting_link` ADD CONSTRAINT `fk_posting_link_journal` FOREIGN KEY (`journal_id`) REFERENCES `journal`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `posting_link` ADD CONSTRAINT `fk_posting_link_posted_by` FOREIGN KEY (`posted_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `ledger_balance` ADD CONSTRAINT `fk_ledger_balance_account` FOREIGN KEY (`account_id`) REFERENCES `account`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `ledger_balance` ADD CONSTRAINT `fk_ledger_balance_period` FOREIGN KEY (`accounting_period_id`) REFERENCES `accounting_period`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `ledger_balance` ADD CONSTRAINT `fk_ledger_balance_cost_centre` FOREIGN KEY (`cost_centre_id`) REFERENCES `cost_centre`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `ledger_balance` ADD CONSTRAINT `fk_ledger_balance_estate` FOREIGN KEY (`estate_id`) REFERENCES `estate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- HAND-EDIT: CHECK constraints (prisma/README.md). P3 §27.3–§27.7, D-3.03-*.
ALTER TABLE `posting_rule`
  ADD CONSTRAINT `ck_posting_rule_purpose` CHECK (`purpose` IN ('revenue', 'cost_of_goods_sold', 'receivable',
    'payable', 'expense', 'inventory_in', 'inventory_out', 'payroll_expense', 'payroll_liability', 'pf_liability',
    'depreciation', 'variance', 'disposal')),
  ADD CONSTRAINT `ck_posting_rule_dates` CHECK (`effective_to` IS NULL OR `effective_to` >= `effective_from`),
  ADD CONSTRAINT `ck_posting_rule_approval` CHECK (`is_active` = 0 OR `approved_at` IS NOT NULL);
ALTER TABLE `posting_rule_line`
  ADD CONSTRAINT `ck_posting_rule_line_side` CHECK (`side` IN ('debit', 'credit')),
  -- A fixed line names its account; every other resolution names what it reads (P8 §5.2).
  ADD CONSTRAINT `ck_posting_rule_line_resolution` CHECK (
    (`account_resolution` = 'fixed' AND `account_id` IS NOT NULL)
    OR (`account_resolution` IN ('from_component', 'from_category', 'from_charge_type', 'from_account_field')
        AND `account_id` IS NULL AND `resolution_key` IS NOT NULL));
ALTER TABLE `journal`
  ADD CONSTRAINT `ck_journal_type` CHECK (`journal_type` IN ('automatic', 'manual', 'opening', 'closing', 'reversal', 'adjustment')),
  ADD CONSTRAINT `ck_journal_state` CHECK (`state` IN ('draft', 'submitted', 'approved', 'rejected', 'posted')),
  -- Posted: numbered, dated, balanced in base currency (P3 §27.3 invariant).
  ADD CONSTRAINT `ck_journal_posted` CHECK (
    `state` <> 'posted' OR (`journal_number` IS NOT NULL AND `posted_at` IS NOT NULL AND `total_debit` = `total_credit`)),
  ADD CONSTRAINT `ck_journal_totals` CHECK (`total_debit` >= 0 AND `total_credit` >= 0 AND `exchange_rate` > 0),
  ADD CONSTRAINT `ck_journal_source` CHECK ((`source_type` IS NULL) = (`source_id` IS NULL)),
  ADD CONSTRAINT `ck_journal_rejection` CHECK ((`state` = 'rejected') = (`rejected_at` IS NOT NULL AND `rejection_reason` IS NOT NULL));
ALTER TABLE `journal_line`
  -- One side or the other, never both and never zero (P3 §27.4).
  ADD CONSTRAINT `ck_journal_line_side` CHECK ((`debit` = 0 AND `credit` > 0) OR (`debit` > 0 AND `credit` = 0)),
  ADD CONSTRAINT `ck_journal_line_transaction` CHECK (
    `transaction_debit` >= 0 AND `transaction_credit` >= 0
    AND (`debit` = 0 OR `transaction_credit` = 0) AND (`credit` = 0 OR `transaction_debit` = 0)),
  ADD CONSTRAINT `ck_journal_line_party` CHECK ((`party_type` IS NULL) = (`party_id` IS NULL));
ALTER TABLE `posting_link`
  ADD CONSTRAINT `ck_posting_link_purpose` CHECK (`purpose` IN ('revenue', 'cost_of_goods_sold', 'receivable',
    'payable', 'expense', 'inventory_in', 'inventory_out', 'payroll_expense', 'payroll_liability', 'pf_liability',
    'depreciation', 'variance', 'disposal', 'reversal'));

-- HAND-EDIT: per-table rights for the app account. journal_line and posting_link are immutable: no UPDATE,
-- no DELETE (prisma/README.md). A journal changes state (and manual drafts are deleted, P3.04); rule lines
-- are replaced while the rule is inactive; ledger balances are maintained and rebuilt.
GRANT UPDATE, DELETE ON `posting_rule` TO 'rupai_app'@'%';
GRANT DELETE ON `posting_rule_line` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `journal` TO 'rupai_app'@'%';
GRANT UPDATE ON `ledger_balance` TO 'rupai_app'@'%';

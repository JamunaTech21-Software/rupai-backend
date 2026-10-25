-- CreateTable
CREATE TABLE `journal_draft_line` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `journal_id` BIGINT UNSIGNED NOT NULL,
    `line_number` INTEGER NOT NULL,
    `account_id` BIGINT UNSIGNED NOT NULL,
    `side` VARCHAR(10) NOT NULL,
    `amount` DECIMAL(18, 4) NOT NULL,
    `cost_centre_id` BIGINT UNSIGNED NULL,
    `estate_id` BIGINT UNSIGNED NULL,
    `department_id` BIGINT UNSIGNED NULL,
    `budget_head_id` BIGINT UNSIGNED NULL,
    `narration` VARCHAR(300) NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `ix_jdl_account`(`account_id`),
    INDEX `ix_jdl_cost_centre`(`cost_centre_id`),
    INDEX `ix_jdl_estate`(`estate_id`),
    INDEX `ix_jdl_department`(`department_id`),
    INDEX `ix_jdl_budget_head`(`budget_head_id`),
    UNIQUE INDEX `ux_journal_draft_line`(`journal_id`, `line_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `opening_balance` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `account_id` BIGINT UNSIGNED NOT NULL,
    `fiscal_year_id` BIGINT UNSIGNED NOT NULL,
    `cost_centre_id` BIGINT UNSIGNED NULL,
    `estate_id` BIGINT UNSIGNED NULL,
    -- HAND-EDIT: the four dimensions, NULL-safe, so ux_opening_balance holds one row per combination (D-3.04-9).
    `opening_key` VARCHAR(100) GENERATED ALWAYS AS (CONCAT(`account_id`, ':', `fiscal_year_id`, ':', IFNULL(`cost_centre_id`, 0), ':', IFNULL(`estate_id`, 0))) STORED,
    `debit` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `credit` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `source` VARCHAR(20) NOT NULL,
    `journal_id` BIGINT UNSIGNED NOT NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,

    INDEX `ix_opening_balance_account`(`account_id`),
    INDEX `ix_opening_balance_fiscal_year`(`fiscal_year_id`),
    INDEX `ix_opening_balance_cost_centre`(`cost_centre_id`),
    INDEX `ix_opening_balance_estate`(`estate_id`),
    INDEX `ix_opening_balance_journal`(`journal_id`),
    INDEX `ix_opening_balance_created_by`(`created_by`),
    UNIQUE INDEX `ux_opening_balance`(`opening_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `journal_draft_line` ADD CONSTRAINT `fk_journal_draft_line_journal` FOREIGN KEY (`journal_id`) REFERENCES `journal`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `journal_draft_line` ADD CONSTRAINT `fk_journal_draft_line_account` FOREIGN KEY (`account_id`) REFERENCES `account`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `journal_draft_line` ADD CONSTRAINT `fk_journal_draft_line_cost_centre` FOREIGN KEY (`cost_centre_id`) REFERENCES `cost_centre`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `journal_draft_line` ADD CONSTRAINT `fk_journal_draft_line_estate` FOREIGN KEY (`estate_id`) REFERENCES `estate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `journal_draft_line` ADD CONSTRAINT `fk_journal_draft_line_department` FOREIGN KEY (`department_id`) REFERENCES `department`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `journal_draft_line` ADD CONSTRAINT `fk_journal_draft_line_budget_head` FOREIGN KEY (`budget_head_id`) REFERENCES `budget_head`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `opening_balance` ADD CONSTRAINT `fk_opening_balance_account` FOREIGN KEY (`account_id`) REFERENCES `account`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `opening_balance` ADD CONSTRAINT `fk_opening_balance_fiscal_year` FOREIGN KEY (`fiscal_year_id`) REFERENCES `fiscal_year`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `opening_balance` ADD CONSTRAINT `fk_opening_balance_cost_centre` FOREIGN KEY (`cost_centre_id`) REFERENCES `cost_centre`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `opening_balance` ADD CONSTRAINT `fk_opening_balance_estate` FOREIGN KEY (`estate_id`) REFERENCES `estate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `opening_balance` ADD CONSTRAINT `fk_opening_balance_journal` FOREIGN KEY (`journal_id`) REFERENCES `journal`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `opening_balance` ADD CONSTRAINT `fk_opening_balance_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- HAND-EDIT: CHECK constraints (prisma/README.md). P3 §27.4, §27.6, D-3.04-1, D-3.04-9.
ALTER TABLE `journal_draft_line`
  ADD CONSTRAINT `ck_journal_draft_line_side` CHECK (`side` IN ('debit', 'credit')),
  ADD CONSTRAINT `ck_journal_draft_line_amount` CHECK (`amount` > 0),
  ADD CONSTRAINT `ck_journal_draft_line_number` CHECK (`line_number` > 0);
ALTER TABLE `opening_balance`
  ADD CONSTRAINT `ck_opening_balance_source` CHECK (`source` IN ('migration', 'rollover')),
  -- One side or the other, never both and never zero (as a journal line).
  ADD CONSTRAINT `ck_opening_balance_side` CHECK ((`debit` = 0 AND `credit` > 0) OR (`debit` > 0 AND `credit` = 0));

-- HAND-EDIT: per-table rights for the app account. Draft lines are replaced while the journal is a draft
-- (and go with a deleted draft). Opening balances are written once by their posted journal and removed only
-- when that journal is reversed (D-3.04-9).
GRANT UPDATE, DELETE ON `journal_draft_line` TO 'rupai_app'@'%';
GRANT DELETE ON `opening_balance` TO 'rupai_app'@'%';

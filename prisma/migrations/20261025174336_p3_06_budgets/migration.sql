-- CreateTable
CREATE TABLE `budget` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `budget_code` VARCHAR(30) NOT NULL,
    `fiscal_year_id` BIGINT UNSIGNED NOT NULL,
    `estate_id` BIGINT UNSIGNED NULL,
    `department_id` BIGINT UNSIGNED NULL,
    `name` VARCHAR(150) NOT NULL,
    `budget_type` VARCHAR(30) NOT NULL,
    `revision_number` INTEGER NOT NULL DEFAULT 0,
    `supersedes_id` BIGINT UNSIGNED NULL,
    `total_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `notes` VARCHAR(500) NULL,
    `activated_at` DATETIME(0) NULL,
    `activated_by` BIGINT UNSIGNED NULL,
    -- HAND-EDIT: the dimension tuple while active, else NULL: one active budget per tuple (P2 §7.3, D-3.06-1).
    `active_key` VARCHAR(60) GENERATED ALWAYS AS (IF(`state` = 'active', CONCAT(`fiscal_year_id`, ':', IFNULL(`estate_id`, 0), ':', IFNULL(`department_id`, 0), ':', `budget_type`), NULL)) STORED,
    `state` VARCHAR(30) NOT NULL DEFAULT 'draft',
    `state_changed_at` DATETIME(0) NULL,
    `submitted_at` DATETIME(0) NULL,
    `submitted_by` BIGINT UNSIGNED NULL,
    `approved_at` DATETIME(0) NULL,
    `approved_by` BIGINT UNSIGNED NULL,
    `rejected_at` DATETIME(0) NULL,
    `rejected_by` BIGINT UNSIGNED NULL,
    `rejection_reason` VARCHAR(500) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_budget_fiscal_year`(`fiscal_year_id`),
    INDEX `ix_budget_estate`(`estate_id`),
    INDEX `ix_budget_department`(`department_id`),
    INDEX `ix_budget_supersedes`(`supersedes_id`),
    INDEX `ix_budget_state`(`state`),
    INDEX `ix_budget_submitted_by`(`submitted_by`),
    INDEX `ix_budget_approved_by`(`approved_by`),
    INDEX `ix_budget_rejected_by`(`rejected_by`),
    INDEX `ix_budget_activated_by`(`activated_by`),
    INDEX `ix_budget_created_by`(`created_by`),
    INDEX `ix_budget_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_budget_code`(`budget_code`),
    UNIQUE INDEX `ux_budget_active`(`active_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `budget_line` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `budget_id` BIGINT UNSIGNED NOT NULL,
    `budget_head_id` BIGINT UNSIGNED NOT NULL,
    `cost_centre_id` BIGINT UNSIGNED NULL,
    `estate_id` BIGINT UNSIGNED NULL,
    -- HAND-EDIT: head and cost centre, NULL-safe, so ux_budget_line holds one line each (D-3.06-2).
    `line_key` VARCHAR(50) GENERATED ALWAYS AS (CONCAT(`budget_head_id`, ':', IFNULL(`cost_centre_id`, 0))) STORED,
    `annual_amount` DECIMAL(18, 4) NOT NULL,
    `committed_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `actual_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    -- HAND-EDIT: annual − actual − committed, derived and never editable (P3 §26.4).
    `available_amount` DECIMAL(18, 4) GENERATED ALWAYS AS (`annual_amount` - `actual_amount` - `committed_amount`) STORED,
    `utilisation_percentage` DECIMAL(9, 4) NOT NULL DEFAULT 0,
    `notes` VARCHAR(300) NULL,
    `sequence` INTEGER NOT NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_budget_line_head`(`budget_head_id`),
    INDEX `ix_budget_line_cost_centre`(`cost_centre_id`),
    INDEX `ix_budget_line_estate`(`estate_id`),
    INDEX `ix_budget_line_available`(`available_amount`),
    INDEX `ix_budget_line_created_by`(`created_by`),
    INDEX `ix_budget_line_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_budget_line`(`budget_id`, `line_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `budget_allocation` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `budget_line_id` BIGINT UNSIGNED NOT NULL,
    `month_number` TINYINT NOT NULL,
    `accounting_period_id` BIGINT UNSIGNED NOT NULL,
    `amount` DECIMAL(18, 4) NOT NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,

    INDEX `ix_budget_allocation_period`(`accounting_period_id`),
    INDEX `ix_budget_allocation_created_by`(`created_by`),
    UNIQUE INDEX `ux_budget_allocation`(`budget_line_id`, `month_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `budget_consumption` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `budget_line_id` BIGINT UNSIGNED NOT NULL,
    `consumption_type` VARCHAR(30) NOT NULL,
    `source_type` VARCHAR(40) NOT NULL,
    `source_id` BIGINT UNSIGNED NOT NULL,
    `consumption_date` DATE NOT NULL,
    `accounting_period_id` BIGINT UNSIGNED NOT NULL,
    `amount` DECIMAL(18, 4) NOT NULL,
    `releases_id` BIGINT UNSIGNED NULL,
    `released_by_id` BIGINT UNSIGNED NULL,
    `reversal_of_id` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,

    INDEX `ix_budget_consumption_type`(`consumption_type`),
    INDEX `ix_budget_consumption_source`(`source_type`, `source_id`),
    INDEX `ix_budget_consumption_date`(`consumption_date`),
    INDEX `ix_budget_consumption_period`(`accounting_period_id`),
    INDEX `ix_budget_consumption_releases`(`releases_id`),
    INDEX `ix_budget_consumption_released_by`(`released_by_id`),
    INDEX `ix_budget_consumption_reversal_of`(`reversal_of_id`),
    INDEX `ix_budget_consumption_created_by`(`created_by`),
    UNIQUE INDEX `ux_budget_consumption`(`budget_line_id`, `consumption_type`, `source_type`, `source_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `budget_control` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `budget_head_id` BIGINT UNSIGNED NULL,
    `estate_id` BIGINT UNSIGNED NULL,
    `fiscal_year_id` BIGINT UNSIGNED NULL,
    `control_mode` VARCHAR(30) NOT NULL DEFAULT 'warn',
    `warning_threshold_percentage` DECIMAL(9, 4) NULL,
    `critical_threshold_percentage` DECIMAL(9, 4) NULL,
    `overrun_tolerance_percentage` DECIMAL(9, 4) NULL,
    `escalation_role_id` BIGINT UNSIGNED NULL,
    `supersedes_id` BIGINT UNSIGNED NULL,
    -- HAND-EDIT: head, estate and fiscal year while active, else NULL (D-3.06-10).
    `active_key` VARCHAR(70) GENERATED ALWAYS AS (IF(`state` = 'active', CONCAT(IFNULL(`budget_head_id`, 0), ':', IFNULL(`estate_id`, 0), ':', IFNULL(`fiscal_year_id`, 0)), NULL)) STORED,
    `state` VARCHAR(30) NOT NULL DEFAULT 'draft',
    `state_changed_at` DATETIME(0) NULL,
    `submitted_at` DATETIME(0) NULL,
    `submitted_by` BIGINT UNSIGNED NULL,
    `approved_at` DATETIME(0) NULL,
    `approved_by` BIGINT UNSIGNED NULL,
    `rejected_at` DATETIME(0) NULL,
    `rejected_by` BIGINT UNSIGNED NULL,
    `rejection_reason` VARCHAR(500) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_budget_control_head`(`budget_head_id`),
    INDEX `ix_budget_control_estate`(`estate_id`),
    INDEX `ix_budget_control_fiscal_year`(`fiscal_year_id`),
    INDEX `ix_budget_control_escalation_role`(`escalation_role_id`),
    INDEX `ix_budget_control_supersedes`(`supersedes_id`),
    INDEX `ix_budget_control_state`(`state`),
    INDEX `ix_budget_control_submitted_by`(`submitted_by`),
    INDEX `ix_budget_control_approved_by`(`approved_by`),
    INDEX `ix_budget_control_rejected_by`(`rejected_by`),
    INDEX `ix_budget_control_created_by`(`created_by`),
    INDEX `ix_budget_control_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_budget_control_active`(`active_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `budget_position_summary` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `budget_line_id` BIGINT UNSIGNED NOT NULL,
    `accounting_period_id` BIGINT UNSIGNED NOT NULL,
    `allocated_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `committed_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `actual_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `updated_at` DATETIME(0) NULL,

    INDEX `ix_budget_position_period`(`accounting_period_id`),
    UNIQUE INDEX `ux_budget_position`(`budget_line_id`, `accounting_period_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `budget` ADD CONSTRAINT `fk_budget_fiscal_year` FOREIGN KEY (`fiscal_year_id`) REFERENCES `fiscal_year`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget` ADD CONSTRAINT `fk_budget_estate` FOREIGN KEY (`estate_id`) REFERENCES `estate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget` ADD CONSTRAINT `fk_budget_department` FOREIGN KEY (`department_id`) REFERENCES `department`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget` ADD CONSTRAINT `fk_budget_supersedes` FOREIGN KEY (`supersedes_id`) REFERENCES `budget`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget` ADD CONSTRAINT `fk_budget_submitted_by` FOREIGN KEY (`submitted_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget` ADD CONSTRAINT `fk_budget_approved_by` FOREIGN KEY (`approved_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget` ADD CONSTRAINT `fk_budget_rejected_by` FOREIGN KEY (`rejected_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget` ADD CONSTRAINT `fk_budget_activated_by` FOREIGN KEY (`activated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget` ADD CONSTRAINT `fk_budget_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget` ADD CONSTRAINT `fk_budget_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget_line` ADD CONSTRAINT `fk_budget_line_budget` FOREIGN KEY (`budget_id`) REFERENCES `budget`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget_line` ADD CONSTRAINT `fk_budget_line_head` FOREIGN KEY (`budget_head_id`) REFERENCES `budget_head`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget_line` ADD CONSTRAINT `fk_budget_line_cost_centre` FOREIGN KEY (`cost_centre_id`) REFERENCES `cost_centre`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget_line` ADD CONSTRAINT `fk_budget_line_estate` FOREIGN KEY (`estate_id`) REFERENCES `estate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget_line` ADD CONSTRAINT `fk_budget_line_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget_line` ADD CONSTRAINT `fk_budget_line_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget_allocation` ADD CONSTRAINT `fk_budget_allocation_line` FOREIGN KEY (`budget_line_id`) REFERENCES `budget_line`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget_allocation` ADD CONSTRAINT `fk_budget_allocation_period` FOREIGN KEY (`accounting_period_id`) REFERENCES `accounting_period`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget_allocation` ADD CONSTRAINT `fk_budget_allocation_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget_consumption` ADD CONSTRAINT `fk_budget_consumption_line` FOREIGN KEY (`budget_line_id`) REFERENCES `budget_line`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget_consumption` ADD CONSTRAINT `fk_budget_consumption_period` FOREIGN KEY (`accounting_period_id`) REFERENCES `accounting_period`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget_consumption` ADD CONSTRAINT `fk_budget_consumption_releases` FOREIGN KEY (`releases_id`) REFERENCES `budget_consumption`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget_consumption` ADD CONSTRAINT `fk_budget_consumption_released_by` FOREIGN KEY (`released_by_id`) REFERENCES `budget_consumption`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget_consumption` ADD CONSTRAINT `fk_budget_consumption_reversal_of` FOREIGN KEY (`reversal_of_id`) REFERENCES `budget_consumption`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget_consumption` ADD CONSTRAINT `fk_budget_consumption_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget_control` ADD CONSTRAINT `fk_budget_control_head` FOREIGN KEY (`budget_head_id`) REFERENCES `budget_head`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget_control` ADD CONSTRAINT `fk_budget_control_estate` FOREIGN KEY (`estate_id`) REFERENCES `estate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget_control` ADD CONSTRAINT `fk_budget_control_fiscal_year` FOREIGN KEY (`fiscal_year_id`) REFERENCES `fiscal_year`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget_control` ADD CONSTRAINT `fk_budget_control_escalation_role` FOREIGN KEY (`escalation_role_id`) REFERENCES `role`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget_control` ADD CONSTRAINT `fk_budget_control_supersedes` FOREIGN KEY (`supersedes_id`) REFERENCES `budget_control`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget_control` ADD CONSTRAINT `fk_budget_control_submitted_by` FOREIGN KEY (`submitted_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget_control` ADD CONSTRAINT `fk_budget_control_approved_by` FOREIGN KEY (`approved_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget_control` ADD CONSTRAINT `fk_budget_control_rejected_by` FOREIGN KEY (`rejected_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget_control` ADD CONSTRAINT `fk_budget_control_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget_control` ADD CONSTRAINT `fk_budget_control_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget_position_summary` ADD CONSTRAINT `fk_budget_position_line` FOREIGN KEY (`budget_line_id`) REFERENCES `budget_line`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `budget_position_summary` ADD CONSTRAINT `fk_budget_position_period` FOREIGN KEY (`accounting_period_id`) REFERENCES `accounting_period`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- HAND-EDIT: CHECK constraints (prisma/README.md). P3 §26.3–§26.6; D-3.06-1 to D-3.06-10.
ALTER TABLE `budget`
  ADD CONSTRAINT `ck_budget_type` CHECK (`budget_type` IN ('operating', 'capital')),
  ADD CONSTRAINT `ck_budget_state` CHECK (`state` IN ('draft', 'submitted', 'approved', 'rejected', 'active', 'superseded')),
  ADD CONSTRAINT `ck_budget_revision` CHECK (`revision_number` >= 0 AND (`revision_number` = 0) = (`supersedes_id` IS NULL)),
  ADD CONSTRAINT `ck_budget_total` CHECK (`total_amount` >= 0);
ALTER TABLE `budget_line`
  ADD CONSTRAINT `ck_budget_line_amounts` CHECK (`annual_amount` > 0 AND `committed_amount` >= 0 AND `actual_amount` >= 0),
  ADD CONSTRAINT `ck_budget_line_sequence` CHECK (`sequence` > 0);
ALTER TABLE `budget_allocation`
  ADD CONSTRAINT `ck_budget_allocation_month` CHECK (`month_number` BETWEEN 1 AND 12),
  ADD CONSTRAINT `ck_budget_allocation_amount` CHECK (`amount` >= 0);
ALTER TABLE `budget_consumption`
  ADD CONSTRAINT `ck_budget_consumption_type` CHECK (`consumption_type` IN ('commitment', 'actual', 'commitment_release')),
  ADD CONSTRAINT `ck_budget_consumption_source` CHECK (`source_type` IN ('purchase_order', 'supplier_invoice', 'payroll_run', 'welfare_case', 'training_program', 'journal')),
  ADD CONSTRAINT `ck_budget_consumption_amount` CHECK (`amount` > 0),
  -- Only a release names the commitment it releases; only a commitment is released.
  ADD CONSTRAINT `ck_budget_consumption_releases` CHECK ((`consumption_type` = 'commitment_release') = (`releases_id` IS NOT NULL) OR `reversal_of_id` IS NOT NULL),
  ADD CONSTRAINT `ck_budget_consumption_released_by` CHECK (`released_by_id` IS NULL OR `consumption_type` = 'commitment');
ALTER TABLE `budget_control`
  ADD CONSTRAINT `ck_budget_control_mode` CHECK (`control_mode` IN ('none', 'warn', 'require_approval', 'block')),
  ADD CONSTRAINT `ck_budget_control_state` CHECK (`state` IN ('draft', 'submitted', 'active', 'rejected', 'superseded')),
  ADD CONSTRAINT `ck_budget_control_thresholds` CHECK (
    (`warning_threshold_percentage` IS NULL OR `warning_threshold_percentage` > 0)
    AND (`critical_threshold_percentage` IS NULL OR `critical_threshold_percentage` > 0)
    AND (`warning_threshold_percentage` IS NULL OR `critical_threshold_percentage` IS NULL
         OR `critical_threshold_percentage` >= `warning_threshold_percentage`)
    AND (`overrun_tolerance_percentage` IS NULL OR `overrun_tolerance_percentage` >= 0));
ALTER TABLE `budget_position_summary`
  ADD CONSTRAINT `ck_budget_position_amounts` CHECK (`allocated_amount` >= 0 AND `committed_amount` >= 0 AND `actual_amount` >= 0);

-- HAND-EDIT: per-table rights for the app account. Drafts (budgets, controls) change and may be deleted, their
-- lines and allocations go with them; a line's figures and its monthly position are kept by core/budget.
-- budget_consumption is insert-only except released_by_id on a commitment (D-3.06-6): UPDATE is granted for
-- that column only.
GRANT UPDATE, DELETE ON `budget` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `budget_line` TO 'rupai_app'@'%';
GRANT DELETE ON `budget_allocation` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `budget_control` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `budget_position_summary` TO 'rupai_app'@'%';
GRANT UPDATE (`released_by_id`) ON `budget_consumption` TO 'rupai_app'@'%';

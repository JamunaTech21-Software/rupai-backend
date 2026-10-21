-- CreateTable
CREATE TABLE `benefit_type` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `description` VARCHAR(500) NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `is_system` BOOLEAN NOT NULL DEFAULT false,
    `benefit_category` VARCHAR(30) NOT NULL,
    `issue_frequency` VARCHAR(30) NULL,
    `default_employer_cost` DECIMAL(18, 4) NULL,
    `uom_id` BIGINT UNSIGNED NULL,
    `payroll_treatment` VARCHAR(30) NOT NULL DEFAULT 'not_payroll',
    `component_type_id` BIGINT UNSIGNED NULL,
    `expense_account_id` BIGINT UNSIGNED NULL,
    `status` VARCHAR(30) NOT NULL DEFAULT 'active',
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_benefit_type_category`(`benefit_category`),
    INDEX `ix_benefit_type_uom`(`uom_id`),
    INDEX `ix_benefit_type_status`(`status`),
    INDEX `ix_benefit_type_created_by`(`created_by`),
    INDEX `ix_benefit_type_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_benefit_type_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `benefit_entitlement` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `employment_profile_id` BIGINT UNSIGNED NOT NULL,
    `estate_id` BIGINT UNSIGNED NOT NULL,
    `benefit_type_id` BIGINT UNSIGNED NOT NULL,
    `effective_from` DATE NOT NULL,
    `effective_to` DATE NULL,
    `quantity_per_period` DECIMAL(14, 3) NULL,
    `employer_cost_per_period` DECIMAL(18, 4) NULL,
    `employee_contribution` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `allocation_reference` VARCHAR(50) NULL,
    `issuing_office` VARCHAR(150) NULL,
    `land_allocation_id` BIGINT UNSIGNED NULL,
    `withdrawal_reason` VARCHAR(300) NULL,
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

    INDEX `ix_benefit_entitlement_estate`(`estate_id`),
    INDEX `ix_benefit_entitlement_type`(`benefit_type_id`),
    INDEX `ix_benefit_entitlement_from`(`effective_from`),
    INDEX `ix_benefit_entitlement_to`(`effective_to`),
    INDEX `ix_benefit_entitlement_state`(`state`),
    INDEX `ix_benefit_entitlement_created_by`(`created_by`),
    INDEX `ix_benefit_entitlement_updated_by`(`updated_by`),
    INDEX `ix_benefit_entitlement_submitted_by`(`submitted_by`),
    INDEX `ix_benefit_entitlement_approved_by`(`approved_by`),
    INDEX `ix_benefit_entitlement_rejected_by`(`rejected_by`),
    UNIQUE INDEX `ux_benefit_entitlement`(`employment_profile_id`, `benefit_type_id`, `effective_from`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `benefit_issue` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `benefit_entitlement_id` BIGINT UNSIGNED NOT NULL,
    `estate_id` BIGINT UNSIGNED NOT NULL,
    `issue_date` DATE NOT NULL,
    `period_reference` VARCHAR(30) NULL,
    `quantity` DECIMAL(14, 3) NULL,
    `employer_cost` DECIMAL(18, 4) NOT NULL,
    `employee_contribution` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `stock_movement_id` BIGINT UNSIGNED NULL,
    `payroll_component_id` BIGINT UNSIGNED NULL,
    `issued_by_profile_id` BIGINT UNSIGNED NULL,
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

    INDEX `ix_benefit_issue_estate`(`estate_id`),
    INDEX `ix_benefit_issue_date`(`issue_date`),
    INDEX `ix_benefit_issue_state`(`state`),
    INDEX `ix_benefit_issue_issued_by`(`issued_by_profile_id`),
    INDEX `ix_benefit_issue_created_by`(`created_by`),
    INDEX `ix_benefit_issue_updated_by`(`updated_by`),
    INDEX `ix_benefit_issue_submitted_by`(`submitted_by`),
    INDEX `ix_benefit_issue_approved_by`(`approved_by`),
    INDEX `ix_benefit_issue_rejected_by`(`rejected_by`),
    UNIQUE INDEX `ux_benefit_issue`(`benefit_entitlement_id`, `issue_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `welfare_case` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `case_number` VARCHAR(30) NOT NULL,
    `estate_id` BIGINT UNSIGNED NOT NULL,
    `beneficiary_type` VARCHAR(30) NOT NULL,
    `beneficiary_id` BIGINT UNSIGNED NULL,
    `welfare_category` VARCHAR(30) NOT NULL,
    `case_date` DATE NOT NULL,
    `description` VARCHAR(500) NOT NULL,
    `requested_amount` DECIMAL(18, 4) NULL,
    `approved_amount` DECIMAL(18, 4) NULL,
    `disbursed_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `budget_head_id` BIGINT UNSIGNED NULL,
    `outcome` VARCHAR(500) NULL,
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

    INDEX `ix_welfare_case_estate`(`estate_id`),
    INDEX `ix_welfare_case_beneficiary`(`beneficiary_type`, `beneficiary_id`),
    INDEX `ix_welfare_case_category`(`welfare_category`),
    INDEX `ix_welfare_case_date`(`case_date`),
    INDEX `ix_welfare_case_state`(`state`),
    INDEX `ix_welfare_case_created_by`(`created_by`),
    INDEX `ix_welfare_case_updated_by`(`updated_by`),
    INDEX `ix_welfare_case_submitted_by`(`submitted_by`),
    INDEX `ix_welfare_case_approved_by`(`approved_by`),
    INDEX `ix_welfare_case_rejected_by`(`rejected_by`),
    UNIQUE INDEX `ux_welfare_case_number`(`case_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `benefit_type` ADD CONSTRAINT `fk_benefit_type_uom` FOREIGN KEY (`uom_id`) REFERENCES `uom`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `benefit_type` ADD CONSTRAINT `fk_benefit_type_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `benefit_type` ADD CONSTRAINT `fk_benefit_type_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `benefit_entitlement` ADD CONSTRAINT `fk_benefit_entitlement_profile` FOREIGN KEY (`employment_profile_id`) REFERENCES `employment_profile`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `benefit_entitlement` ADD CONSTRAINT `fk_benefit_entitlement_type` FOREIGN KEY (`benefit_type_id`) REFERENCES `benefit_type`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `benefit_entitlement` ADD CONSTRAINT `fk_benefit_entitlement_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `benefit_entitlement` ADD CONSTRAINT `fk_benefit_entitlement_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `benefit_entitlement` ADD CONSTRAINT `fk_benefit_entitlement_submitted_by` FOREIGN KEY (`submitted_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `benefit_entitlement` ADD CONSTRAINT `fk_benefit_entitlement_approved_by` FOREIGN KEY (`approved_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `benefit_entitlement` ADD CONSTRAINT `fk_benefit_entitlement_rejected_by` FOREIGN KEY (`rejected_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `benefit_issue` ADD CONSTRAINT `fk_benefit_issue_entitlement` FOREIGN KEY (`benefit_entitlement_id`) REFERENCES `benefit_entitlement`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `benefit_issue` ADD CONSTRAINT `fk_benefit_issue_issued_by` FOREIGN KEY (`issued_by_profile_id`) REFERENCES `employment_profile`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `benefit_issue` ADD CONSTRAINT `fk_benefit_issue_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `benefit_issue` ADD CONSTRAINT `fk_benefit_issue_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `benefit_issue` ADD CONSTRAINT `fk_benefit_issue_submitted_by` FOREIGN KEY (`submitted_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `benefit_issue` ADD CONSTRAINT `fk_benefit_issue_approved_by` FOREIGN KEY (`approved_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `benefit_issue` ADD CONSTRAINT `fk_benefit_issue_rejected_by` FOREIGN KEY (`rejected_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `welfare_case` ADD CONSTRAINT `fk_welfare_case_estate` FOREIGN KEY (`estate_id`) REFERENCES `estate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `welfare_case` ADD CONSTRAINT `fk_welfare_case_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `welfare_case` ADD CONSTRAINT `fk_welfare_case_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `welfare_case` ADD CONSTRAINT `fk_welfare_case_submitted_by` FOREIGN KEY (`submitted_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `welfare_case` ADD CONSTRAINT `fk_welfare_case_approved_by` FOREIGN KEY (`approved_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `welfare_case` ADD CONSTRAINT `fk_welfare_case_rejected_by` FOREIGN KEY (`rejected_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- HAND-EDIT: CHECK constraints (prisma/README.md).
ALTER TABLE `benefit_type`
  ADD CONSTRAINT `ck_benefit_type_category` CHECK (`benefit_category` IN
    ('housing', 'medical', 'transport', 'ration', 'education', 'utility', 'other')),
  ADD CONSTRAINT `ck_benefit_type_frequency` CHECK (`issue_frequency` IS NULL OR `issue_frequency` IN
    ('one_time', 'weekly', 'monthly', 'quarterly', 'annual', 'on_demand')),
  ADD CONSTRAINT `ck_benefit_type_cost` CHECK (`default_employer_cost` IS NULL OR `default_employer_cost` >= 0),
  ADD CONSTRAINT `ck_benefit_type_status` CHECK (`status` IN ('active', 'inactive')),
  -- P3 §23.1: a benefit becomes a payroll earning only by explicit configuration, with its component type.
  ADD CONSTRAINT `ck_benefit_type_payroll` CHECK (
    `payroll_treatment` IN ('not_payroll', 'taxable_perquisite', 'cash_component')
    AND (`payroll_treatment` = 'not_payroll' OR `component_type_id` IS NOT NULL));
ALTER TABLE `benefit_entitlement`
  ADD CONSTRAINT `ck_benefit_entitlement_dates` CHECK (`effective_to` IS NULL OR `effective_to` >= `effective_from`),
  ADD CONSTRAINT `ck_benefit_entitlement_amounts` CHECK (
    (`quantity_per_period` IS NULL OR `quantity_per_period` >= 0)
    AND (`employer_cost_per_period` IS NULL OR `employer_cost_per_period` >= 0) AND `employee_contribution` >= 0),
  ADD CONSTRAINT `ck_benefit_entitlement_state` CHECK (`state` IN ('draft', 'submitted', 'approved', 'rejected', 'withdrawn')),
  ADD CONSTRAINT `ck_benefit_entitlement_approval` CHECK (
    (`state` = 'draft' OR `submitted_at` IS NOT NULL)
    AND ((`state` IN ('approved', 'withdrawn')) = (`approved_at` IS NOT NULL))
    AND ((`state` = 'rejected') = (`rejected_at` IS NOT NULL AND `rejection_reason` IS NOT NULL))
    AND ((`state` = 'withdrawn') = (`withdrawal_reason` IS NOT NULL)));
ALTER TABLE `benefit_issue`
  ADD CONSTRAINT `ck_benefit_issue_amounts` CHECK (
    (`quantity` IS NULL OR `quantity` >= 0) AND `employer_cost` >= 0 AND `employee_contribution` >= 0),
  ADD CONSTRAINT `ck_benefit_issue_state` CHECK (`state` IN ('draft', 'submitted', 'approved', 'rejected')),
  ADD CONSTRAINT `ck_benefit_issue_approval` CHECK (
    (`state` = 'draft' OR `submitted_at` IS NOT NULL)
    AND ((`state` = 'approved') = (`approved_at` IS NOT NULL))
    AND ((`state` = 'rejected') = (`rejected_at` IS NOT NULL AND `rejection_reason` IS NOT NULL)));
ALTER TABLE `welfare_case`
  ADD CONSTRAINT `ck_welfare_case_beneficiary` CHECK (
    (`beneficiary_type` IN ('employment_profile', 'person') AND `beneficiary_id` IS NOT NULL)
    OR (`beneficiary_type` = 'community' AND `beneficiary_id` IS NULL)),
  ADD CONSTRAINT `ck_welfare_case_category` CHECK (`welfare_category` IN
    ('medical', 'education', 'disaster', 'bereavement', 'community', 'other')),
  ADD CONSTRAINT `ck_welfare_case_amounts` CHECK (
    (`requested_amount` IS NULL OR `requested_amount` >= 0) AND (`approved_amount` IS NULL OR `approved_amount` >= 0)
    AND `disbursed_amount` >= 0 AND (`approved_amount` IS NULL OR `disbursed_amount` <= `approved_amount`)),
  ADD CONSTRAINT `ck_welfare_case_state` CHECK (`state` IN ('draft', 'submitted', 'approved', 'rejected', 'closed')),
  ADD CONSTRAINT `ck_welfare_case_approval` CHECK (
    (`state` = 'draft' OR `submitted_at` IS NOT NULL)
    AND ((`state` IN ('approved', 'closed')) = (`approved_at` IS NOT NULL))
    AND ((`state` = 'rejected') = (`rejected_at` IS NOT NULL AND `rejection_reason` IS NOT NULL)));

-- HAND-EDIT: per-table rights for the app account. Benefit types are a reference list; entitlements,
-- issues and cases change state and only drafts are deleted.
GRANT UPDATE, DELETE ON `benefit_type` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `benefit_entitlement` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `benefit_issue` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `welfare_case` TO 'rupai_app'@'%';

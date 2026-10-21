-- AlterTable
ALTER TABLE `leave_type` ADD COLUMN `allows_negative_balance` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `annual_days` DECIMAL(9, 4) NULL,
    ADD COLUMN `applies_to` VARCHAR(30) NOT NULL DEFAULT 'all',
    ADD COLUMN `carry_forward_limit_days` DECIMAL(9, 4) NOT NULL DEFAULT 0,
    ADD COLUMN `is_paid` BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE `leave_entitlement` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `employment_profile_id` BIGINT UNSIGNED NOT NULL,
    `leave_type_id` BIGINT UNSIGNED NOT NULL,
    `fiscal_year_id` BIGINT UNSIGNED NOT NULL,
    `statutory_rule_id` BIGINT UNSIGNED NULL,
    `entitled_days` DECIMAL(9, 4) NOT NULL,
    `carried_forward_days` DECIMAL(9, 4) NOT NULL DEFAULT 0,
    `adjustment_days` DECIMAL(9, 4) NOT NULL DEFAULT 0,
    `adjustment_reason` VARCHAR(300) NULL,
    `consumed_days` DECIMAL(9, 4) NOT NULL DEFAULT 0,
    `encashed_days` DECIMAL(9, 4) NOT NULL DEFAULT 0,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_leave_entitlement_type`(`leave_type_id`),
    INDEX `ix_leave_entitlement_fiscal_year`(`fiscal_year_id`),
    INDEX `ix_leave_entitlement_created_by`(`created_by`),
    INDEX `ix_leave_entitlement_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_leave_entitlement`(`employment_profile_id`, `leave_type_id`, `fiscal_year_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leave_request` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `employment_profile_id` BIGINT UNSIGNED NOT NULL,
    `estate_id` BIGINT UNSIGNED NOT NULL,
    `leave_type_id` BIGINT UNSIGNED NOT NULL,
    `request_number` VARCHAR(30) NOT NULL,
    `from_date` DATE NOT NULL,
    `to_date` DATE NOT NULL,
    `day_count` DECIMAL(9, 4) NOT NULL,
    `is_half_day` BOOLEAN NOT NULL DEFAULT false,
    `reason` VARCHAR(500) NULL,
    `contact_during_leave` VARCHAR(30) NULL,
    `covering_profile_id` BIGINT UNSIGNED NULL,
    `leave_entitlement_id` BIGINT UNSIGNED NULL,
    `is_paid` BOOLEAN NOT NULL DEFAULT true,
    `state` VARCHAR(30) NOT NULL DEFAULT 'draft',
    `state_changed_at` DATETIME(0) NULL,
    `cancelled_at` DATETIME(0) NULL,
    `cancelled_by` BIGINT UNSIGNED NULL,
    `cancellation_reason` VARCHAR(500) NULL,
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

    INDEX `ix_leave_request_profile`(`employment_profile_id`, `from_date`),
    INDEX `ix_leave_request_estate`(`estate_id`),
    INDEX `ix_leave_request_type`(`leave_type_id`),
    INDEX `ix_leave_request_from`(`from_date`),
    INDEX `ix_leave_request_to`(`to_date`),
    INDEX `ix_leave_request_state`(`state`),
    INDEX `ix_leave_request_covering`(`covering_profile_id`),
    INDEX `ix_leave_request_entitlement`(`leave_entitlement_id`),
    INDEX `ix_leave_request_created_by`(`created_by`),
    INDEX `ix_leave_request_updated_by`(`updated_by`),
    INDEX `ix_leave_request_submitted_by`(`submitted_by`),
    INDEX `ix_leave_request_approved_by`(`approved_by`),
    INDEX `ix_leave_request_rejected_by`(`rejected_by`),
    INDEX `ix_leave_request_cancelled_by`(`cancelled_by`),
    UNIQUE INDEX `ux_leave_request_number`(`request_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `leave_entitlement` ADD CONSTRAINT `fk_leave_entitlement_profile` FOREIGN KEY (`employment_profile_id`) REFERENCES `employment_profile`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `leave_entitlement` ADD CONSTRAINT `fk_leave_entitlement_type` FOREIGN KEY (`leave_type_id`) REFERENCES `leave_type`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `leave_entitlement` ADD CONSTRAINT `fk_leave_entitlement_fiscal_year` FOREIGN KEY (`fiscal_year_id`) REFERENCES `fiscal_year`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `leave_entitlement` ADD CONSTRAINT `fk_leave_entitlement_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `leave_entitlement` ADD CONSTRAINT `fk_leave_entitlement_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `leave_request` ADD CONSTRAINT `fk_leave_request_profile` FOREIGN KEY (`employment_profile_id`) REFERENCES `employment_profile`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `leave_request` ADD CONSTRAINT `fk_leave_request_estate` FOREIGN KEY (`estate_id`) REFERENCES `estate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `leave_request` ADD CONSTRAINT `fk_leave_request_type` FOREIGN KEY (`leave_type_id`) REFERENCES `leave_type`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `leave_request` ADD CONSTRAINT `fk_leave_request_covering` FOREIGN KEY (`covering_profile_id`) REFERENCES `employment_profile`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `leave_request` ADD CONSTRAINT `fk_leave_request_entitlement` FOREIGN KEY (`leave_entitlement_id`) REFERENCES `leave_entitlement`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `leave_request` ADD CONSTRAINT `fk_leave_request_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `leave_request` ADD CONSTRAINT `fk_leave_request_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `leave_request` ADD CONSTRAINT `fk_leave_request_submitted_by` FOREIGN KEY (`submitted_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `leave_request` ADD CONSTRAINT `fk_leave_request_approved_by` FOREIGN KEY (`approved_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `leave_request` ADD CONSTRAINT `fk_leave_request_rejected_by` FOREIGN KEY (`rejected_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `leave_request` ADD CONSTRAINT `fk_leave_request_cancelled_by` FOREIGN KEY (`cancelled_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- HAND-EDIT: CHECK constraints (prisma/README.md).
ALTER TABLE `leave_type`
  ADD CONSTRAINT `ck_leave_type_days` CHECK ((`annual_days` IS NULL OR `annual_days` >= 0) AND `carry_forward_limit_days` >= 0),
  ADD CONSTRAINT `ck_leave_type_applies_to` CHECK (`applies_to` IN ('all', 'worker', 'employee'));
ALTER TABLE `leave_entitlement`
  ADD CONSTRAINT `ck_leave_entitlement_days` CHECK (
    `entitled_days` >= 0 AND `carried_forward_days` >= 0 AND `consumed_days` >= 0 AND `encashed_days` >= 0),
  -- P3 §22.1: a non-zero adjustment carries its reason.
  ADD CONSTRAINT `ck_leave_entitlement_adjustment` CHECK (`adjustment_days` = 0 OR `adjustment_reason` IS NOT NULL);
ALTER TABLE `leave_request`
  ADD CONSTRAINT `ck_leave_request_dates` CHECK (`to_date` >= `from_date`),
  ADD CONSTRAINT `ck_leave_request_days` CHECK (`day_count` > 0),
  ADD CONSTRAINT `ck_leave_request_half_day` CHECK (`is_half_day` = 0 OR (`from_date` = `to_date` AND `day_count` = 0.5)),
  ADD CONSTRAINT `ck_leave_request_state` CHECK (`state` IN ('draft', 'submitted', 'approved', 'rejected', 'cancelled')),
  ADD CONSTRAINT `ck_leave_request_approval` CHECK (
    (`state` = 'draft' OR `submitted_at` IS NOT NULL)
    AND ((`state` = 'rejected') = (`rejected_at` IS NOT NULL AND `rejection_reason` IS NOT NULL))
    AND ((`state` = 'cancelled') = (`cancelled_at` IS NOT NULL)));

-- HAND-EDIT: per-table rights for the app account. Entitlements are adjusted and consumed; requests
-- change state, and only a draft is deleted.
GRANT UPDATE, DELETE ON `leave_entitlement` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `leave_request` TO 'rupai_app'@'%';

-- CreateTable
CREATE TABLE `supplier` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `business_type` VARCHAR(30) NOT NULL,
    `contact_person` VARCHAR(150) NULL,
    `phone` VARCHAR(30) NULL,
    `email` VARCHAR(150) NULL,
    `address_line1` VARCHAR(200) NULL,
    `tin` VARCHAR(30) NULL,
    `vat_registration` VARCHAR(30) NULL,
    `bank_name` VARCHAR(150) NULL,
    `bank_branch` VARCHAR(150) NULL,
    `bank_account_name` VARCHAR(150) NULL,
    `bank_account_number` VARCHAR(40) NULL,
    `bank_routing_number` VARCHAR(20) NULL,
    `bank_details_changed_at` DATETIME(0) NULL,
    `payment_terms_days` SMALLINT UNSIGNED NULL,
    `is_approved_supplier` BOOLEAN NOT NULL DEFAULT false,
    `status` VARCHAR(30) NOT NULL DEFAULT 'active',
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_supplier_name`(`name`),
    INDEX `ix_supplier_business_type`(`business_type`),
    INDEX `ix_supplier_status`(`status`),
    INDEX `ix_supplier_created_by`(`created_by`),
    INDEX `ix_supplier_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_supplier_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `supplier_bank_change` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `supplier_id` BIGINT UNSIGNED NOT NULL,
    `bank_name` VARCHAR(150) NOT NULL,
    `bank_branch` VARCHAR(150) NULL,
    `bank_account_name` VARCHAR(150) NULL,
    `bank_account_number` VARCHAR(40) NOT NULL,
    `bank_routing_number` VARCHAR(20) NULL,
    `previous_bank_name` VARCHAR(150) NULL,
    `previous_bank_branch` VARCHAR(150) NULL,
    `previous_bank_account_name` VARCHAR(150) NULL,
    `previous_bank_account_number` VARCHAR(40) NULL,
    `previous_bank_routing_number` VARCHAR(20) NULL,
    `reason` VARCHAR(500) NOT NULL,
    `state` VARCHAR(30) NOT NULL DEFAULT 'draft',
    `state_changed_at` DATETIME(0) NULL,
    `submitted_at` DATETIME(0) NULL,
    `submitted_by` BIGINT UNSIGNED NULL,
    `approved_at` DATETIME(0) NULL,
    `approved_by` BIGINT UNSIGNED NULL,
    `rejected_at` DATETIME(0) NULL,
    `rejected_by` BIGINT UNSIGNED NULL,
    `rejection_reason` VARCHAR(500) NULL,
    -- HAND-EDIT: generated: one open (draft or submitted) change per supplier.
    `open_key` BIGINT UNSIGNED GENERATED ALWAYS AS (CASE WHEN `state` IN ('draft', 'submitted') THEN `supplier_id` END) STORED,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_supplier_bank_change_supplier`(`supplier_id`),
    INDEX `ix_supplier_bank_change_state`(`state`),
    INDEX `ix_supplier_bank_change_created_by`(`created_by`),
    INDEX `ix_supplier_bank_change_updated_by`(`updated_by`),
    INDEX `ix_supplier_bank_change_submitted_by`(`submitted_by`),
    INDEX `ix_supplier_bank_change_approved_by`(`approved_by`),
    INDEX `ix_supplier_bank_change_rejected_by`(`rejected_by`),
    UNIQUE INDEX `ux_supplier_bank_change_open`(`open_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `supplier` ADD CONSTRAINT `fk_supplier_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `supplier` ADD CONSTRAINT `fk_supplier_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `supplier_bank_change` ADD CONSTRAINT `fk_supplier_bank_change_supplier` FOREIGN KEY (`supplier_id`) REFERENCES `supplier`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `supplier_bank_change` ADD CONSTRAINT `fk_supplier_bank_change_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `supplier_bank_change` ADD CONSTRAINT `fk_supplier_bank_change_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `supplier_bank_change` ADD CONSTRAINT `fk_supplier_bank_change_submitted_by` FOREIGN KEY (`submitted_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `supplier_bank_change` ADD CONSTRAINT `fk_supplier_bank_change_approved_by` FOREIGN KEY (`approved_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `supplier_bank_change` ADD CONSTRAINT `fk_supplier_bank_change_rejected_by` FOREIGN KEY (`rejected_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- HAND-EDIT: CHECK constraints (prisma/README.md).
ALTER TABLE `supplier`
  ADD CONSTRAINT `ck_supplier_business_type` CHECK (`business_type` IN
    ('manufacturer', 'distributor', 'retailer', 'service', 'contractor')),
  ADD CONSTRAINT `ck_supplier_payment_terms` CHECK (`payment_terms_days` IS NULL OR `payment_terms_days` <= 365),
  ADD CONSTRAINT `ck_supplier_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `supplier_bank_change`
  ADD CONSTRAINT `ck_supplier_bank_change_state` CHECK (`state` IN ('draft', 'submitted', 'approved', 'rejected')),
  ADD CONSTRAINT `ck_supplier_bank_change_approval` CHECK (
    (`state` = 'draft' OR `submitted_at` IS NOT NULL)
    AND ((`state` = 'approved') = (`approved_at` IS NOT NULL))
    AND ((`state` = 'rejected') = (`rejected_at` IS NOT NULL AND `rejection_reason` IS NOT NULL)));

-- HAND-EDIT: per-table rights for the app account. A supplier is edited, deactivated, and deleted only
-- while nothing refers to it. A bank change changes state; only a draft is deleted (withdrawn).
GRANT UPDATE, DELETE ON `supplier` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `supplier_bank_change` TO 'rupai_app'@'%';

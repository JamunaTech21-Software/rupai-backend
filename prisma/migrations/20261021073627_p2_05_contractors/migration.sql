-- CreateTable
CREATE TABLE `trade_category` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `description` VARCHAR(500) NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `is_system` BOOLEAN NOT NULL DEFAULT false,
    `status` VARCHAR(30) NOT NULL DEFAULT 'active',
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_trade_category_status`(`status`),
    INDEX `ix_trade_category_created_by`(`created_by`),
    INDEX `ix_trade_category_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_trade_category_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `contractor` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `short_name` VARCHAR(50) NULL,
    `contractor_type` VARCHAR(30) NOT NULL,
    `trade_category_id` BIGINT UNSIGNED NULL,
    `legal_status` VARCHAR(30) NULL,
    `registration_type` VARCHAR(100) NULL,
    `contractor_since` DATE NULL,
    `description` VARCHAR(1000) NULL,
    `contact_person` VARCHAR(150) NULL,
    `designation` VARCHAR(100) NULL,
    `phone` VARCHAR(30) NULL,
    `phone_alt` VARCHAR(30) NULL,
    `email` VARCHAR(150) NULL,
    `address_line1` VARCHAR(300) NULL,
    `present_district` VARCHAR(100) NULL,
    `present_upazila` VARCHAR(100) NULL,
    `present_postal_code` VARCHAR(10) NULL,
    `permanent_address` VARCHAR(300) NULL,
    `permanent_district` VARCHAR(100) NULL,
    `permanent_upazila` VARCHAR(100) NULL,
    `permanent_postal_code` VARCHAR(10) NULL,
    `national_id` VARCHAR(30) NULL,
    `registration_number` VARCHAR(50) NULL,
    `trade_licence_number` VARCHAR(50) NULL,
    `trade_licence_expiry` DATE NULL,
    `bin` VARCHAR(30) NULL,
    `tin` VARCHAR(30) NULL,
    `vat_registration_number` VARCHAR(50) NULL,
    `registration_date` DATE NULL,
    `renewal_date` DATE NULL,
    `bank_name` VARCHAR(150) NULL,
    `bank_branch` VARCHAR(150) NULL,
    `bank_account_name` VARCHAR(150) NULL,
    `bank_account_number` VARCHAR(40) NULL,
    `bank_routing_number` VARCHAR(20) NULL,
    `mobile_banking_provider` VARCHAR(30) NULL,
    `mobile_banking_number` VARCHAR(30) NULL,
    `equipment_owned` VARCHAR(1000) NULL,
    `years_of_experience` SMALLINT UNSIGNED NULL,
    `safety_compliance` VARCHAR(30) NULL,
    `quality_rating` VARCHAR(30) NULL,
    `remarks` VARCHAR(500) NULL,
    `emergency_contact_name` VARCHAR(150) NULL,
    `emergency_relation` VARCHAR(30) NULL,
    `emergency_phone` VARCHAR(30) NULL,
    `emergency_phone_alt` VARCHAR(30) NULL,
    `emergency_address` VARCHAR(300) NULL,
    `registered_estate_id` BIGINT UNSIGNED NULL,
    `status` VARCHAR(30) NOT NULL DEFAULT 'active',
    `blacklist_reason` VARCHAR(500) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_contractor_name`(`name`),
    INDEX `ix_contractor_type`(`contractor_type`),
    INDEX `ix_contractor_trade_category`(`trade_category_id`),
    INDEX `ix_contractor_registered_estate`(`registered_estate_id`),
    INDEX `ix_contractor_status`(`status`),
    INDEX `ix_contractor_licence_expiry`(`trade_licence_expiry`),
    INDEX `ix_contractor_created_by`(`created_by`),
    INDEX `ix_contractor_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_contractor_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `contractor_contract` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `contractor_id` BIGINT UNSIGNED NOT NULL,
    `estate_id` BIGINT UNSIGNED NOT NULL,
    `contract_number` VARCHAR(30) NOT NULL,
    `reference_number` VARCHAR(50) NULL,
    `work_type` VARCHAR(30) NOT NULL,
    `rate_basis` VARCHAR(30) NOT NULL,
    `rate` DECIMAL(18, 4) NOT NULL,
    `start_date` DATE NOT NULL,
    `end_date` DATE NOT NULL,
    `contract_value` DECIMAL(18, 4) NULL,
    `retention_percentage` DECIMAL(9, 4) NULL,
    `payment_terms` VARCHAR(30) NULL,
    `work_location` VARCHAR(30) NULL,
    `division_id` BIGINT UNSIGNED NULL,
    `reporting_to_designation_id` BIGINT UNSIGNED NULL,
    `terms` TEXT NULL,
    `state` VARCHAR(30) NOT NULL DEFAULT 'draft',
    `state_changed_at` DATETIME(0) NULL,
    `terminated_on` DATE NULL,
    `terminated_at` DATETIME(0) NULL,
    `terminated_by` BIGINT UNSIGNED NULL,
    `termination_reason` VARCHAR(500) NULL,
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

    INDEX `ix_contract_contractor`(`contractor_id`),
    INDEX `ix_contract_estate`(`estate_id`),
    INDEX `ix_contract_division`(`division_id`),
    INDEX `ix_contract_reporting_to`(`reporting_to_designation_id`),
    INDEX `ix_contract_start`(`start_date`),
    INDEX `ix_contract_end`(`end_date`),
    INDEX `ix_contract_state`(`state`),
    INDEX `ix_contract_created_by`(`created_by`),
    INDEX `ix_contract_updated_by`(`updated_by`),
    INDEX `ix_contract_submitted_by`(`submitted_by`),
    INDEX `ix_contract_approved_by`(`approved_by`),
    INDEX `ix_contract_rejected_by`(`rejected_by`),
    INDEX `ix_contract_terminated_by`(`terminated_by`),
    UNIQUE INDEX `ux_contract_number`(`contract_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `contractor_labour` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `contractor_contract_id` BIGINT UNSIGNED NOT NULL,
    `labour_code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `national_id` VARCHAR(30) NULL,
    `phone` VARCHAR(30) NULL,
    `engaged_from` DATE NULL,
    `engaged_to` DATE NULL,
    `status` VARCHAR(30) NOT NULL DEFAULT 'active',
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_contractor_labour_status`(`status`),
    INDEX `ix_contractor_labour_nid`(`national_id`),
    INDEX `ix_contractor_labour_created_by`(`created_by`),
    INDEX `ix_contractor_labour_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_contractor_labour`(`contractor_contract_id`, `labour_code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `trade_category` ADD CONSTRAINT `fk_trade_category_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `trade_category` ADD CONSTRAINT `fk_trade_category_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `contractor` ADD CONSTRAINT `fk_contractor_trade_category` FOREIGN KEY (`trade_category_id`) REFERENCES `trade_category`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `contractor` ADD CONSTRAINT `fk_contractor_registered_estate` FOREIGN KEY (`registered_estate_id`) REFERENCES `estate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `contractor` ADD CONSTRAINT `fk_contractor_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `contractor` ADD CONSTRAINT `fk_contractor_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `contractor_contract` ADD CONSTRAINT `fk_contract_contractor` FOREIGN KEY (`contractor_id`) REFERENCES `contractor`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `contractor_contract` ADD CONSTRAINT `fk_contract_estate` FOREIGN KEY (`estate_id`) REFERENCES `estate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `contractor_contract` ADD CONSTRAINT `fk_contract_division` FOREIGN KEY (`division_id`) REFERENCES `division`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `contractor_contract` ADD CONSTRAINT `fk_contract_reporting_to` FOREIGN KEY (`reporting_to_designation_id`) REFERENCES `designation`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `contractor_contract` ADD CONSTRAINT `fk_contract_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `contractor_contract` ADD CONSTRAINT `fk_contract_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `contractor_contract` ADD CONSTRAINT `fk_contract_submitted_by` FOREIGN KEY (`submitted_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `contractor_contract` ADD CONSTRAINT `fk_contract_approved_by` FOREIGN KEY (`approved_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `contractor_contract` ADD CONSTRAINT `fk_contract_rejected_by` FOREIGN KEY (`rejected_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `contractor_contract` ADD CONSTRAINT `fk_contract_terminated_by` FOREIGN KEY (`terminated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `contractor_labour` ADD CONSTRAINT `fk_contractor_labour_contract` FOREIGN KEY (`contractor_contract_id`) REFERENCES `contractor_contract`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `contractor_labour` ADD CONSTRAINT `fk_contractor_labour_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `contractor_labour` ADD CONSTRAINT `fk_contractor_labour_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- HAND-EDIT: CHECK constraints (prisma/README.md).
ALTER TABLE `trade_category` ADD CONSTRAINT `ck_trade_category_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `contractor`
  ADD CONSTRAINT `ck_contractor_type` CHECK (`contractor_type` IN ('individual', 'company', 'supplier')),
  ADD CONSTRAINT `ck_contractor_legal_status` CHECK (`legal_status` IS NULL OR `legal_status` IN
    ('proprietorship', 'partnership', 'private_ltd', 'public_ltd', 'other')),
  ADD CONSTRAINT `ck_contractor_mobile_banking` CHECK (`mobile_banking_provider` IS NULL OR `mobile_banking_provider` IN
    ('bkash', 'nagad', 'rocket', 'upay', 'other')),
  ADD CONSTRAINT `ck_contractor_safety` CHECK (`safety_compliance` IS NULL OR `safety_compliance` IN
    ('compliant', 'partially_compliant', 'non_compliant')),
  ADD CONSTRAINT `ck_contractor_quality` CHECK (`quality_rating` IS NULL OR `quality_rating` IN
    ('excellent', 'good', 'average', 'poor')),
  ADD CONSTRAINT `ck_contractor_relation` CHECK (`emergency_relation` IS NULL OR `emergency_relation` IN
    ('father', 'mother', 'spouse', 'son', 'daughter', 'brother', 'sister', 'other')),
  ADD CONSTRAINT `ck_contractor_status` CHECK (`status` IN ('active', 'inactive', 'blacklisted')),
  ADD CONSTRAINT `ck_contractor_blacklist` CHECK ((`status` = 'blacklisted') = (`blacklist_reason` IS NOT NULL));
ALTER TABLE `contractor_contract`
  ADD CONSTRAINT `ck_contract_work_type` CHECK (`work_type` IN
    ('labour_supply', 'plucking', 'field_work', 'construction', 'transport', 'service', 'other')),
  ADD CONSTRAINT `ck_contract_rate_basis` CHECK (`rate_basis` IN ('per_day', 'per_kg', 'per_unit', 'lump_sum')),
  ADD CONSTRAINT `ck_contract_amounts` CHECK (`rate` >= 0 AND (`contract_value` IS NULL OR `contract_value` >= 0)),
  -- P3 §8.7: contract_value is what a lump-sum contract is.
  ADD CONSTRAINT `ck_contract_lump_sum` CHECK (`rate_basis` <> 'lump_sum' OR `contract_value` IS NOT NULL),
  ADD CONSTRAINT `ck_contract_retention` CHECK (`retention_percentage` IS NULL OR `retention_percentage` BETWEEN 0 AND 100),
  ADD CONSTRAINT `ck_contract_dates` CHECK (`end_date` >= `start_date`),
  ADD CONSTRAINT `ck_contract_payment_terms` CHECK (`payment_terms` IS NULL OR `payment_terms` IN
    ('advance', 'monthly', 'quarterly', 'milestone')),
  ADD CONSTRAINT `ck_contract_work_location` CHECK (`work_location` IS NULL OR `work_location` IN
    ('estate', 'factory', 'office', 'field')),
  ADD CONSTRAINT `ck_contract_state` CHECK (`state` IN ('draft', 'submitted', 'approved', 'rejected', 'terminated')),
  ADD CONSTRAINT `ck_contract_approval` CHECK (
    (`state` = 'draft' OR `submitted_at` IS NOT NULL)
    AND ((`state` IN ('approved', 'terminated')) = (`approved_at` IS NOT NULL))
    AND ((`state` = 'rejected') = (`rejected_at` IS NOT NULL AND `rejection_reason` IS NOT NULL))),
  ADD CONSTRAINT `ck_contract_termination` CHECK (
    (`state` = 'terminated') = (`terminated_on` IS NOT NULL AND `termination_reason` IS NOT NULL)),
  ADD CONSTRAINT `ck_contract_terminated_on` CHECK (`terminated_on` IS NULL OR `terminated_on` BETWEEN `start_date` AND `end_date`);
ALTER TABLE `contractor_labour`
  ADD CONSTRAINT `ck_contractor_labour_status` CHECK (`status` IN ('active', 'inactive')),
  ADD CONSTRAINT `ck_contractor_labour_dates` CHECK (`engaged_from` IS NULL OR `engaged_to` IS NULL OR `engaged_to` >= `engaged_from`);

-- HAND-EDIT: per-table rights for the app account. Contractors are edited, deactivated or blacklisted and
-- deleted only before any contract; a contract changes state, and only a draft is deleted; labour is
-- edited and ended. Trade categories are a reference list.
GRANT UPDATE, DELETE ON `trade_category` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `contractor` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `contractor_contract` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `contractor_labour` TO 'rupai_app'@'%';

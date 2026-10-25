-- CreateTable
CREATE TABLE `receivable` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `source_type` VARCHAR(40) NOT NULL,
    `source_id` BIGINT UNSIGNED NOT NULL,
    `party_type` VARCHAR(40) NOT NULL,
    `party_id` BIGINT UNSIGNED NOT NULL,
    `estate_id` BIGINT UNSIGNED NULL,
    `reference_number` VARCHAR(30) NOT NULL,
    `document_date` DATE NOT NULL,
    `due_date` DATE NOT NULL,
    `currency_id` BIGINT UNSIGNED NOT NULL,
    `exchange_rate` DECIMAL(18, 8) NOT NULL,
    `original_amount` DECIMAL(18, 4) NOT NULL,
    `original_base_amount` DECIMAL(18, 4) NOT NULL,
    `received_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `adjusted_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `settled_base_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    -- HAND-EDIT: stored, maintained by the database, never computed at query time (P2 §5.11, D-3.05-5).
    `outstanding_amount` DECIMAL(18, 4) GENERATED ALWAYS AS (IF(`state` = 'reversed', 0, `original_amount` - `received_amount` - `adjusted_amount`)) STORED,
    `outstanding_base_amount` DECIMAL(18, 4) GENERATED ALWAYS AS (IF(`state` = 'reversed', 0, `original_base_amount` - `settled_base_amount`)) STORED,
    `ageing_band` VARCHAR(30) NULL,
    `state` VARCHAR(30) NOT NULL DEFAULT 'open',
    `accounting_period_id` BIGINT UNSIGNED NOT NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,

    INDEX `ix_receivable_party_state`(`party_type`, `party_id`, `state`),
    INDEX `ix_receivable_due`(`due_date`, `state`),
    INDEX `ix_receivable_estate`(`estate_id`),
    INDEX `ix_receivable_document_date`(`document_date`),
    INDEX `ix_receivable_outstanding`(`outstanding_amount`),
    INDEX `ix_receivable_ageing_band`(`ageing_band`),
    INDEX `ix_receivable_state`(`state`),
    INDEX `ix_receivable_currency`(`currency_id`),
    INDEX `ix_receivable_period`(`accounting_period_id`),
    INDEX `ix_receivable_created_by`(`created_by`),
    UNIQUE INDEX `ux_receivable_source`(`source_type`, `source_id`),
    UNIQUE INDEX `ux_receivable_ref`(`reference_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `collection` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `collection_number` VARCHAR(30) NULL,
    `collection_date` DATE NOT NULL,
    `party_type` VARCHAR(40) NOT NULL,
    `party_id` BIGINT UNSIGNED NOT NULL,
    `estate_id` BIGINT UNSIGNED NULL,
    `payment_method_id` BIGINT UNSIGNED NOT NULL,
    `bank_account_id` BIGINT UNSIGNED NULL,
    `instrument_number` VARCHAR(50) NULL,
    `instrument_date` DATE NULL,
    `currency_id` BIGINT UNSIGNED NOT NULL,
    `exchange_rate` DECIMAL(18, 8) NOT NULL,
    `amount` DECIMAL(18, 4) NOT NULL,
    `base_amount` DECIMAL(18, 4) NOT NULL,
    `allocated_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    -- HAND-EDIT: amount − allocated, the advance (P3 §15.2).
    `unallocated_amount` DECIMAL(18, 4) GENERATED ALWAYS AS (`amount` - `allocated_amount`) STORED,
    `narration` VARCHAR(300) NULL,
    `state` VARCHAR(30) NOT NULL DEFAULT 'draft',
    `state_changed_at` DATETIME(0) NULL,
    `submitted_at` DATETIME(0) NULL,
    `submitted_by` BIGINT UNSIGNED NULL,
    `approved_at` DATETIME(0) NULL,
    `approved_by` BIGINT UNSIGNED NULL,
    `rejected_at` DATETIME(0) NULL,
    `rejected_by` BIGINT UNSIGNED NULL,
    `rejection_reason` VARCHAR(500) NULL,
    `accounting_period_id` BIGINT UNSIGNED NOT NULL,
    `posted_at` DATETIME(0) NULL,
    `posted_by` BIGINT UNSIGNED NULL,
    `reversal_of_id` BIGINT UNSIGNED NULL,
    `is_reversed` BOOLEAN NOT NULL DEFAULT false,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_collection_date`(`collection_date`),
    INDEX `ix_collection_party`(`party_type`, `party_id`),
    INDEX `ix_collection_estate`(`estate_id`),
    INDEX `ix_collection_payment_method`(`payment_method_id`),
    INDEX `ix_collection_bank_account`(`bank_account_id`),
    INDEX `ix_collection_currency`(`currency_id`),
    INDEX `ix_collection_state`(`state`),
    INDEX `ix_collection_period`(`accounting_period_id`),
    INDEX `ix_collection_reversal_of`(`reversal_of_id`),
    INDEX `ix_collection_submitted_by`(`submitted_by`),
    INDEX `ix_collection_approved_by`(`approved_by`),
    INDEX `ix_collection_rejected_by`(`rejected_by`),
    INDEX `ix_collection_posted_by`(`posted_by`),
    INDEX `ix_collection_created_by`(`created_by`),
    INDEX `ix_collection_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_collection_number`(`collection_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `collection_allocation` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `collection_id` BIGINT UNSIGNED NOT NULL,
    `receivable_id` BIGINT UNSIGNED NOT NULL,
    `amount` DECIMAL(18, 4) NOT NULL,
    `base_amount` DECIMAL(18, 4) NOT NULL,
    `fx_gain_loss` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `sequence` INTEGER NOT NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_collection_allocation_receivable`(`receivable_id`),
    INDEX `ix_collection_allocation_created_by`(`created_by`),
    INDEX `ix_collection_allocation_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_collection_allocation`(`collection_id`, `receivable_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payable` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `source_type` VARCHAR(40) NOT NULL,
    `source_id` BIGINT UNSIGNED NOT NULL,
    `party_type` VARCHAR(40) NOT NULL,
    `party_id` BIGINT UNSIGNED NOT NULL,
    `estate_id` BIGINT UNSIGNED NULL,
    `reference_number` VARCHAR(30) NOT NULL,
    `document_date` DATE NOT NULL,
    `due_date` DATE NOT NULL,
    `currency_id` BIGINT UNSIGNED NOT NULL,
    `exchange_rate` DECIMAL(18, 8) NOT NULL,
    `original_amount` DECIMAL(18, 4) NOT NULL,
    `original_base_amount` DECIMAL(18, 4) NOT NULL,
    `paid_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `adjusted_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `settled_base_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    -- HAND-EDIT: stored, maintained by the database, never computed at query time (P2 §5.11, D-3.05-5).
    `outstanding_amount` DECIMAL(18, 4) GENERATED ALWAYS AS (IF(`state` = 'reversed', 0, `original_amount` - `paid_amount` - `adjusted_amount`)) STORED,
    `outstanding_base_amount` DECIMAL(18, 4) GENERATED ALWAYS AS (IF(`state` = 'reversed', 0, `original_base_amount` - `settled_base_amount`)) STORED,
    `ageing_band` VARCHAR(30) NULL,
    `state` VARCHAR(30) NOT NULL DEFAULT 'open',
    `accounting_period_id` BIGINT UNSIGNED NOT NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,

    INDEX `ix_payable_party_state`(`party_type`, `party_id`, `state`),
    INDEX `ix_payable_due`(`due_date`, `state`),
    INDEX `ix_payable_estate`(`estate_id`),
    INDEX `ix_payable_document_date`(`document_date`),
    INDEX `ix_payable_outstanding`(`outstanding_amount`),
    INDEX `ix_payable_ageing_band`(`ageing_band`),
    INDEX `ix_payable_state`(`state`),
    INDEX `ix_payable_currency`(`currency_id`),
    INDEX `ix_payable_period`(`accounting_period_id`),
    INDEX `ix_payable_created_by`(`created_by`),
    UNIQUE INDEX `ux_payable_source`(`source_type`, `source_id`),
    UNIQUE INDEX `ux_payable_ref`(`reference_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `payment_number` VARCHAR(30) NULL,
    `payment_date` DATE NOT NULL,
    `party_type` VARCHAR(40) NOT NULL,
    `party_id` BIGINT UNSIGNED NOT NULL,
    `estate_id` BIGINT UNSIGNED NULL,
    `payment_method_id` BIGINT UNSIGNED NOT NULL,
    `bank_account_id` BIGINT UNSIGNED NULL,
    `instrument_number` VARCHAR(50) NULL,
    `instrument_date` DATE NULL,
    `currency_id` BIGINT UNSIGNED NOT NULL,
    `exchange_rate` DECIMAL(18, 8) NOT NULL,
    `amount` DECIMAL(18, 4) NOT NULL,
    `base_amount` DECIMAL(18, 4) NOT NULL,
    `allocated_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    -- HAND-EDIT: amount − allocated, the advance (P3 §15.2).
    `unallocated_amount` DECIMAL(18, 4) GENERATED ALWAYS AS (`amount` - `allocated_amount`) STORED,
    `narration` VARCHAR(300) NULL,
    `state` VARCHAR(30) NOT NULL DEFAULT 'draft',
    `state_changed_at` DATETIME(0) NULL,
    `submitted_at` DATETIME(0) NULL,
    `submitted_by` BIGINT UNSIGNED NULL,
    `approved_at` DATETIME(0) NULL,
    `approved_by` BIGINT UNSIGNED NULL,
    `rejected_at` DATETIME(0) NULL,
    `rejected_by` BIGINT UNSIGNED NULL,
    `rejection_reason` VARCHAR(500) NULL,
    `accounting_period_id` BIGINT UNSIGNED NOT NULL,
    `posted_at` DATETIME(0) NULL,
    `posted_by` BIGINT UNSIGNED NULL,
    `reversal_of_id` BIGINT UNSIGNED NULL,
    `is_reversed` BOOLEAN NOT NULL DEFAULT false,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_payment_date`(`payment_date`),
    INDEX `ix_payment_party`(`party_type`, `party_id`),
    INDEX `ix_payment_estate`(`estate_id`),
    INDEX `ix_payment_payment_method`(`payment_method_id`),
    INDEX `ix_payment_bank_account`(`bank_account_id`),
    INDEX `ix_payment_currency`(`currency_id`),
    INDEX `ix_payment_state`(`state`),
    INDEX `ix_payment_period`(`accounting_period_id`),
    INDEX `ix_payment_reversal_of`(`reversal_of_id`),
    INDEX `ix_payment_submitted_by`(`submitted_by`),
    INDEX `ix_payment_approved_by`(`approved_by`),
    INDEX `ix_payment_rejected_by`(`rejected_by`),
    INDEX `ix_payment_posted_by`(`posted_by`),
    INDEX `ix_payment_created_by`(`created_by`),
    INDEX `ix_payment_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_payment_number`(`payment_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_allocation` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `payment_id` BIGINT UNSIGNED NOT NULL,
    `payable_id` BIGINT UNSIGNED NOT NULL,
    `amount` DECIMAL(18, 4) NOT NULL,
    `base_amount` DECIMAL(18, 4) NOT NULL,
    `fx_gain_loss` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `sequence` INTEGER NOT NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_payment_allocation_payable`(`payable_id`),
    INDEX `ix_payment_allocation_created_by`(`created_by`),
    INDEX `ix_payment_allocation_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_payment_allocation`(`payment_id`, `payable_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `receivable` ADD CONSTRAINT `fk_receivable_estate` FOREIGN KEY (`estate_id`) REFERENCES `estate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `receivable` ADD CONSTRAINT `fk_receivable_currency` FOREIGN KEY (`currency_id`) REFERENCES `currency`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `receivable` ADD CONSTRAINT `fk_receivable_period` FOREIGN KEY (`accounting_period_id`) REFERENCES `accounting_period`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `receivable` ADD CONSTRAINT `fk_receivable_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `collection` ADD CONSTRAINT `fk_collection_estate` FOREIGN KEY (`estate_id`) REFERENCES `estate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `collection` ADD CONSTRAINT `fk_collection_payment_method` FOREIGN KEY (`payment_method_id`) REFERENCES `payment_method`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `collection` ADD CONSTRAINT `fk_collection_bank_account` FOREIGN KEY (`bank_account_id`) REFERENCES `bank_account`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `collection` ADD CONSTRAINT `fk_collection_currency` FOREIGN KEY (`currency_id`) REFERENCES `currency`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `collection` ADD CONSTRAINT `fk_collection_period` FOREIGN KEY (`accounting_period_id`) REFERENCES `accounting_period`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `collection` ADD CONSTRAINT `fk_collection_reversal_of` FOREIGN KEY (`reversal_of_id`) REFERENCES `collection`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `collection` ADD CONSTRAINT `fk_collection_submitted_by` FOREIGN KEY (`submitted_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `collection` ADD CONSTRAINT `fk_collection_approved_by` FOREIGN KEY (`approved_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `collection` ADD CONSTRAINT `fk_collection_rejected_by` FOREIGN KEY (`rejected_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `collection` ADD CONSTRAINT `fk_collection_posted_by` FOREIGN KEY (`posted_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `collection` ADD CONSTRAINT `fk_collection_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `collection` ADD CONSTRAINT `fk_collection_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `collection_allocation` ADD CONSTRAINT `fk_collection_allocation_collection` FOREIGN KEY (`collection_id`) REFERENCES `collection`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `collection_allocation` ADD CONSTRAINT `fk_collection_allocation_receivable` FOREIGN KEY (`receivable_id`) REFERENCES `receivable`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `collection_allocation` ADD CONSTRAINT `fk_collection_allocation_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `collection_allocation` ADD CONSTRAINT `fk_collection_allocation_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payable` ADD CONSTRAINT `fk_payable_estate` FOREIGN KEY (`estate_id`) REFERENCES `estate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payable` ADD CONSTRAINT `fk_payable_currency` FOREIGN KEY (`currency_id`) REFERENCES `currency`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payable` ADD CONSTRAINT `fk_payable_period` FOREIGN KEY (`accounting_period_id`) REFERENCES `accounting_period`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payable` ADD CONSTRAINT `fk_payable_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payment` ADD CONSTRAINT `fk_payment_estate` FOREIGN KEY (`estate_id`) REFERENCES `estate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payment` ADD CONSTRAINT `fk_payment_payment_method` FOREIGN KEY (`payment_method_id`) REFERENCES `payment_method`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payment` ADD CONSTRAINT `fk_payment_bank_account` FOREIGN KEY (`bank_account_id`) REFERENCES `bank_account`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payment` ADD CONSTRAINT `fk_payment_currency` FOREIGN KEY (`currency_id`) REFERENCES `currency`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payment` ADD CONSTRAINT `fk_payment_period` FOREIGN KEY (`accounting_period_id`) REFERENCES `accounting_period`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payment` ADD CONSTRAINT `fk_payment_reversal_of` FOREIGN KEY (`reversal_of_id`) REFERENCES `payment`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payment` ADD CONSTRAINT `fk_payment_submitted_by` FOREIGN KEY (`submitted_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payment` ADD CONSTRAINT `fk_payment_approved_by` FOREIGN KEY (`approved_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payment` ADD CONSTRAINT `fk_payment_rejected_by` FOREIGN KEY (`rejected_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payment` ADD CONSTRAINT `fk_payment_posted_by` FOREIGN KEY (`posted_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payment` ADD CONSTRAINT `fk_payment_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payment` ADD CONSTRAINT `fk_payment_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payment_allocation` ADD CONSTRAINT `fk_payment_allocation_payment` FOREIGN KEY (`payment_id`) REFERENCES `payment`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payment_allocation` ADD CONSTRAINT `fk_payment_allocation_payable` FOREIGN KEY (`payable_id`) REFERENCES `payable`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payment_allocation` ADD CONSTRAINT `fk_payment_allocation_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payment_allocation` ADD CONSTRAINT `fk_payment_allocation_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- HAND-EDIT: CHECK constraints (prisma/README.md). P3 §15.1–§15.3, §16.7; D-3.05-3 to D-3.05-10. The two
-- sides are mirror images (D-3.05-2): only the source and party lists and received / paid differ.
ALTER TABLE `receivable`
  ADD CONSTRAINT `ck_receivable_source_type` CHECK (`source_type` IN ('sale', 'lease_schedule', 'other', 'opening')),
  ADD CONSTRAINT `ck_receivable_party_type` CHECK (`party_type` IN ('buyer', 'party', 'employment_profile')),
  ADD CONSTRAINT `ck_receivable_state` CHECK (`state` IN ('open', 'partially_settled', 'settled', 'written_off', 'reversed')),
  ADD CONSTRAINT `ck_receivable_ageing_band` CHECK (`ageing_band` IS NULL OR `ageing_band` IN ('current', '1_30', '31_60', '61_90', 'over_90')),
  ADD CONSTRAINT `ck_receivable_amounts` CHECK (`original_amount` > 0 AND `original_base_amount` > 0 AND `exchange_rate` > 0
      AND `received_amount` >= 0 AND `adjusted_amount` >= 0 AND `settled_base_amount` >= 0),
  -- outstanding_amount >= 0 (P3 §15.1), stated on the base columns because a generated column cannot be checked.
  ADD CONSTRAINT `ck_receivable_outstanding` CHECK (`received_amount` + `adjusted_amount` <= `original_amount`),
  ADD CONSTRAINT `ck_receivable_due` CHECK (`due_date` >= `document_date`);
ALTER TABLE `payable`
  ADD CONSTRAINT `ck_payable_source_type` CHECK (`source_type` IN ('supplier_invoice', 'leaf_purchase', 'contractor_bill', 'employee_advance', 'payroll_run', 'other', 'opening')),
  ADD CONSTRAINT `ck_payable_party_type` CHECK (`party_type` IN ('supplier', 'leaf_supplier', 'contractor', 'party', 'employment_profile')),
  ADD CONSTRAINT `ck_payable_state` CHECK (`state` IN ('open', 'partially_settled', 'settled', 'written_off', 'reversed')),
  ADD CONSTRAINT `ck_payable_ageing_band` CHECK (`ageing_band` IS NULL OR `ageing_band` IN ('current', '1_30', '31_60', '61_90', 'over_90')),
  ADD CONSTRAINT `ck_payable_amounts` CHECK (`original_amount` > 0 AND `original_base_amount` > 0 AND `exchange_rate` > 0
      AND `paid_amount` >= 0 AND `adjusted_amount` >= 0 AND `settled_base_amount` >= 0),
  -- outstanding_amount >= 0 (P3 §15.1), stated on the base columns because a generated column cannot be checked.
  ADD CONSTRAINT `ck_payable_outstanding` CHECK (`paid_amount` + `adjusted_amount` <= `original_amount`),
  ADD CONSTRAINT `ck_payable_due` CHECK (`due_date` >= `document_date`);
ALTER TABLE `collection`
  ADD CONSTRAINT `ck_collection_party_type` CHECK (`party_type` IN ('buyer', 'party', 'employment_profile')),
  ADD CONSTRAINT `ck_collection_state` CHECK (`state` IN ('draft', 'submitted', 'approved', 'rejected', 'posted')),
  ADD CONSTRAINT `ck_collection_amounts` CHECK (`amount` > 0 AND `base_amount` > 0 AND `exchange_rate` > 0 AND `allocated_amount` >= 0),
  ADD CONSTRAINT `ck_collection_allocated` CHECK (`allocated_amount` <= `amount`);
ALTER TABLE `payment`
  ADD CONSTRAINT `ck_payment_party_type` CHECK (`party_type` IN ('supplier', 'leaf_supplier', 'contractor', 'party', 'employment_profile')),
  ADD CONSTRAINT `ck_payment_state` CHECK (`state` IN ('draft', 'submitted', 'approved', 'rejected', 'posted')),
  ADD CONSTRAINT `ck_payment_amounts` CHECK (`amount` > 0 AND `base_amount` > 0 AND `exchange_rate` > 0 AND `allocated_amount` >= 0),
  ADD CONSTRAINT `ck_payment_allocated` CHECK (`allocated_amount` <= `amount`);
ALTER TABLE `collection_allocation`
  ADD CONSTRAINT `ck_collection_allocation_amount` CHECK (`amount` > 0 AND `base_amount` >= 0),
  ADD CONSTRAINT `ck_collection_allocation_sequence` CHECK (`sequence` > 0);
ALTER TABLE `payment_allocation`
  ADD CONSTRAINT `ck_payment_allocation_amount` CHECK (`amount` > 0 AND `base_amount` >= 0),
  ADD CONSTRAINT `ck_payment_allocation_sequence` CHECK (`sequence` > 0);

-- HAND-EDIT: per-table rights for the app account. A receivable or payable changes only in its settlement
-- columns, through core/settlement (never deleted). Collections and payments are drafts until posted (a
-- draft may be deleted, P8.09 / P4.07); their allocations are replaced while the document is a draft and
-- have their base and FX fixed at posting (D-3.05-6).
GRANT UPDATE ON `receivable` TO 'rupai_app'@'%';
GRANT UPDATE ON `payable` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `collection` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `payment` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `collection_allocation` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `payment_allocation` TO 'rupai_app'@'%';

-- CreateTable
CREATE TABLE `raw_material` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `material_category` VARCHAR(30) NOT NULL,
    `uom_id` BIGINT UNSIGNED NOT NULL,
    `is_stock_tracked` BOOLEAN NOT NULL DEFAULT true,
    `reorder_level` DECIMAL(14, 3) NULL,
    `default_cost_centre_id` BIGINT UNSIGNED NULL,
    `expense_account_id` BIGINT UNSIGNED NULL,
    `status` VARCHAR(30) NOT NULL DEFAULT 'active',
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_material_name`(`name`),
    INDEX `ix_material_category`(`material_category`),
    INDEX `ix_material_uom`(`uom_id`),
    INDEX `ix_material_cost_centre`(`default_cost_centre_id`),
    INDEX `ix_material_expense_account`(`expense_account_id`),
    INDEX `ix_material_status`(`status`),
    INDEX `ix_material_created_by`(`created_by`),
    INDEX `ix_material_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_material_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_movement` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `material_class` VARCHAR(30) NOT NULL,
    `raw_material_id` BIGINT UNSIGNED NULL,
    `tea_type_id` BIGINT UNSIGNED NULL,
    `tea_grade_id` BIGINT UNSIGNED NULL,
    `production_batch_id` BIGINT UNSIGNED NULL,
    `location_type` VARCHAR(30) NOT NULL,
    `location_id` BIGINT UNSIGNED NOT NULL,
    `ownership` VARCHAR(30) NOT NULL,
    `stock_state` VARCHAR(30) NOT NULL,
    `movement_type` VARCHAR(30) NOT NULL,
    `direction` VARCHAR(10) NOT NULL,
    `quantity` DECIMAL(14, 3) NOT NULL,
    `unit_cost` DECIMAL(18, 4) NOT NULL,
    `value` DECIMAL(18, 4) NOT NULL,
    `source_type` VARCHAR(40) NOT NULL,
    `source_id` BIGINT UNSIGNED NOT NULL,
    `source_line_id` BIGINT UNSIGNED NULL,
    `moved_at` DATETIME(0) NOT NULL,
    `accounting_period_id` BIGINT UNSIGNED NOT NULL,
    `estate_id` BIGINT UNSIGNED NULL,
    `reversal_of_id` BIGINT UNSIGNED NULL,
    `reason_id` BIGINT UNSIGNED NULL,
    `narration` VARCHAR(200) NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,

    INDEX `ix_movement_balance`(`material_class`, `location_type`, `location_id`, `ownership`, `stock_state`, `moved_at`),
    INDEX `ix_movement_source`(`source_type`, `source_id`),
    INDEX `ix_movement_period`(`accounting_period_id`, `material_class`),
    INDEX `ix_movement_grade`(`tea_grade_id`, `moved_at`),
    INDEX `ix_movement_material`(`raw_material_id`, `moved_at`),
    INDEX `ix_movement_moved_at`(`moved_at`),
    INDEX `ix_movement_tea_type`(`tea_type_id`),
    INDEX `ix_movement_estate`(`estate_id`),
    INDEX `ix_movement_reason`(`reason_id`),
    INDEX `ix_movement_created_by`(`created_by`),
    UNIQUE INDEX `ux_movement_reversal`(`reversal_of_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_balance` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `material_class` VARCHAR(30) NOT NULL,
    `raw_material_id` BIGINT UNSIGNED NULL,
    `tea_type_id` BIGINT UNSIGNED NULL,
    `tea_grade_id` BIGINT UNSIGNED NULL,
    `production_batch_id` BIGINT UNSIGNED NULL,
    `location_type` VARCHAR(30) NOT NULL,
    `location_id` BIGINT UNSIGNED NOT NULL,
    `ownership` VARCHAR(30) NOT NULL,
    `stock_state` VARCHAR(30) NOT NULL,
    `quantity` DECIMAL(14, 3) NOT NULL DEFAULT 0,
    `average_unit_cost` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `value` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `last_movement_at` DATETIME(0) NULL,
    `last_rebuilt_at` DATETIME(0) NULL,
    -- HAND-EDIT: generated: the ux_stock_balance key of P3 §13.2 with NULLs spelled out, because a UNIQUE index
    -- treats NULLs as distinct. core/stock/stock.ts balanceKey() spells it the same way.
    `balance_key` VARCHAR(200) GENERATED ALWAYS AS (CONCAT_WS('|', `material_class`, IFNULL(`raw_material_id`, ''),
        IFNULL(`tea_type_id`, ''), IFNULL(`tea_grade_id`, ''), IFNULL(`production_batch_id`, ''), `location_type`,
        `location_id`, `ownership`, `stock_state`)) STORED,

    INDEX `ix_balance_location`(`location_type`, `location_id`),
    INDEX `ix_balance_raw_material`(`raw_material_id`),
    INDEX `ix_balance_tea_type`(`tea_type_id`),
    INDEX `ix_balance_tea_grade`(`tea_grade_id`),
    UNIQUE INDEX `ux_stock_balance`(`balance_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `raw_material` ADD CONSTRAINT `fk_raw_material_uom` FOREIGN KEY (`uom_id`) REFERENCES `uom`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `raw_material` ADD CONSTRAINT `fk_raw_material_cost_centre` FOREIGN KEY (`default_cost_centre_id`) REFERENCES `cost_centre`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `raw_material` ADD CONSTRAINT `fk_raw_material_expense_account` FOREIGN KEY (`expense_account_id`) REFERENCES `account`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `raw_material` ADD CONSTRAINT `fk_raw_material_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `raw_material` ADD CONSTRAINT `fk_raw_material_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_movement` ADD CONSTRAINT `fk_movement_raw_material` FOREIGN KEY (`raw_material_id`) REFERENCES `raw_material`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_movement` ADD CONSTRAINT `fk_movement_tea_type` FOREIGN KEY (`tea_type_id`) REFERENCES `tea_type`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_movement` ADD CONSTRAINT `fk_movement_tea_grade` FOREIGN KEY (`tea_grade_id`) REFERENCES `tea_grade`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_movement` ADD CONSTRAINT `fk_movement_period` FOREIGN KEY (`accounting_period_id`) REFERENCES `accounting_period`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_movement` ADD CONSTRAINT `fk_movement_estate` FOREIGN KEY (`estate_id`) REFERENCES `estate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_movement` ADD CONSTRAINT `fk_movement_reversal_of` FOREIGN KEY (`reversal_of_id`) REFERENCES `stock_movement`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_movement` ADD CONSTRAINT `fk_movement_reason` FOREIGN KEY (`reason_id`) REFERENCES `adjustment_reason`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_movement` ADD CONSTRAINT `fk_movement_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_balance` ADD CONSTRAINT `fk_balance_raw_material` FOREIGN KEY (`raw_material_id`) REFERENCES `raw_material`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_balance` ADD CONSTRAINT `fk_balance_tea_type` FOREIGN KEY (`tea_type_id`) REFERENCES `tea_type`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_balance` ADD CONSTRAINT `fk_balance_tea_grade` FOREIGN KEY (`tea_grade_id`) REFERENCES `tea_grade`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- HAND-EDIT: CHECK constraints (prisma/README.md, P3 §13.1–§13.2).
ALTER TABLE `raw_material`
  ADD CONSTRAINT `ck_material_category` CHECK (`material_category` IN
    ('fuel', 'packaging', 'consumable', 'chemical', 'fertiliser', 'spare', 'maintenance', 'other')),
  ADD CONSTRAINT `ck_material_reorder_level` CHECK (`reorder_level` IS NULL OR `reorder_level` >= 0),
  ADD CONSTRAINT `ck_material_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `stock_movement`
  ADD CONSTRAINT `ck_movement_class` CHECK (`material_class` IN ('green_leaf', 'made_tea', 'material')),
  -- material_class decides which reference columns apply (P3 §13.1).
  ADD CONSTRAINT `ck_movement_refs` CHECK (
    (`material_class` = 'material' AND `raw_material_id` IS NOT NULL AND `tea_type_id` IS NULL AND `tea_grade_id` IS NULL AND `production_batch_id` IS NULL)
    OR (`material_class` = 'made_tea' AND `raw_material_id` IS NULL AND `tea_type_id` IS NOT NULL AND `tea_grade_id` IS NOT NULL)
    OR (`material_class` = 'green_leaf' AND `raw_material_id` IS NULL AND `tea_type_id` IS NULL AND `tea_grade_id` IS NULL AND `production_batch_id` IS NULL)),
  ADD CONSTRAINT `ck_movement_location_type` CHECK (`location_type` IN ('warehouse', 'factory', 'collection_point', 'store')),
  ADD CONSTRAINT `ck_movement_ownership` CHECK (`ownership` IN ('owned', 'held')),
  ADD CONSTRAINT `ck_movement_state` CHECK (`stock_state` IN ('available', 'reserved', 'allocated', 'sold', 'dispatched', 'damaged')),
  ADD CONSTRAINT `ck_movement_type` CHECK (`movement_type` IN ('receipt_production', 'receipt_collection', 'receipt_purchase',
    'transfer_in', 'transfer_out', 'consumption', 'issue_sale', 'issue_activity', 'adjustment_increase',
    'adjustment_decrease', 'write_off', 'state_change')),
  ADD CONSTRAINT `ck_movement_direction` CHECK (`direction` IN ('in', 'out')),
  ADD CONSTRAINT `ck_movement_quantity` CHECK (`quantity` > 0),
  ADD CONSTRAINT `ck_movement_value` CHECK (`unit_cost` >= 0 AND `value` >= 0),
  -- Held material carries no value (P1 §8.3).
  ADD CONSTRAINT `ck_movement_held` CHECK (`ownership` = 'owned' OR (`unit_cost` = 0 AND `value` = 0)),
  ADD CONSTRAINT `ck_movement_source_type` CHECK (`source_type` IN ('leaf_collection', 'leaf_purchase', 'leaf_transfer',
    'production_batch', 'sale', 'goods_receipt', 'material_issue', 'stock_adjustment', 'opening_balance'));
-- (A movement reversing itself cannot be stated as a CHECK: MySQL refuses one on an AUTO_INCREMENT column.
-- core/stock only ever names an earlier movement, and ux_movement_reversal reverses each at most once.)
ALTER TABLE `stock_balance`
  ADD CONSTRAINT `ck_balance_class` CHECK (`material_class` IN ('green_leaf', 'made_tea', 'material')),
  ADD CONSTRAINT `ck_balance_refs` CHECK (
    (`material_class` = 'material' AND `raw_material_id` IS NOT NULL AND `tea_type_id` IS NULL AND `tea_grade_id` IS NULL AND `production_batch_id` IS NULL)
    OR (`material_class` = 'made_tea' AND `raw_material_id` IS NULL AND `tea_type_id` IS NOT NULL AND `tea_grade_id` IS NOT NULL)
    OR (`material_class` = 'green_leaf' AND `raw_material_id` IS NULL AND `tea_type_id` IS NULL AND `tea_grade_id` IS NULL AND `production_batch_id` IS NULL)),
  ADD CONSTRAINT `ck_balance_location_type` CHECK (`location_type` IN ('warehouse', 'factory', 'collection_point', 'store')),
  ADD CONSTRAINT `ck_balance_ownership` CHECK (`ownership` IN ('owned', 'held')),
  ADD CONSTRAINT `ck_balance_state` CHECK (`stock_state` IN ('available', 'reserved', 'allocated', 'sold', 'dispatched', 'damaged')),
  -- The no-negative-stock invariant at the database level (P3 §13.2); the check on the way in is core/stock's.
  ADD CONSTRAINT `ck_balance_quantity` CHECK (`quantity` >= 0),
  ADD CONSTRAINT `ck_balance_value` CHECK (`value` >= 0 AND `average_unit_cost` >= 0),
  ADD CONSTRAINT `ck_balance_held` CHECK (`ownership` = 'owned' OR `value` = 0);

-- HAND-EDIT: per-table rights for the app account. stock_movement gets NOTHING: it is immutable at every
-- permission level (P3 §13.1), so the database itself refuses UPDATE and DELETE. stock_balance is updated by
-- core/stock (never deleted: rows stay at zero). Raw materials are edited and deleted while unused.
GRANT UPDATE, DELETE ON `raw_material` TO 'rupai_app'@'%';
GRANT UPDATE ON `stock_balance` TO 'rupai_app'@'%';

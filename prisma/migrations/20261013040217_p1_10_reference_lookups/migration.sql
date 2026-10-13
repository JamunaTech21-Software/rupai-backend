-- CreateTable
CREATE TABLE `department` (
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

    INDEX `ix_department_status`(`status`),
    INDEX `ix_department_created_by`(`created_by`),
    INDEX `ix_department_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_department_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `designation` (
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

    INDEX `ix_designation_status`(`status`),
    INDEX `ix_designation_created_by`(`created_by`),
    INDEX `ix_designation_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_designation_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `worker_category` (
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

    INDEX `ix_worker_category_status`(`status`),
    INDEX `ix_worker_category_created_by`(`created_by`),
    INDEX `ix_worker_category_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_worker_category_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `employee_category` (
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

    INDEX `ix_employee_category_status`(`status`),
    INDEX `ix_employee_category_created_by`(`created_by`),
    INDEX `ix_employee_category_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_employee_category_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `employment_type` (
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

    INDEX `ix_employment_type_status`(`status`),
    INDEX `ix_employment_type_created_by`(`created_by`),
    INDEX `ix_employment_type_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_employment_type_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leave_type` (
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

    INDEX `ix_leave_type_status`(`status`),
    INDEX `ix_leave_type_created_by`(`created_by`),
    INDEX `ix_leave_type_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_leave_type_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `buyer_type` (
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

    INDEX `ix_buyer_type_status`(`status`),
    INDEX `ix_buyer_type_created_by`(`created_by`),
    INDEX `ix_buyer_type_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_buyer_type_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `trading_type` (
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

    INDEX `ix_trading_type_status`(`status`),
    INDEX `ix_trading_type_created_by`(`created_by`),
    INDEX `ix_trading_type_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_trading_type_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `packaging_type` (
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

    INDEX `ix_packaging_type_status`(`status`),
    INDEX `ix_packaging_type_created_by`(`created_by`),
    INDEX `ix_packaging_type_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_packaging_type_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `charge_type` (
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

    INDEX `ix_charge_type_status`(`status`),
    INDEX `ix_charge_type_created_by`(`created_by`),
    INDEX `ix_charge_type_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_charge_type_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `document_type` (
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

    INDEX `ix_document_type_status`(`status`),
    INDEX `ix_document_type_created_by`(`created_by`),
    INDEX `ix_document_type_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_document_type_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_method` (
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

    INDEX `ix_payment_method_status`(`status`),
    INDEX `ix_payment_method_created_by`(`created_by`),
    INDEX `ix_payment_method_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_payment_method_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `land_type` (
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

    INDEX `ix_land_type_status`(`status`),
    INDEX `ix_land_type_created_by`(`created_by`),
    INDEX `ix_land_type_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_land_type_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `adjustment_reason` (
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

    INDEX `ix_adjustment_reason_status`(`status`),
    INDEX `ix_adjustment_reason_created_by`(`created_by`),
    INDEX `ix_adjustment_reason_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_adjustment_reason_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `quality_grade` (
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

    INDEX `ix_quality_grade_status`(`status`),
    INDEX `ix_quality_grade_created_by`(`created_by`),
    INDEX `ix_quality_grade_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_quality_grade_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `collection_point_type` (
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

    INDEX `ix_collection_point_type_status`(`status`),
    INDEX `ix_collection_point_type_created_by`(`created_by`),
    INDEX `ix_collection_point_type_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_collection_point_type_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tea_type` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `description` VARCHAR(500) NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `is_system` BOOLEAN NOT NULL DEFAULT false,
    `manufacture_process` VARCHAR(30) NULL,
    `status` VARCHAR(30) NOT NULL DEFAULT 'active',
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_tea_type_status`(`status`),
    INDEX `ix_tea_type_created_by`(`created_by`),
    INDEX `ix_tea_type_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_tea_type_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tea_grade` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `description` VARCHAR(500) NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `is_system` BOOLEAN NOT NULL DEFAULT false,
    `tea_type_id` BIGINT UNSIGNED NULL,
    `grade_category` VARCHAR(30) NULL,
    `is_primary_grade` BOOLEAN NOT NULL DEFAULT false,
    `status` VARCHAR(30) NOT NULL DEFAULT 'active',
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_tea_grade_tea_type`(`tea_type_id`),
    INDEX `ix_tea_grade_status`(`status`),
    INDEX `ix_tea_grade_created_by`(`created_by`),
    INDEX `ix_tea_grade_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_tea_grade_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `activity_type` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `description` VARCHAR(500) NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `is_system` BOOLEAN NOT NULL DEFAULT false,
    `cost_category` VARCHAR(30) NOT NULL,
    `default_uom_id` BIGINT UNSIGNED NULL,
    `requires_material` BOOLEAN NOT NULL DEFAULT false,
    `status` VARCHAR(30) NOT NULL DEFAULT 'active',
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_activity_type_default_uom`(`default_uom_id`),
    INDEX `ix_activity_type_status`(`status`),
    INDEX `ix_activity_type_created_by`(`created_by`),
    INDEX `ix_activity_type_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_activity_type_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shift` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `description` VARCHAR(500) NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `is_system` BOOLEAN NOT NULL DEFAULT false,
    `estate_id` BIGINT UNSIGNED NULL,
    `start_time` TIME(0) NOT NULL,
    `end_time` TIME(0) NOT NULL,
    `break_minutes` INTEGER NOT NULL DEFAULT 0,
    `grace_minutes` INTEGER NOT NULL DEFAULT 0,
    `half_day_hours` DECIMAL(9, 4) NULL,
    `is_overnight` BOOLEAN NOT NULL DEFAULT false,
    `overtime_after_minutes` INTEGER NULL,
    `status` VARCHAR(30) NOT NULL DEFAULT 'active',
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_shift_estate`(`estate_id`),
    INDEX `ix_shift_status`(`status`),
    INDEX `ix_shift_created_by`(`created_by`),
    INDEX `ix_shift_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_shift_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `uom_category` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `description` VARCHAR(500) NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `is_system` BOOLEAN NOT NULL DEFAULT false,
    `base_uom_id` BIGINT UNSIGNED NULL,
    `status` VARCHAR(30) NOT NULL DEFAULT 'active',
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_uom_category_base_uom`(`base_uom_id`),
    INDEX `ix_uom_category_status`(`status`),
    INDEX `ix_uom_category_created_by`(`created_by`),
    INDEX `ix_uom_category_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_uom_category_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tea_variety` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `description` VARCHAR(500) NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `is_system` BOOLEAN NOT NULL DEFAULT false,
    `variety_type` VARCHAR(30) NULL,
    `recommended_spacing` VARCHAR(100) NULL,
    `typical_yield_kg_ha` DECIMAL(14, 3) NULL,
    `status` VARCHAR(30) NOT NULL DEFAULT 'active',
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_tea_variety_status`(`status`),
    INDEX `ix_tea_variety_created_by`(`created_by`),
    INDEX `ix_tea_variety_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_tea_variety_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `uom` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `uom_category_id` BIGINT UNSIGNED NOT NULL,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `decimal_precision` SMALLINT NOT NULL DEFAULT 3,
    `conversion_factor` DECIMAL(9, 4) NULL,
    `is_base` BOOLEAN NOT NULL DEFAULT false,
    `is_system` BOOLEAN NOT NULL DEFAULT false,
    `status` VARCHAR(30) NOT NULL DEFAULT 'active',
    -- HAND-EDIT: generated: the category while this is its base unit, so a category has one base at most.
    `base_key` BIGINT UNSIGNED GENERATED ALWAYS AS (CASE WHEN `is_base` = 1 THEN `uom_category_id` END) STORED,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_uom_uom_category`(`uom_category_id`),
    INDEX `ix_uom_status`(`status`),
    INDEX `ix_uom_created_by`(`created_by`),
    INDEX `ix_uom_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_uom_code`(`code`),
    UNIQUE INDEX `ux_uom_base`(`base_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `currency` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `code` CHAR(3) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `symbol` VARCHAR(10) NULL,
    `decimal_places` SMALLINT NOT NULL DEFAULT 2,
    `is_base` BOOLEAN NOT NULL DEFAULT false,
    `status` VARCHAR(30) NOT NULL DEFAULT 'active',
    -- HAND-EDIT: generated: 1 for the base currency, so there is one base currency at most.
    `base_key` TINYINT GENERATED ALWAYS AS (CASE WHEN `is_base` = 1 THEN 1 END) STORED,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_currency_status`(`status`),
    INDEX `ix_currency_created_by`(`created_by`),
    INDEX `ix_currency_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_currency_code`(`code`),
    UNIQUE INDEX `ux_currency_base`(`base_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `country` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `iso2` CHAR(2) NOT NULL,
    `iso3` CHAR(3) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `dialling_code` VARCHAR(10) NULL,
    `status` VARCHAR(30) NOT NULL DEFAULT 'active',
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_country_status`(`status`),
    INDEX `ix_country_created_by`(`created_by`),
    INDEX `ix_country_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_country_iso2`(`iso2`),
    UNIQUE INDEX `ux_country_iso3`(`iso3`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `ix_organisation_country` ON `organisation`(`country_id`);

-- CreateIndex
CREATE INDEX `ix_organisation_base_currency` ON `organisation`(`base_currency_id`);

-- HAND-EDIT: an organisation row created before this migration (P1.07, staging) has no country or base
-- currency yet. Give it the base currency BDT and Bangladesh, created by whoever created the organisation,
-- BEFORE the columns become NOT NULL. On a fresh database there is no organisation row: nothing is
-- inserted here and the seed creates all three (BACKLOG D-1.10-2). Moved below the CREATE TABLEs.
INSERT INTO `currency` (`code`, `name`, `symbol`, `decimal_places`, `is_base`, `created_by`)
  SELECT 'BDT', 'Bangladeshi taka', '৳', 2, true, `created_by` FROM `organisation` LIMIT 1;
INSERT INTO `country` (`iso2`, `iso3`, `name`, `dialling_code`, `created_by`)
  SELECT 'BD', 'BGD', 'Bangladesh', '+880', `created_by` FROM `organisation` LIMIT 1;
UPDATE `organisation`
  SET `base_currency_id` = COALESCE(`base_currency_id`, (SELECT `id` FROM `currency` WHERE `code` = 'BDT')),
      `country_id` = COALESCE(`country_id`, (SELECT `id` FROM `country` WHERE `iso2` = 'BD'));

-- AlterTable
ALTER TABLE `organisation` MODIFY `country_id` BIGINT UNSIGNED NOT NULL,
    MODIFY `base_currency_id` BIGINT UNSIGNED NOT NULL;

-- AddForeignKey
ALTER TABLE `organisation` ADD CONSTRAINT `fk_organisation_country` FOREIGN KEY (`country_id`) REFERENCES `country`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `organisation` ADD CONSTRAINT `fk_organisation_base_currency` FOREIGN KEY (`base_currency_id`) REFERENCES `currency`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `department` ADD CONSTRAINT `fk_department_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `department` ADD CONSTRAINT `fk_department_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `designation` ADD CONSTRAINT `fk_designation_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `designation` ADD CONSTRAINT `fk_designation_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `worker_category` ADD CONSTRAINT `fk_worker_category_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `worker_category` ADD CONSTRAINT `fk_worker_category_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `employee_category` ADD CONSTRAINT `fk_employee_category_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `employee_category` ADD CONSTRAINT `fk_employee_category_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `employment_type` ADD CONSTRAINT `fk_employment_type_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `employment_type` ADD CONSTRAINT `fk_employment_type_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `leave_type` ADD CONSTRAINT `fk_leave_type_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `leave_type` ADD CONSTRAINT `fk_leave_type_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `buyer_type` ADD CONSTRAINT `fk_buyer_type_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `buyer_type` ADD CONSTRAINT `fk_buyer_type_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `trading_type` ADD CONSTRAINT `fk_trading_type_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `trading_type` ADD CONSTRAINT `fk_trading_type_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `packaging_type` ADD CONSTRAINT `fk_packaging_type_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `packaging_type` ADD CONSTRAINT `fk_packaging_type_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `charge_type` ADD CONSTRAINT `fk_charge_type_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `charge_type` ADD CONSTRAINT `fk_charge_type_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `document_type` ADD CONSTRAINT `fk_document_type_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `document_type` ADD CONSTRAINT `fk_document_type_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payment_method` ADD CONSTRAINT `fk_payment_method_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payment_method` ADD CONSTRAINT `fk_payment_method_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `land_type` ADD CONSTRAINT `fk_land_type_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `land_type` ADD CONSTRAINT `fk_land_type_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `adjustment_reason` ADD CONSTRAINT `fk_adjustment_reason_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `adjustment_reason` ADD CONSTRAINT `fk_adjustment_reason_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `quality_grade` ADD CONSTRAINT `fk_quality_grade_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `quality_grade` ADD CONSTRAINT `fk_quality_grade_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `collection_point_type` ADD CONSTRAINT `fk_collection_point_type_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `collection_point_type` ADD CONSTRAINT `fk_collection_point_type_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `tea_type` ADD CONSTRAINT `fk_tea_type_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `tea_type` ADD CONSTRAINT `fk_tea_type_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `tea_grade` ADD CONSTRAINT `fk_tea_grade_tea_type` FOREIGN KEY (`tea_type_id`) REFERENCES `tea_type`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `tea_grade` ADD CONSTRAINT `fk_tea_grade_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `tea_grade` ADD CONSTRAINT `fk_tea_grade_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `activity_type` ADD CONSTRAINT `fk_activity_type_default_uom` FOREIGN KEY (`default_uom_id`) REFERENCES `uom`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `activity_type` ADD CONSTRAINT `fk_activity_type_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `activity_type` ADD CONSTRAINT `fk_activity_type_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `shift` ADD CONSTRAINT `fk_shift_estate` FOREIGN KEY (`estate_id`) REFERENCES `estate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `shift` ADD CONSTRAINT `fk_shift_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `shift` ADD CONSTRAINT `fk_shift_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `uom_category` ADD CONSTRAINT `fk_uom_category_base_uom` FOREIGN KEY (`base_uom_id`) REFERENCES `uom`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `uom_category` ADD CONSTRAINT `fk_uom_category_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `uom_category` ADD CONSTRAINT `fk_uom_category_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `tea_variety` ADD CONSTRAINT `fk_tea_variety_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `tea_variety` ADD CONSTRAINT `fk_tea_variety_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `uom` ADD CONSTRAINT `fk_uom_uom_category` FOREIGN KEY (`uom_category_id`) REFERENCES `uom_category`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `uom` ADD CONSTRAINT `fk_uom_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `uom` ADD CONSTRAINT `fk_uom_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `currency` ADD CONSTRAINT `fk_currency_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `currency` ADD CONSTRAINT `fk_currency_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `country` ADD CONSTRAINT `fk_country_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `country` ADD CONSTRAINT `fk_country_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- HAND-EDIT: CHECK constraints (prisma/README.md). Every lookup: status; the enums of P3 §5.2–§5.4, §7.1.
ALTER TABLE `department` ADD CONSTRAINT `ck_department_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `designation` ADD CONSTRAINT `ck_designation_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `worker_category` ADD CONSTRAINT `ck_worker_category_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `employee_category` ADD CONSTRAINT `ck_employee_category_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `employment_type` ADD CONSTRAINT `ck_employment_type_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `leave_type` ADD CONSTRAINT `ck_leave_type_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `buyer_type` ADD CONSTRAINT `ck_buyer_type_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `trading_type` ADD CONSTRAINT `ck_trading_type_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `packaging_type` ADD CONSTRAINT `ck_packaging_type_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `charge_type` ADD CONSTRAINT `ck_charge_type_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `document_type` ADD CONSTRAINT `ck_document_type_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `payment_method` ADD CONSTRAINT `ck_payment_method_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `land_type` ADD CONSTRAINT `ck_land_type_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `adjustment_reason` ADD CONSTRAINT `ck_adjustment_reason_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `quality_grade` ADD CONSTRAINT `ck_quality_grade_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `collection_point_type` ADD CONSTRAINT `ck_collection_point_type_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `tea_type` ADD CONSTRAINT `ck_tea_type_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `tea_grade` ADD CONSTRAINT `ck_tea_grade_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `activity_type` ADD CONSTRAINT `ck_activity_type_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `shift` ADD CONSTRAINT `ck_shift_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `uom_category` ADD CONSTRAINT `ck_uom_category_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `tea_variety` ADD CONSTRAINT `ck_tea_variety_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `uom` ADD CONSTRAINT `ck_uom_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `currency` ADD CONSTRAINT `ck_currency_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `country` ADD CONSTRAINT `ck_country_status` CHECK (`status` IN ('active', 'inactive'));

ALTER TABLE `tea_type` ADD CONSTRAINT `ck_tea_type_process` CHECK (`manufacture_process` IS NULL OR `manufacture_process` IN ('ctc', 'orthodox', 'green', 'oolong', 'white', 'other'));
ALTER TABLE `tea_grade` ADD CONSTRAINT `ck_tea_grade_category` CHECK (`grade_category` IS NULL OR `grade_category` IN ('leaf', 'broken', 'fannings', 'dust'));
ALTER TABLE `activity_type` ADD CONSTRAINT `ck_activity_type_cost_category` CHECK (`cost_category` IN ('cultivation', 'maintenance', 'protection', 'harvesting', 'other'));
ALTER TABLE `tea_variety`
  ADD CONSTRAINT `ck_tea_variety_type` CHECK (`variety_type` IS NULL OR `variety_type` IN ('clonal', 'seedling', 'hybrid')),
  ADD CONSTRAINT `ck_tea_variety_yield` CHECK (`typical_yield_kg_ha` IS NULL OR `typical_yield_kg_ha` >= 0);
-- A night shift ends on the following day: is_overnight says so exactly when end_time is not after start_time.
ALTER TABLE `shift`
  ADD CONSTRAINT `ck_shift_minutes` CHECK (`break_minutes` >= 0 AND `grace_minutes` >= 0 AND (`overtime_after_minutes` IS NULL OR `overtime_after_minutes` >= 0)),
  ADD CONSTRAINT `ck_shift_half_day` CHECK (`half_day_hours` IS NULL OR (`half_day_hours` > 0 AND `half_day_hours` <= 24)),
  ADD CONSTRAINT `ck_shift_overnight` CHECK (`is_overnight` = (`end_time` <= `start_time`));
-- The base unit converts to itself; a factor, where given, is positive.
ALTER TABLE `uom`
  ADD CONSTRAINT `ck_uom_precision` CHECK (`decimal_precision` BETWEEN 0 AND 6),
  ADD CONSTRAINT `ck_uom_factor` CHECK (`conversion_factor` IS NULL OR `conversion_factor` > 0),
  ADD CONSTRAINT `ck_uom_base_factor` CHECK (`is_base` = 0 OR `conversion_factor` = 1);
ALTER TABLE `currency`
  ADD CONSTRAINT `ck_currency_code` CHECK (`code` REGEXP '^[A-Z]{3}$'),
  ADD CONSTRAINT `ck_currency_decimals` CHECK (`decimal_places` BETWEEN 0 AND 4);
ALTER TABLE `country`
  ADD CONSTRAINT `ck_country_iso` CHECK (`iso2` REGEXP '^[A-Z]{2}$' AND `iso3` REGEXP '^[A-Z]{3}$');

-- HAND-EDIT: per-table rights for the app account. A lookup row is deleted only while nothing refers to it
-- (and never when is_system); otherwise it is deactivated.
GRANT UPDATE, DELETE ON `department` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `designation` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `worker_category` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `employee_category` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `employment_type` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `leave_type` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `buyer_type` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `trading_type` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `packaging_type` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `charge_type` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `document_type` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `payment_method` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `land_type` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `adjustment_reason` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `quality_grade` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `collection_point_type` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `tea_type` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `tea_grade` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `activity_type` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `shift` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `uom_category` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `tea_variety` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `uom` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `currency` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `country` TO 'rupai_app'@'%';

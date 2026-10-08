-- CreateTable
CREATE TABLE `factory` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `organisation_id` BIGINT UNSIGNED NOT NULL,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `factory_type` VARCHAR(30) NOT NULL,
    `primary_estate_id` BIGINT UNSIGNED NULL,
    `location` VARCHAR(200) NULL,
    `daily_capacity_kg` DECIMAL(14, 3) NULL,
    `manager_profile_id` BIGINT UNSIGNED NULL,
    `licence_number` VARCHAR(50) NULL,
    `licence_expiry` DATE NULL,
    `status` VARCHAR(30) NOT NULL DEFAULT 'active',
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_factory_primary_estate`(`primary_estate_id`),
    INDEX `ix_factory_licence_expiry`(`licence_expiry`),
    INDEX `ix_factory_status`(`status`),
    INDEX `ix_factory_created_by`(`created_by`),
    INDEX `ix_factory_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_factory_code`(`organisation_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `warehouse` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `organisation_id` BIGINT UNSIGNED NOT NULL,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `warehouse_type` VARCHAR(30) NOT NULL,
    `location` VARCHAR(200) NULL,
    `capacity_kg` DECIMAL(14, 3) NULL,
    `keeper_profile_id` BIGINT UNSIGNED NULL,
    `phone` VARCHAR(30) NULL,
    `licence_number` VARCHAR(50) NULL,
    `licence_expiry` DATE NULL,
    `tin` VARCHAR(30) NULL,
    `vat_registration` VARCHAR(30) NULL,
    `status` VARCHAR(30) NOT NULL DEFAULT 'active',
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_warehouse_licence_expiry`(`licence_expiry`),
    INDEX `ix_warehouse_status`(`status`),
    INDEX `ix_warehouse_created_by`(`created_by`),
    INDEX `ix_warehouse_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_warehouse_code`(`organisation_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `party` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `party_type` VARCHAR(30) NOT NULL,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `national_id` VARCHAR(30) NULL,
    `registration_number` VARCHAR(50) NULL,
    `address_line1` VARCHAR(200) NULL,
    `district` VARCHAR(100) NULL,
    `phone` VARCHAR(30) NULL,
    `email` VARCHAR(150) NULL,
    `status` VARCHAR(30) NOT NULL DEFAULT 'active',
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_party_type`(`party_type`),
    INDEX `ix_party_name`(`name`),
    INDEX `ix_party_created_by`(`created_by`),
    INDEX `ix_party_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_party_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `party_contact` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `owner_type` VARCHAR(30) NOT NULL,
    `owner_id` BIGINT UNSIGNED NOT NULL,
    `contact_name` VARCHAR(150) NOT NULL,
    `designation` VARCHAR(100) NULL,
    `contact_type` VARCHAR(30) NOT NULL,
    `phone` VARCHAR(30) NULL,
    `phone_alt` VARCHAR(30) NULL,
    `email` VARCHAR(150) NULL,
    `is_primary` BOOLEAN NOT NULL DEFAULT false,
    `status` VARCHAR(30) NOT NULL DEFAULT 'active',
    -- HAND-EDIT: generated: the owner while this is its active primary contact, else NULL. Its unique index
    -- makes "at most one primary per owner" (P3 §6.2) a database guarantee, not only an application rule.
    `primary_key` VARCHAR(60) GENERATED ALWAYS AS (CASE WHEN `is_primary` = 1 AND `status` = 'active' THEN CONCAT(`owner_type`, ':', `owner_id`) END) STORED,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_party_contact_owner`(`owner_type`, `owner_id`),
    INDEX `ix_party_contact_created_by`(`created_by`),
    INDEX `ix_party_contact_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_party_contact_primary`(`primary_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `factory` ADD CONSTRAINT `fk_factory_organisation` FOREIGN KEY (`organisation_id`) REFERENCES `organisation`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `factory` ADD CONSTRAINT `fk_factory_primary_estate` FOREIGN KEY (`primary_estate_id`) REFERENCES `estate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `factory` ADD CONSTRAINT `fk_factory_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `factory` ADD CONSTRAINT `fk_factory_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `warehouse` ADD CONSTRAINT `fk_warehouse_organisation` FOREIGN KEY (`organisation_id`) REFERENCES `organisation`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `warehouse` ADD CONSTRAINT `fk_warehouse_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `warehouse` ADD CONSTRAINT `fk_warehouse_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `party` ADD CONSTRAINT `fk_party_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `party` ADD CONSTRAINT `fk_party_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `party_contact` ADD CONSTRAINT `fk_party_contact_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `party_contact` ADD CONSTRAINT `fk_party_contact_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- HAND-EDIT: CHECK constraints (prisma/README.md).
ALTER TABLE `factory`
  ADD CONSTRAINT `ck_factory_type` CHECK (`factory_type` IN ('own', 'external')),
  ADD CONSTRAINT `ck_factory_status` CHECK (`status` IN ('active', 'inactive')),
  ADD CONSTRAINT `ck_factory_capacity` CHECK (`daily_capacity_kg` IS NULL OR `daily_capacity_kg` >= 0);

ALTER TABLE `warehouse`
  ADD CONSTRAINT `ck_warehouse_type` CHECK (`warehouse_type` IN ('own', 'rented', 'third_party')),
  ADD CONSTRAINT `ck_warehouse_status` CHECK (`status` IN ('active', 'inactive')),
  ADD CONSTRAINT `ck_warehouse_capacity` CHECK (`capacity_kg` IS NULL OR `capacity_kg` >= 0);

ALTER TABLE `party`
  ADD CONSTRAINT `ck_party_type` CHECK (`party_type` IN ('individual', 'organisation', 'government')),
  ADD CONSTRAINT `ck_party_status` CHECK (`status` IN ('active', 'inactive'));

ALTER TABLE `party_contact`
  ADD CONSTRAINT `ck_party_contact_owner_type` CHECK (`owner_type` IN
    ('buyer', 'broker', 'supplier', 'leaf_supplier', 'contractor', 'warehouse', 'party', 'auction_centre')),
  ADD CONSTRAINT `ck_party_contact_type` CHECK (`contact_type` IN ('primary', 'accounts', 'operations', 'emergency', 'other')),
  ADD CONSTRAINT `ck_party_contact_status` CHECK (`status` IN ('active', 'inactive'));

-- HAND-EDIT: facility grants name a factory or a warehouse (BACKLOG D-1.08-1). P3's single 'facility' type
-- cannot say which, because their ids are separate sequences. No facility grant can exist yet: P1.03
-- had no facility table to point at.
ALTER TABLE `user_scope` DROP CHECK `ck_user_scope_type`;
ALTER TABLE `user_scope`
  ADD CONSTRAINT `ck_user_scope_type` CHECK (`scope_type` IN
    ('all_estates', 'estate', 'division', 'section', 'department', 'factory', 'warehouse', 'self'));

-- HAND-EDIT: per-table rights for the app account. Facilities and parties are deleted only while nothing
-- references them, otherwise deactivated; contacts are removed outright (audited), nothing refers to one.
GRANT UPDATE, DELETE ON `factory` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `warehouse` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `party` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `party_contact` TO 'rupai_app'@'%';

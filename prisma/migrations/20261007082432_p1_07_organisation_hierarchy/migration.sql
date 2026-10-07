-- CreateTable
CREATE TABLE `organisation` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(150) NOT NULL,
    `short_name` VARCHAR(50) NOT NULL,
    `registration_number` VARCHAR(50) NULL,
    `tin` VARCHAR(30) NULL,
    `vat_registration` VARCHAR(30) NULL,
    `address_line1` VARCHAR(200) NULL,
    `address_line2` VARCHAR(200) NULL,
    `city` VARCHAR(100) NULL,
    `postal_code` VARCHAR(20) NULL,
    `country_id` BIGINT UNSIGNED NULL,
    `phone` VARCHAR(30) NULL,
    `email` VARCHAR(150) NULL,
    `website` VARCHAR(150) NULL,
    `logo_path` VARCHAR(255) NULL,
    `base_currency_id` BIGINT UNSIGNED NULL,
    `fiscal_year_start_month` SMALLINT NOT NULL,
    `status` VARCHAR(30) NOT NULL DEFAULT 'active',
    -- HAND-EDIT: generated, always 1, under a unique index: a second organisation row is impossible (P3 §4.1).
    `singleton` TINYINT GENERATED ALWAYS AS (1) STORED,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_organisation_created_by`(`created_by`),
    INDEX `ix_organisation_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_organisation_singleton`(`singleton`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `estate` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `organisation_id` BIGINT UNSIGNED NOT NULL,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `location` VARCHAR(200) NULL,
    `address_line1` VARCHAR(200) NULL,
    `district` VARCHAR(100) NULL,
    `total_area` DECIMAL(14, 3) NULL,
    `manager_profile_id` BIGINT UNSIGNED NULL,
    `phone` VARCHAR(30) NULL,
    `email` VARCHAR(150) NULL,
    `established_on` DATE NULL,
    `ownership_type` VARCHAR(30) NULL,
    `status` VARCHAR(30) NOT NULL DEFAULT 'active',
    `remarks` VARCHAR(500) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_estate_status`(`status`),
    INDEX `ix_estate_manager`(`manager_profile_id`),
    INDEX `ix_estate_created_by`(`created_by`),
    INDEX `ix_estate_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_estate_code`(`organisation_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `division` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `estate_id` BIGINT UNSIGNED NOT NULL,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `manager_profile_id` BIGINT UNSIGNED NULL,
    `area` DECIMAL(14, 3) NULL,
    `status` VARCHAR(30) NOT NULL DEFAULT 'active',
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_division_status`(`status`),
    INDEX `ix_division_manager`(`manager_profile_id`),
    INDEX `ix_division_created_by`(`created_by`),
    INDEX `ix_division_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_division_code`(`estate_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `section` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `division_id` BIGINT UNSIGNED NOT NULL,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `supervisor_profile_id` BIGINT UNSIGNED NULL,
    `area` DECIMAL(14, 3) NULL,
    `status` VARCHAR(30) NOT NULL DEFAULT 'active',
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_section_status`(`status`),
    INDEX `ix_section_supervisor`(`supervisor_profile_id`),
    INDEX `ix_section_created_by`(`created_by`),
    INDEX `ix_section_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_section_code`(`division_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `field` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `section_id` BIGINT UNSIGNED NOT NULL,
    `estate_id` BIGINT UNSIGNED NOT NULL,
    `field_number` VARCHAR(20) NOT NULL,
    `name` VARCHAR(150) NULL,
    `gross_area` DECIMAL(14, 3) NOT NULL,
    `planted_area` DECIMAL(14, 3) NULL,
    `field_status` VARCHAR(30) NOT NULL,
    `section_effective_from` DATE NULL,
    `status` VARCHAR(30) NOT NULL DEFAULT 'active',
    `remarks` VARCHAR(500) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_field_section`(`section_id`),
    INDEX `ix_field_status`(`field_status`),
    INDEX `ix_field_created_by`(`created_by`),
    INDEX `ix_field_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_field_number`(`estate_id`, `field_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `organisation` ADD CONSTRAINT `fk_organisation_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `organisation` ADD CONSTRAINT `fk_organisation_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `estate` ADD CONSTRAINT `fk_estate_organisation` FOREIGN KEY (`organisation_id`) REFERENCES `organisation`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `estate` ADD CONSTRAINT `fk_estate_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `estate` ADD CONSTRAINT `fk_estate_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `division` ADD CONSTRAINT `fk_division_estate` FOREIGN KEY (`estate_id`) REFERENCES `estate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `division` ADD CONSTRAINT `fk_division_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `division` ADD CONSTRAINT `fk_division_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `section` ADD CONSTRAINT `fk_section_division` FOREIGN KEY (`division_id`) REFERENCES `division`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `section` ADD CONSTRAINT `fk_section_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `section` ADD CONSTRAINT `fk_section_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `field` ADD CONSTRAINT `fk_field_section` FOREIGN KEY (`section_id`) REFERENCES `section`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `field` ADD CONSTRAINT `fk_field_estate` FOREIGN KEY (`estate_id`) REFERENCES `estate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `field` ADD CONSTRAINT `fk_field_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `field` ADD CONSTRAINT `fk_field_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- HAND-EDIT: CHECK constraints (prisma/README.md).
ALTER TABLE `organisation`
  ADD CONSTRAINT `ck_organisation_fiscal_month` CHECK (`fiscal_year_start_month` BETWEEN 1 AND 12),
  ADD CONSTRAINT `ck_organisation_status` CHECK (`status` IN ('active', 'inactive'));

ALTER TABLE `estate`
  ADD CONSTRAINT `ck_estate_status` CHECK (`status` IN ('active', 'inactive')),
  ADD CONSTRAINT `ck_estate_ownership` CHECK (`ownership_type` IS NULL OR `ownership_type` IN ('owned', 'leased', 'government_lease', 'other')),
  ADD CONSTRAINT `ck_estate_area` CHECK (`total_area` IS NULL OR `total_area` >= 0);

ALTER TABLE `division`
  ADD CONSTRAINT `ck_division_status` CHECK (`status` IN ('active', 'inactive')),
  ADD CONSTRAINT `ck_division_area` CHECK (`area` IS NULL OR `area` >= 0);

ALTER TABLE `section`
  ADD CONSTRAINT `ck_section_status` CHECK (`status` IN ('active', 'inactive')),
  ADD CONSTRAINT `ck_section_area` CHECK (`area` IS NULL OR `area` >= 0);

-- planted_area <= gross_area is P3 §4.5's own CHECK.
ALTER TABLE `field`
  ADD CONSTRAINT `ck_field_status` CHECK (`status` IN ('active', 'inactive')),
  ADD CONSTRAINT `ck_field_field_status` CHECK (`field_status` IN ('producing', 'young', 'nursery', 'uprooted', 'fallow', 'abandoned')),
  ADD CONSTRAINT `ck_field_gross_area` CHECK (`gross_area` > 0),
  ADD CONSTRAINT `ck_field_planted_area` CHECK (`planted_area` IS NULL OR (`planted_area` >= 0 AND `planted_area` <= `gross_area`));

-- HAND-EDIT: per-table rights for the app account. The organisation is edited, never deleted. The
-- hierarchy may be deleted only while nothing references it (foreign keys RESTRICT; the service also
-- checks scope grants, which have no foreign key); afterwards it is deactivated (P1 §5.1).
GRANT UPDATE ON `organisation` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `estate` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `division` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `section` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `field` TO 'rupai_app'@'%';

-- AlterTable
ALTER TABLE `estate` ADD COLUMN `admin_division` VARCHAR(100) NULL,
    ADD COLUMN `country_id` BIGINT UNSIGNED NULL,
    ADD COLUMN `description` TEXT NULL,
    ADD COLUMN `established_year` SMALLINT NULL,
    ADD COLUMN `estate_category` VARCHAR(30) NULL,
    ADD COLUMN `estate_type` VARCHAR(30) NULL,
    ADD COLUMN `latitude` DECIMAL(9, 6) NULL,
    ADD COLUMN `longitude` DECIMAL(9, 6) NULL,
    ADD COLUMN `other_amenities` VARCHAR(300) NULL,
    ADD COLUMN `owner_name` VARCHAR(150) NULL,
    ADD COLUMN `police_station` VARCHAR(100) NULL,
    ADD COLUMN `postal_code` VARCHAR(20) NULL,
    ADD COLUMN `website` VARCHAR(150) NULL;

-- CreateTable
CREATE TABLE `amenity` (
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

    INDEX `ix_amenity_status`(`status`),
    INDEX `ix_amenity_created_by`(`created_by`),
    INDEX `ix_amenity_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_amenity_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `estate_amenity` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `estate_id` BIGINT UNSIGNED NOT NULL,
    `amenity_id` BIGINT UNSIGNED NOT NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,

    INDEX `ix_estate_amenity_amenity`(`amenity_id`),
    INDEX `ix_estate_amenity_created_by`(`created_by`),
    UNIQUE INDEX `ux_estate_amenity`(`estate_id`, `amenity_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `ix_estate_country` ON `estate`(`country_id`);

-- AddForeignKey
ALTER TABLE `estate` ADD CONSTRAINT `fk_estate_country` FOREIGN KEY (`country_id`) REFERENCES `country`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `amenity` ADD CONSTRAINT `fk_amenity_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `amenity` ADD CONSTRAINT `fk_amenity_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `estate_amenity` ADD CONSTRAINT `fk_estate_amenity_estate` FOREIGN KEY (`estate_id`) REFERENCES `estate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `estate_amenity` ADD CONSTRAINT `fk_estate_amenity_amenity` FOREIGN KEY (`amenity_id`) REFERENCES `amenity`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `estate_amenity` ADD CONSTRAINT `fk_estate_amenity_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- HAND-EDIT: CHECK constraints (prisma/README.md).
ALTER TABLE `estate`
  ADD CONSTRAINT `ck_estate_type` CHECK (`estate_type` IS NULL OR `estate_type` IN ('company_owned', 'private_estate', 'government_estate')),
  ADD CONSTRAINT `ck_estate_category` CHECK (`estate_category` IS NULL OR `estate_category` IN ('large', 'medium', 'small')),
  -- A CHECK cannot read the clock; "not in the future" is the service's.
  ADD CONSTRAINT `ck_estate_established_year` CHECK (`established_year` IS NULL OR `established_year` BETWEEN 1800 AND 2100),
  -- A position is both coordinates or neither.
  ADD CONSTRAINT `ck_estate_position` CHECK (
    (`latitude` IS NULL) = (`longitude` IS NULL)
    AND (`latitude` IS NULL OR `latitude` BETWEEN -90 AND 90)
    AND (`longitude` IS NULL OR `longitude` BETWEEN -180 AND 180));

ALTER TABLE `amenity`
  ADD CONSTRAINT `ck_amenity_status` CHECK (`status` IN ('active', 'inactive'));

-- Estates and their key people are contacts too (Estate Manager, Assistant Manager), until employment
-- profiles exist (Phase 2).
ALTER TABLE `party_contact`
  DROP CHECK `ck_party_contact_owner_type`,
  DROP CHECK `ck_party_contact_type`;
ALTER TABLE `party_contact`
  ADD CONSTRAINT `ck_party_contact_owner_type` CHECK (`owner_type` IN
    ('buyer', 'broker', 'supplier', 'leaf_supplier', 'contractor', 'warehouse', 'party', 'auction_centre', 'estate')),
  ADD CONSTRAINT `ck_party_contact_type` CHECK (`contact_type` IN
    ('primary', 'accounts', 'operations', 'emergency', 'other', 'estate_manager', 'assistant_manager'));

-- HAND-EDIT: data. Expand only: established_on and ownership_type stay (unused) until a contract
-- migration, so the previous API keeps working during a deploy.
UPDATE `estate` SET `established_year` = YEAR(`established_on`) WHERE `established_on` IS NOT NULL;
UPDATE `estate` SET `estate_type` = CASE `ownership_type`
    WHEN 'owned' THEN 'company_owned'
    WHEN 'government_lease' THEN 'government_estate'
    WHEN 'leased' THEN 'private_estate'
    ELSE NULL END
  WHERE `ownership_type` IS NOT NULL;

-- Areas are acres from now on (decision of 2026-10-14). 1 hectare = 2.4710538 acres. Rounding is
-- monotonic, so planted_area <= gross_area still holds.
UPDATE `estate`   SET `total_area` = ROUND(`total_area` * 2.4710538, 3) WHERE `total_area` IS NOT NULL;
UPDATE `division` SET `area` = ROUND(`area` * 2.4710538, 3) WHERE `area` IS NOT NULL;
UPDATE `section`  SET `area` = ROUND(`area` * 2.4710538, 3) WHERE `area` IS NOT NULL;
UPDATE `field`    SET `gross_area` = ROUND(`gross_area` * 2.4710538, 3),
                      `planted_area` = ROUND(`planted_area` * 2.4710538, 3);

-- HAND-EDIT: per-table rights for the app account. amenity is a reference list (edited and deleted
-- like the others). estate_amenity is replaced as a set when an estate is saved (DELETE), never updated.
GRANT UPDATE, DELETE ON `amenity` TO 'rupai_app'@'%';
GRANT DELETE ON `estate_amenity` TO 'rupai_app'@'%';

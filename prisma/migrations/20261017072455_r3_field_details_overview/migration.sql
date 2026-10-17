-- AlterTable
ALTER TABLE `division` ADD COLUMN `description` VARCHAR(1000) NULL;

-- AlterTable
ALTER TABLE `estate` ADD COLUMN `division_count` INTEGER NULL,
    ADD COLUMN `family_count` INTEGER NULL,
    ADD COLUMN `field_count` INTEGER NULL,
    ADD COLUMN `non_tea_area` DECIMAL(14, 3) NULL,
    ADD COLUMN `section_count` INTEGER NULL,
    ADD COLUMN `tea_area` DECIMAL(14, 3) NULL,
    ADD COLUMN `worker_count` INTEGER NULL;

-- AlterTable
ALTER TABLE `field` ADD COLUMN `altitude` DECIMAL(8, 2) NULL,
    ADD COLUMN `average_slope` DECIMAL(5, 2) NULL,
    ADD COLUMN `drainage_class_id` BIGINT UNSIGNED NULL,
    ADD COLUMN `field_type` VARCHAR(30) NOT NULL DEFAULT 'tea_field',
    ADD COLUMN `irrigation_source_id` BIGINT UNSIGNED NULL,
    ADD COLUMN `parent_field_id` BIGINT UNSIGNED NULL,
    ADD COLUMN `planting_year` SMALLINT NULL,
    ADD COLUMN `soil_type_id` BIGINT UNSIGNED NULL,
    ADD COLUMN `spacing` VARCHAR(50) NULL,
    ADD COLUMN `tea_variety_id` BIGINT UNSIGNED NULL;

-- AlterTable
ALTER TABLE `section` ADD COLUMN `description` VARCHAR(1000) NULL,
    ADD COLUMN `parent_section_id` BIGINT UNSIGNED NULL;

-- CreateTable
CREATE TABLE `irrigation_source` (
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

    INDEX `ix_irrigation_source_status`(`status`),
    INDEX `ix_irrigation_source_created_by`(`created_by`),
    INDEX `ix_irrigation_source_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_irrigation_source_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `soil_type` (
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

    INDEX `ix_soil_type_status`(`status`),
    INDEX `ix_soil_type_created_by`(`created_by`),
    INDEX `ix_soil_type_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_soil_type_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `drainage_class` (
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

    INDEX `ix_drainage_class_status`(`status`),
    INDEX `ix_drainage_class_created_by`(`created_by`),
    INDEX `ix_drainage_class_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_drainage_class_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `ix_field_type` ON `field`(`field_type`);

-- CreateIndex
CREATE INDEX `ix_field_parent` ON `field`(`parent_field_id`);

-- CreateIndex
CREATE INDEX `ix_field_tea_variety` ON `field`(`tea_variety_id`);

-- CreateIndex
CREATE INDEX `ix_field_irrigation_source` ON `field`(`irrigation_source_id`);

-- CreateIndex
CREATE INDEX `ix_field_soil_type` ON `field`(`soil_type_id`);

-- CreateIndex
CREATE INDEX `ix_field_drainage_class` ON `field`(`drainage_class_id`);

-- CreateIndex
CREATE INDEX `ix_section_parent` ON `section`(`parent_section_id`);

-- AddForeignKey
ALTER TABLE `section` ADD CONSTRAINT `fk_section_parent` FOREIGN KEY (`parent_section_id`) REFERENCES `section`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `field` ADD CONSTRAINT `fk_field_parent` FOREIGN KEY (`parent_field_id`) REFERENCES `field`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `field` ADD CONSTRAINT `fk_field_tea_variety` FOREIGN KEY (`tea_variety_id`) REFERENCES `tea_variety`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `field` ADD CONSTRAINT `fk_field_irrigation_source` FOREIGN KEY (`irrigation_source_id`) REFERENCES `irrigation_source`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `field` ADD CONSTRAINT `fk_field_soil_type` FOREIGN KEY (`soil_type_id`) REFERENCES `soil_type`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `field` ADD CONSTRAINT `fk_field_drainage_class` FOREIGN KEY (`drainage_class_id`) REFERENCES `drainage_class`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `irrigation_source` ADD CONSTRAINT `fk_irrigation_source_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `irrigation_source` ADD CONSTRAINT `fk_irrigation_source_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `soil_type` ADD CONSTRAINT `fk_soil_type_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `soil_type` ADD CONSTRAINT `fk_soil_type_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `drainage_class` ADD CONSTRAINT `fk_drainage_class_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `drainage_class` ADD CONSTRAINT `fk_drainage_class_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- HAND-EDIT: CHECK constraints (prisma/README.md).
ALTER TABLE `field`
  ADD CONSTRAINT `ck_field_type` CHECK (`field_type` IN ('tea_field', 'nursery', 'extension', 'infrastructure',
    'drain', 'road_reserve', 'shade_area', 'road_side', 'water_body')),
  -- A CHECK cannot read the clock; "not in the future" is the service's.
  ADD CONSTRAINT `ck_field_planting_year` CHECK (`planting_year` IS NULL OR `planting_year` BETWEEN 1800 AND 2100),
  ADD CONSTRAINT `ck_field_altitude` CHECK (`altitude` IS NULL OR `altitude` BETWEEN -1000 AND 30000),
  ADD CONSTRAINT `ck_field_average_slope` CHECK (`average_slope` IS NULL OR `average_slope` BETWEEN 0 AND 90);
-- "Not its own parent, no cycles, same estate / division" is the service's: MySQL CHECKs cannot read
-- the auto-increment id or another row.

-- The overview figures as entered (RUP-625): never negative. Comparisons with total_area are the service's
-- (it names the field).
ALTER TABLE `estate`
  ADD CONSTRAINT `ck_estate_entered_figures` CHECK (
    (`tea_area` IS NULL OR `tea_area` >= 0) AND (`non_tea_area` IS NULL OR `non_tea_area` >= 0)
    AND (`division_count` IS NULL OR `division_count` >= 0) AND (`section_count` IS NULL OR `section_count` >= 0)
    AND (`field_count` IS NULL OR `field_count` >= 0) AND (`worker_count` IS NULL OR `worker_count` >= 0)
    AND (`family_count` IS NULL OR `family_count` >= 0));

ALTER TABLE `irrigation_source` ADD CONSTRAINT `ck_irrigation_source_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `soil_type` ADD CONSTRAINT `ck_soil_type_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `drainage_class` ADD CONSTRAINT `ck_drainage_class_status` CHECK (`status` IN ('active', 'inactive'));

-- HAND-EDIT: data. A field recorded as a nursery is a nursery block; every other one is a tea field.
UPDATE `field` SET `field_type` = 'nursery' WHERE `field_status` = 'nursery';

-- HAND-EDIT: per-table rights for the app account: reference lists are edited and deleted like the others.
GRANT UPDATE, DELETE ON `irrigation_source` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `soil_type` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `drainage_class` TO 'rupai_app'@'%';

-- CreateTable
CREATE TABLE `person` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `person_code` VARCHAR(20) NOT NULL,
    `registered_estate_id` BIGINT UNSIGNED NULL,
    `title` VARCHAR(10) NULL,
    `first_name` VARCHAR(100) NOT NULL,
    `middle_name` VARCHAR(100) NULL,
    `last_name` VARCHAR(100) NULL,
    `full_name` VARCHAR(200) NOT NULL,
    `father_name` VARCHAR(150) NULL,
    `mother_name` VARCHAR(150) NULL,
    `spouse_name` VARCHAR(150) NULL,
    `date_of_birth` DATE NULL,
    `gender` VARCHAR(30) NULL,
    `marital_status` VARCHAR(30) NULL,
    `blood_group` VARCHAR(10) NULL,
    `nationality_country_id` BIGINT UNSIGNED NULL,
    `religion_id` BIGINT UNSIGNED NULL,
    `national_id` VARCHAR(30) NULL,
    `birth_certificate_no` VARCHAR(30) NULL,
    `passport_no` VARCHAR(30) NULL,
    `driving_license_no` VARCHAR(30) NULL,
    `tin` VARCHAR(30) NULL,
    `phone` VARCHAR(30) NULL,
    `alternate_phone` VARCHAR(30) NULL,
    `personal_email` VARCHAR(150) NULL,
    `present_address` VARCHAR(300) NULL,
    `present_district` VARCHAR(100) NULL,
    `present_upazila` VARCHAR(100) NULL,
    `present_postal_code` VARCHAR(20) NULL,
    `permanent_address` VARCHAR(300) NULL,
    `permanent_district` VARCHAR(100) NULL,
    `permanent_upazila` VARCHAR(100) NULL,
    `permanent_postal_code` VARCHAR(20) NULL,
    `education_level_id` BIGINT UNSIGNED NULL,
    `experience_years` INTEGER NULL,
    `emergency_contact_name` VARCHAR(150) NULL,
    `emergency_contact_phone` VARCHAR(30) NULL,
    `emergency_contact_alt_phone` VARCHAR(30) NULL,
    `emergency_contact_relation` VARCHAR(30) NULL,
    `emergency_contact_address` VARCHAR(300) NULL,
    `payment_method` VARCHAR(30) NULL,
    `bank_name` VARCHAR(150) NULL,
    `bank_branch` VARCHAR(150) NULL,
    `bank_account_number` VARCHAR(40) NULL,
    `mobile_banking_provider` VARCHAR(30) NULL,
    `mobile_banking_number` VARCHAR(30) NULL,
    `remarks` VARCHAR(500) NULL,
    `status` VARCHAR(30) NOT NULL DEFAULT 'active',
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_person_first_name`(`first_name`),
    INDEX `ix_person_full_name`(`full_name`),
    INDEX `ix_person_phone`(`phone`),
    INDEX `ix_person_registered_estate`(`registered_estate_id`),
    INDEX `ix_person_nationality`(`nationality_country_id`),
    INDEX `ix_person_religion`(`religion_id`),
    INDEX `ix_person_education_level`(`education_level_id`),
    INDEX `ix_person_status`(`status`),
    INDEX `ix_person_created_by`(`created_by`),
    INDEX `ix_person_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_person_code`(`person_code`),
    UNIQUE INDEX `ux_person_nid`(`national_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `person_dependent` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `person_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `relation` VARCHAR(30) NOT NULL,
    `occupation` VARCHAR(100) NULL,
    `date_of_birth` DATE NULL,
    `gender` VARCHAR(30) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_person_dependent_person`(`person_id`),
    INDEX `ix_person_dependent_created_by`(`created_by`),
    INDEX `ix_person_dependent_updated_by`(`updated_by`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `person_skill` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `person_id` BIGINT UNSIGNED NOT NULL,
    `skill_id` BIGINT UNSIGNED NOT NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `ix_person_skill_skill`(`skill_id`),
    UNIQUE INDEX `ux_person_skill`(`person_id`, `skill_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `person_language` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `person_id` BIGINT UNSIGNED NOT NULL,
    `language_id` BIGINT UNSIGNED NOT NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `ix_person_language_language`(`language_id`),
    UNIQUE INDEX `ux_person_language`(`person_id`, `language_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `religion` (
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

    INDEX `ix_religion_status`(`status`),
    INDEX `ix_religion_created_by`(`created_by`),
    INDEX `ix_religion_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_religion_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `education_level` (
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

    INDEX `ix_education_level_status`(`status`),
    INDEX `ix_education_level_created_by`(`created_by`),
    INDEX `ix_education_level_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_education_level_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `skill` (
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

    INDEX `ix_skill_status`(`status`),
    INDEX `ix_skill_created_by`(`created_by`),
    INDEX `ix_skill_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_skill_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `language` (
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

    INDEX `ix_language_status`(`status`),
    INDEX `ix_language_created_by`(`created_by`),
    INDEX `ix_language_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_language_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `person` ADD CONSTRAINT `fk_person_registered_estate` FOREIGN KEY (`registered_estate_id`) REFERENCES `estate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `person` ADD CONSTRAINT `fk_person_nationality` FOREIGN KEY (`nationality_country_id`) REFERENCES `country`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `person` ADD CONSTRAINT `fk_person_religion` FOREIGN KEY (`religion_id`) REFERENCES `religion`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `person` ADD CONSTRAINT `fk_person_education_level` FOREIGN KEY (`education_level_id`) REFERENCES `education_level`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `person` ADD CONSTRAINT `fk_person_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `person` ADD CONSTRAINT `fk_person_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `person_dependent` ADD CONSTRAINT `fk_person_dependent_person` FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `person_dependent` ADD CONSTRAINT `fk_person_dependent_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `person_dependent` ADD CONSTRAINT `fk_person_dependent_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `person_skill` ADD CONSTRAINT `fk_person_skill_person` FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `person_skill` ADD CONSTRAINT `fk_person_skill_skill` FOREIGN KEY (`skill_id`) REFERENCES `skill`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `person_language` ADD CONSTRAINT `fk_person_language_person` FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `person_language` ADD CONSTRAINT `fk_person_language_language` FOREIGN KEY (`language_id`) REFERENCES `language`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `religion` ADD CONSTRAINT `fk_religion_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `religion` ADD CONSTRAINT `fk_religion_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `education_level` ADD CONSTRAINT `fk_education_level_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `education_level` ADD CONSTRAINT `fk_education_level_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `skill` ADD CONSTRAINT `fk_skill_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `skill` ADD CONSTRAINT `fk_skill_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `language` ADD CONSTRAINT `fk_language_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `language` ADD CONSTRAINT `fk_language_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- HAND-EDIT: CHECK constraints (prisma/README.md).
ALTER TABLE `person`
  ADD CONSTRAINT `ck_person_title` CHECK (`title` IS NULL OR `title` IN ('mr', 'mrs', 'ms', 'other')),
  ADD CONSTRAINT `ck_person_gender` CHECK (`gender` IS NULL OR `gender` IN ('male', 'female', 'other')),
  ADD CONSTRAINT `ck_person_marital_status` CHECK (`marital_status` IS NULL OR `marital_status` IN ('single', 'married', 'widowed', 'divorced')),
  ADD CONSTRAINT `ck_person_blood_group` CHECK (`blood_group` IS NULL OR `blood_group` IN ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')),
  ADD CONSTRAINT `ck_person_payment_method` CHECK (`payment_method` IS NULL OR `payment_method` IN ('bank', 'cash', 'mobile_banking')),
  ADD CONSTRAINT `ck_person_mobile_banking` CHECK (`mobile_banking_provider` IS NULL OR `mobile_banking_provider` IN ('bkash', 'nagad', 'rocket', 'upay', 'other')),
  ADD CONSTRAINT `ck_person_emergency_relation` CHECK (`emergency_contact_relation` IS NULL OR `emergency_contact_relation` IN
    ('father', 'mother', 'spouse', 'son', 'daughter', 'brother', 'sister', 'other')),
  ADD CONSTRAINT `ck_person_experience` CHECK (`experience_years` IS NULL OR `experience_years` BETWEEN 0 AND 80),
  ADD CONSTRAINT `ck_person_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `person_dependent`
  ADD CONSTRAINT `ck_person_dependent_relation` CHECK (`relation` IN ('father', 'mother', 'spouse', 'son', 'daughter', 'brother', 'sister', 'other')),
  ADD CONSTRAINT `ck_person_dependent_gender` CHECK (`gender` IS NULL OR `gender` IN ('male', 'female', 'other'));
ALTER TABLE `religion` ADD CONSTRAINT `ck_religion_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `education_level` ADD CONSTRAINT `ck_education_level_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `skill` ADD CONSTRAINT `ck_skill_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `language` ADD CONSTRAINT `ck_language_status` CHECK (`status` IN ('active', 'inactive'));


-- HAND-EDIT: per-table rights for the app account. person and person_dependent are masters (edited; a
-- person is deleted only when created in error and unreferenced). Skills and languages are replaced as a
-- set. The four lists are reference lists like the others.
GRANT UPDATE, DELETE ON `person` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `person_dependent` TO 'rupai_app'@'%';
GRANT DELETE ON `person_skill` TO 'rupai_app'@'%';
GRANT DELETE ON `person_language` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `religion` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `education_level` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `skill` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `language` TO 'rupai_app'@'%';

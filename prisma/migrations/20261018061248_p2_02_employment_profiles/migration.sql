-- CreateTable
CREATE TABLE `employment_profile` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `person_id` BIGINT UNSIGNED NOT NULL,
    `estate_id` BIGINT UNSIGNED NOT NULL,
    `employment_type` VARCHAR(30) NOT NULL,
    `profile_number` VARCHAR(20) NOT NULL,
    `worker_category_id` BIGINT UNSIGNED NULL,
    `employee_category_id` BIGINT UNSIGNED NULL,
    `engagement_type` VARCHAR(30) NOT NULL,
    `employment_basis` VARCHAR(30) NULL,
    `job_nature` VARCHAR(30) NULL,
    `working_location` VARCHAR(30) NULL,
    `job_grade_id` BIGINT UNSIGNED NULL,
    `work_email` VARCHAR(150) NULL,
    `joining_date` DATE NOT NULL,
    `confirmation_date` DATE NULL,
    `probation_end_date` DATE NULL,
    `separation_date` DATE NULL,
    `separation_type` VARCHAR(30) NULL,
    `separation_reason` VARCHAR(500) NULL,
    `supervisor_profile_id` BIGINT UNSIGNED NULL,
    `is_service_continuous` BOOLEAN NOT NULL DEFAULT true,
    `nominee_name` VARCHAR(150) NULL,
    `nominee_relation` VARCHAR(30) NULL,
    `nominee_date_of_birth` DATE NULL,
    `nominee_national_id` VARCHAR(30) NULL,
    `nominee_phone` VARCHAR(30) NULL,
    `nominee_address` VARCHAR(300) NULL,
    `remarks` VARCHAR(500) NULL,
    `status` VARCHAR(30) NOT NULL DEFAULT 'active',
    -- HAND-EDIT: one ACTIVE profile per person and type (P2 §7.3's partial unique index).
    `active_key` VARCHAR(60) GENERATED ALWAYS AS (CASE WHEN `status` = 'active' THEN CONCAT(`person_id`, ':', `employment_type`) END) STORED,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_profile_person`(`person_id`),
    INDEX `ix_profile_type`(`employment_type`),
    INDEX `ix_profile_joining`(`joining_date`),
    INDEX `ix_profile_separation`(`separation_date`),
    INDEX `ix_profile_status`(`status`),
    INDEX `ix_profile_worker_category`(`worker_category_id`),
    INDEX `ix_profile_employee_category`(`employee_category_id`),
    INDEX `ix_profile_job_grade`(`job_grade_id`),
    INDEX `ix_profile_supervisor`(`supervisor_profile_id`),
    INDEX `ix_profile_created_by`(`created_by`),
    INDEX `ix_profile_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_profile_number`(`estate_id`, `profile_number`),
    UNIQUE INDEX `ux_profile_active`(`active_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `job_grade` (
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

    INDEX `ix_job_grade_status`(`status`),
    INDEX `ix_job_grade_created_by`(`created_by`),
    INDEX `ix_job_grade_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_job_grade_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
-- HAND-EDIT: data. Profiles did not exist, so the ids held until now point at nothing (D-1.07-2): clear
-- them before the foreign keys arrive.
UPDATE `user` SET `employment_profile_id` = NULL WHERE `employment_profile_id` IS NOT NULL;
UPDATE `estate` SET `manager_profile_id` = NULL WHERE `manager_profile_id` IS NOT NULL;
UPDATE `division` SET `manager_profile_id` = NULL WHERE `manager_profile_id` IS NOT NULL;
UPDATE `section` SET `supervisor_profile_id` = NULL WHERE `supervisor_profile_id` IS NOT NULL;
UPDATE `factory` SET `manager_profile_id` = NULL WHERE `manager_profile_id` IS NOT NULL;

ALTER TABLE `user` ADD CONSTRAINT `fk_user_employment_profile` FOREIGN KEY (`employment_profile_id`) REFERENCES `employment_profile`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `estate` ADD CONSTRAINT `fk_estate_manager` FOREIGN KEY (`manager_profile_id`) REFERENCES `employment_profile`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `division` ADD CONSTRAINT `fk_division_manager` FOREIGN KEY (`manager_profile_id`) REFERENCES `employment_profile`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `section` ADD CONSTRAINT `fk_section_supervisor` FOREIGN KEY (`supervisor_profile_id`) REFERENCES `employment_profile`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `factory` ADD CONSTRAINT `fk_factory_manager` FOREIGN KEY (`manager_profile_id`) REFERENCES `employment_profile`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `employment_profile` ADD CONSTRAINT `fk_profile_person` FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `employment_profile` ADD CONSTRAINT `fk_profile_estate` FOREIGN KEY (`estate_id`) REFERENCES `estate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `employment_profile` ADD CONSTRAINT `fk_profile_worker_category` FOREIGN KEY (`worker_category_id`) REFERENCES `worker_category`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `employment_profile` ADD CONSTRAINT `fk_profile_employee_category` FOREIGN KEY (`employee_category_id`) REFERENCES `employee_category`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `employment_profile` ADD CONSTRAINT `fk_profile_job_grade` FOREIGN KEY (`job_grade_id`) REFERENCES `job_grade`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `employment_profile` ADD CONSTRAINT `fk_profile_supervisor` FOREIGN KEY (`supervisor_profile_id`) REFERENCES `employment_profile`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `employment_profile` ADD CONSTRAINT `fk_profile_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `employment_profile` ADD CONSTRAINT `fk_profile_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `job_grade` ADD CONSTRAINT `fk_job_grade_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `job_grade` ADD CONSTRAINT `fk_job_grade_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- HAND-EDIT: CHECK constraints (prisma/README.md).
ALTER TABLE `employment_profile`
  ADD CONSTRAINT `ck_profile_type` CHECK (`employment_type` IN ('worker', 'employee')),
  -- The category matches the type: a worker category for a worker, an employee category for an employee.
  ADD CONSTRAINT `ck_profile_category` CHECK (
    (`employment_type` = 'worker' AND `employee_category_id` IS NULL)
    OR (`employment_type` = 'employee' AND `worker_category_id` IS NULL)),
  ADD CONSTRAINT `ck_profile_engagement` CHECK (`engagement_type` IN
    ('permanent', 'temporary', 'seasonal', 'casual', 'probation', 'contractual')),
  ADD CONSTRAINT `ck_profile_basis` CHECK (`employment_basis` IS NULL OR `employment_basis` IN ('full_time', 'part_time')),
  ADD CONSTRAINT `ck_profile_job_nature` CHECK (`job_nature` IS NULL OR `job_nature` IN
    ('field', 'factory', 'office', 'technical', 'supervisory', 'administrative', 'operational')),
  ADD CONSTRAINT `ck_profile_location` CHECK (`working_location` IS NULL OR `working_location` IN
    ('field', 'factory', 'office', 'warehouse', 'nursery', 'head_office')),
  ADD CONSTRAINT `ck_profile_status` CHECK (`status` IN ('active', 'suspended', 'on_leave', 'separated')),
  ADD CONSTRAINT `ck_profile_separation` CHECK (
    (`status` = 'separated') = (`separation_date` IS NOT NULL AND `separation_type` IS NOT NULL)),
  ADD CONSTRAINT `ck_profile_separation_type` CHECK (`separation_type` IS NULL OR `separation_type` IN
    ('resignation', 'retirement', 'termination', 'death', 'end_of_contract')),
  -- P3 §8.2: a separation is never before the joining.
  ADD CONSTRAINT `ck_profile_dates` CHECK (
    (`separation_date` IS NULL OR `separation_date` >= `joining_date`)
    AND (`confirmation_date` IS NULL OR `confirmation_date` >= `joining_date`)
    AND (`probation_end_date` IS NULL OR `probation_end_date` >= `joining_date`)),
  ADD CONSTRAINT `ck_profile_nominee_relation` CHECK (`nominee_relation` IS NULL OR `nominee_relation` IN
    ('father', 'mother', 'spouse', 'son', 'daughter', 'brother', 'sister', 'other'));
ALTER TABLE `job_grade` ADD CONSTRAINT `ck_job_grade_status` CHECK (`status` IN ('active', 'inactive'));

-- HAND-EDIT: per-table rights for the app account. A profile is edited and changes status; it is deleted
-- only when created in error (nothing refers to it yet). Job grades are a reference list.
GRANT UPDATE, DELETE ON `employment_profile` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `job_grade` TO 'rupai_app'@'%';

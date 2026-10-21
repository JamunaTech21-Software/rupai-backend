-- CreateTable
CREATE TABLE `training_program` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `program_code` VARCHAR(30) NOT NULL,
    `estate_id` BIGINT UNSIGNED NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `training_type` VARCHAR(30) NOT NULL,
    `trainer_name` VARCHAR(150) NULL,
    `trainer_type` VARCHAR(30) NOT NULL DEFAULT 'internal',
    `venue` VARCHAR(200) NULL,
    `start_date` DATE NOT NULL,
    `end_date` DATE NOT NULL,
    `duration_hours` DECIMAL(9, 4) NULL,
    `capacity` SMALLINT UNSIGNED NULL,
    `cost` DECIMAL(18, 4) NULL,
    `budget_head_id` BIGINT UNSIGNED NULL,
    `description` VARCHAR(1000) NULL,
    `state` VARCHAR(30) NOT NULL DEFAULT 'draft',
    `state_changed_at` DATETIME(0) NULL,
    `cancellation_reason` VARCHAR(500) NULL,
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

    INDEX `ix_training_program_estate`(`estate_id`),
    INDEX `ix_training_program_start`(`start_date`),
    INDEX `ix_training_program_type`(`training_type`),
    INDEX `ix_training_program_state`(`state`),
    INDEX `ix_training_program_created_by`(`created_by`),
    INDEX `ix_training_program_updated_by`(`updated_by`),
    INDEX `ix_training_program_submitted_by`(`submitted_by`),
    INDEX `ix_training_program_approved_by`(`approved_by`),
    INDEX `ix_training_program_rejected_by`(`rejected_by`),
    UNIQUE INDEX `ux_training_program_code`(`program_code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `training_participant` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `training_program_id` BIGINT UNSIGNED NOT NULL,
    `employment_profile_id` BIGINT UNSIGNED NOT NULL,
    `attendance_status` VARCHAR(30) NOT NULL DEFAULT 'registered',
    `score` DECIMAL(9, 4) NULL,
    `result` VARCHAR(30) NOT NULL DEFAULT 'not_assessed',
    `certificate_number` VARCHAR(50) NULL,
    `certificate_issued_on` DATE NULL,
    `feedback_rating` TINYINT UNSIGNED NULL,
    `remarks` VARCHAR(500) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_training_participant_profile`(`employment_profile_id`),
    INDEX `ix_training_participant_created_by`(`created_by`),
    INDEX `ix_training_participant_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_training_participant`(`training_program_id`, `employment_profile_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `training_program` ADD CONSTRAINT `fk_training_program_estate` FOREIGN KEY (`estate_id`) REFERENCES `estate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `training_program` ADD CONSTRAINT `fk_training_program_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `training_program` ADD CONSTRAINT `fk_training_program_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `training_program` ADD CONSTRAINT `fk_training_program_submitted_by` FOREIGN KEY (`submitted_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `training_program` ADD CONSTRAINT `fk_training_program_approved_by` FOREIGN KEY (`approved_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `training_program` ADD CONSTRAINT `fk_training_program_rejected_by` FOREIGN KEY (`rejected_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `training_participant` ADD CONSTRAINT `fk_training_participant_program` FOREIGN KEY (`training_program_id`) REFERENCES `training_program`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `training_participant` ADD CONSTRAINT `fk_training_participant_profile` FOREIGN KEY (`employment_profile_id`) REFERENCES `employment_profile`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `training_participant` ADD CONSTRAINT `fk_training_participant_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `training_participant` ADD CONSTRAINT `fk_training_participant_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- HAND-EDIT: CHECK constraints (prisma/README.md).
ALTER TABLE `training_program`
  ADD CONSTRAINT `ck_training_program_type` CHECK (`training_type` IN
    ('induction', 'safety', 'technical', 'skill', 'compliance', 'health', 'leadership', 'other')),
  ADD CONSTRAINT `ck_training_program_trainer` CHECK (`trainer_type` IN ('internal', 'external')),
  ADD CONSTRAINT `ck_training_program_dates` CHECK (`end_date` >= `start_date`),
  ADD CONSTRAINT `ck_training_program_amounts` CHECK (
    (`duration_hours` IS NULL OR `duration_hours` > 0) AND (`capacity` IS NULL OR `capacity` > 0)
    AND (`cost` IS NULL OR `cost` >= 0)),
  ADD CONSTRAINT `ck_training_program_state` CHECK (`state` IN
    ('draft', 'submitted', 'approved', 'rejected', 'completed', 'cancelled')),
  ADD CONSTRAINT `ck_training_program_approval` CHECK (
    (`state` = 'draft' OR `submitted_at` IS NOT NULL)
    AND ((`state` IN ('approved', 'completed')) = (`approved_at` IS NOT NULL) OR `state` = 'cancelled')
    AND ((`state` = 'rejected') = (`rejected_at` IS NOT NULL AND `rejection_reason` IS NOT NULL))
    AND ((`state` = 'cancelled') = (`cancellation_reason` IS NOT NULL)));
ALTER TABLE `training_participant`
  ADD CONSTRAINT `ck_training_participant_attendance` CHECK (`attendance_status` IN ('registered', 'attended', 'absent', 'withdrawn')),
  ADD CONSTRAINT `ck_training_participant_result` CHECK (`result` IN ('pass', 'fail', 'not_assessed')),
  ADD CONSTRAINT `ck_training_participant_score` CHECK (`score` IS NULL OR `score` BETWEEN 0 AND 100),
  ADD CONSTRAINT `ck_training_participant_rating` CHECK (`feedback_rating` IS NULL OR `feedback_rating` BETWEEN 1 AND 5),
  -- Only someone who attended is assessed or certified.
  ADD CONSTRAINT `ck_training_participant_assessed` CHECK (
    `attendance_status` = 'attended' OR (`result` = 'not_assessed' AND `score` IS NULL AND `certificate_number` IS NULL));

-- HAND-EDIT: per-table rights for the app account. A programme changes state, only a draft is deleted;
-- participants are recorded and removed while the programme is open.
GRANT UPDATE, DELETE ON `training_program` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `training_participant` TO 'rupai_app'@'%';

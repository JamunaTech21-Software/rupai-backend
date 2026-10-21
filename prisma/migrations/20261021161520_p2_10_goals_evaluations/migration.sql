-- CreateTable
CREATE TABLE `goal` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `goal_code` VARCHAR(30) NOT NULL,
    `owner_type` VARCHAR(30) NOT NULL,
    `owner_id` BIGINT UNSIGNED NOT NULL,
    `estate_id` BIGINT UNSIGNED NOT NULL,
    `parent_goal_id` BIGINT UNSIGNED NULL,
    `title` VARCHAR(200) NOT NULL,
    `description` VARCHAR(500) NULL,
    `kpi_name` VARCHAR(150) NULL,
    `measure_unit` VARCHAR(50) NULL,
    `target_value` DECIMAL(18, 4) NULL,
    `current_value` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `weight` DECIMAL(9, 4) NULL,
    `start_date` DATE NOT NULL,
    `due_date` DATE NOT NULL,
    `review_date` DATE NULL,
    `progress_percentage` DECIMAL(9, 4) NOT NULL DEFAULT 0,
    `state` VARCHAR(30) NOT NULL DEFAULT 'draft',
    `state_changed_at` DATETIME(0) NULL,
    `completed_at` DATETIME(0) NULL,
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

    INDEX `ix_goal_owner`(`owner_type`, `owner_id`),
    INDEX `ix_goal_estate`(`estate_id`),
    INDEX `ix_goal_parent`(`parent_goal_id`),
    INDEX `ix_goal_start`(`start_date`),
    INDEX `ix_goal_due`(`due_date`),
    INDEX `ix_goal_review`(`review_date`),
    INDEX `ix_goal_state`(`state`),
    INDEX `ix_goal_created_by`(`created_by`),
    INDEX `ix_goal_updated_by`(`updated_by`),
    INDEX `ix_goal_submitted_by`(`submitted_by`),
    INDEX `ix_goal_approved_by`(`approved_by`),
    INDEX `ix_goal_rejected_by`(`rejected_by`),
    UNIQUE INDEX `ux_goal_code`(`goal_code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `goal_progress` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `goal_id` BIGINT UNSIGNED NOT NULL,
    `progress_date` DATE NOT NULL,
    `value` DECIMAL(18, 4) NULL,
    `progress_percentage` DECIMAL(9, 4) NOT NULL,
    `note` VARCHAR(500) NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,

    INDEX `ix_goal_progress_goal`(`goal_id`, `progress_date`),
    INDEX `ix_goal_progress_created_by`(`created_by`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `evaluation_criteria` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `description` VARCHAR(500) NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `is_system` BOOLEAN NOT NULL DEFAULT false,
    `criteria_group` VARCHAR(30) NOT NULL,
    `max_score` DECIMAL(9, 4) NOT NULL DEFAULT 5,
    `applies_to` VARCHAR(30) NOT NULL DEFAULT 'all',
    `is_goal_linked` BOOLEAN NOT NULL DEFAULT false,
    `status` VARCHAR(30) NOT NULL DEFAULT 'active',
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_evaluation_criteria_status`(`status`),
    INDEX `ix_evaluation_criteria_created_by`(`created_by`),
    INDEX `ix_evaluation_criteria_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_evaluation_criteria_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `evaluation` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `evaluation_number` VARCHAR(30) NOT NULL,
    `employment_profile_id` BIGINT UNSIGNED NOT NULL,
    `estate_id` BIGINT UNSIGNED NOT NULL,
    `reviewer_profile_id` BIGINT UNSIGNED NULL,
    `period_start` DATE NOT NULL,
    `period_end` DATE NOT NULL,
    `evaluation_type` VARCHAR(30) NOT NULL,
    `overall_score` DECIMAL(9, 4) NULL,
    `overall_rating` VARCHAR(30) NULL,
    `strengths` VARCHAR(1000) NULL,
    `development_needs` VARCHAR(1000) NULL,
    `reviewer_comment` VARCHAR(1000) NULL,
    `employee_comment` VARCHAR(1000) NULL,
    `acknowledged_at` DATETIME(0) NULL,
    `state` VARCHAR(30) NOT NULL DEFAULT 'draft',
    `state_changed_at` DATETIME(0) NULL,
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

    INDEX `ix_evaluation_profile`(`employment_profile_id`),
    INDEX `ix_evaluation_reviewer`(`reviewer_profile_id`),
    INDEX `ix_evaluation_estate`(`estate_id`),
    INDEX `ix_evaluation_period_end`(`period_end`),
    INDEX `ix_evaluation_state`(`state`),
    INDEX `ix_evaluation_created_by`(`created_by`),
    INDEX `ix_evaluation_updated_by`(`updated_by`),
    INDEX `ix_evaluation_submitted_by`(`submitted_by`),
    INDEX `ix_evaluation_approved_by`(`approved_by`),
    INDEX `ix_evaluation_rejected_by`(`rejected_by`),
    UNIQUE INDEX `ux_evaluation_number`(`evaluation_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `evaluation_line` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `evaluation_id` BIGINT UNSIGNED NOT NULL,
    `criteria_id` BIGINT UNSIGNED NOT NULL,
    `goal_id` BIGINT UNSIGNED NULL,
    `weight` DECIMAL(9, 4) NOT NULL DEFAULT 1,
    `score` DECIMAL(9, 4) NULL,
    `max_score` DECIMAL(9, 4) NOT NULL,
    `weighted_score` DECIMAL(9, 4) NULL,
    `comment` VARCHAR(500) NULL,
    `sequence` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_evaluation_line_criteria`(`criteria_id`),
    INDEX `ix_evaluation_line_goal`(`goal_id`),
    INDEX `ix_evaluation_line_created_by`(`created_by`),
    INDEX `ix_evaluation_line_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_evaluation_line`(`evaluation_id`, `criteria_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `goal` ADD CONSTRAINT `fk_goal_estate` FOREIGN KEY (`estate_id`) REFERENCES `estate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `goal` ADD CONSTRAINT `fk_goal_parent` FOREIGN KEY (`parent_goal_id`) REFERENCES `goal`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `goal` ADD CONSTRAINT `fk_goal_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `goal` ADD CONSTRAINT `fk_goal_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `goal` ADD CONSTRAINT `fk_goal_submitted_by` FOREIGN KEY (`submitted_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `goal` ADD CONSTRAINT `fk_goal_approved_by` FOREIGN KEY (`approved_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `goal` ADD CONSTRAINT `fk_goal_rejected_by` FOREIGN KEY (`rejected_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `goal_progress` ADD CONSTRAINT `fk_goal_progress_goal` FOREIGN KEY (`goal_id`) REFERENCES `goal`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `goal_progress` ADD CONSTRAINT `fk_goal_progress_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `evaluation_criteria` ADD CONSTRAINT `fk_evaluation_criteria_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `evaluation_criteria` ADD CONSTRAINT `fk_evaluation_criteria_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `evaluation` ADD CONSTRAINT `fk_evaluation_profile` FOREIGN KEY (`employment_profile_id`) REFERENCES `employment_profile`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `evaluation` ADD CONSTRAINT `fk_evaluation_reviewer` FOREIGN KEY (`reviewer_profile_id`) REFERENCES `employment_profile`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `evaluation` ADD CONSTRAINT `fk_evaluation_estate` FOREIGN KEY (`estate_id`) REFERENCES `estate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `evaluation` ADD CONSTRAINT `fk_evaluation_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `evaluation` ADD CONSTRAINT `fk_evaluation_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `evaluation` ADD CONSTRAINT `fk_evaluation_submitted_by` FOREIGN KEY (`submitted_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `evaluation` ADD CONSTRAINT `fk_evaluation_approved_by` FOREIGN KEY (`approved_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `evaluation` ADD CONSTRAINT `fk_evaluation_rejected_by` FOREIGN KEY (`rejected_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `evaluation_line` ADD CONSTRAINT `fk_evaluation_line_evaluation` FOREIGN KEY (`evaluation_id`) REFERENCES `evaluation`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `evaluation_line` ADD CONSTRAINT `fk_evaluation_line_criteria` FOREIGN KEY (`criteria_id`) REFERENCES `evaluation_criteria`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `evaluation_line` ADD CONSTRAINT `fk_evaluation_line_goal` FOREIGN KEY (`goal_id`) REFERENCES `goal`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `evaluation_line` ADD CONSTRAINT `fk_evaluation_line_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `evaluation_line` ADD CONSTRAINT `fk_evaluation_line_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- HAND-EDIT: CHECK constraints (prisma/README.md).
ALTER TABLE `goal`
  ADD CONSTRAINT `ck_goal_owner` CHECK (`owner_type` IN ('employment_profile', 'department', 'estate')),
  ADD CONSTRAINT `ck_goal_dates` CHECK (`due_date` >= `start_date` AND (`review_date` IS NULL OR `review_date` >= `start_date`)),
  ADD CONSTRAINT `ck_goal_progress` CHECK (`progress_percentage` BETWEEN 0 AND 100 AND (`weight` IS NULL OR `weight` > 0)),
  ADD CONSTRAINT `ck_goal_state` CHECK (`state` IN
    ('draft', 'submitted', 'active', 'in_progress', 'delayed', 'overdue', 'completed', 'rejected', 'cancelled')),
  ADD CONSTRAINT `ck_goal_approval` CHECK (
    (`state` = 'draft' OR `submitted_at` IS NOT NULL OR `state` = 'cancelled')
    AND ((`state` = 'rejected') = (`rejected_at` IS NOT NULL AND `rejection_reason` IS NOT NULL))
    AND ((`state` = 'cancelled') = (`cancellation_reason` IS NOT NULL))
    AND ((`state` = 'completed') = (`completed_at` IS NOT NULL)));
ALTER TABLE `goal_progress`
  ADD CONSTRAINT `ck_goal_progress_pct` CHECK (`progress_percentage` BETWEEN 0 AND 100);
ALTER TABLE `evaluation_criteria`
  ADD CONSTRAINT `ck_evaluation_criteria_group` CHECK (`criteria_group` IN ('competency', 'performance', 'behaviour', 'goals', 'other')),
  ADD CONSTRAINT `ck_evaluation_criteria_max` CHECK (`max_score` > 0),
  ADD CONSTRAINT `ck_evaluation_criteria_applies` CHECK (`applies_to` IN ('all', 'worker', 'employee')),
  ADD CONSTRAINT `ck_evaluation_criteria_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `evaluation`
  ADD CONSTRAINT `ck_evaluation_type` CHECK (`evaluation_type` IN ('annual', 'probation', 'project')),
  ADD CONSTRAINT `ck_evaluation_period` CHECK (`period_end` >= `period_start`),
  ADD CONSTRAINT `ck_evaluation_score` CHECK (`overall_score` IS NULL OR `overall_score` BETWEEN 0 AND 100),
  ADD CONSTRAINT `ck_evaluation_rating` CHECK (`overall_rating` IS NULL OR `overall_rating` IN
    ('outstanding', 'exceeds', 'meets', 'needs_improvement', 'unsatisfactory')),
  ADD CONSTRAINT `ck_evaluation_state` CHECK (`state` IN ('draft', 'submitted', 'approved', 'rejected', 'acknowledged')),
  ADD CONSTRAINT `ck_evaluation_approval` CHECK (
    (`state` = 'draft' OR `submitted_at` IS NOT NULL)
    AND ((`state` IN ('approved', 'acknowledged')) = (`approved_at` IS NOT NULL))
    AND ((`state` = 'rejected') = (`rejected_at` IS NOT NULL AND `rejection_reason` IS NOT NULL))
    AND ((`state` = 'acknowledged') = (`acknowledged_at` IS NOT NULL)));
ALTER TABLE `evaluation_line`
  ADD CONSTRAINT `ck_evaluation_line_scores` CHECK (
    `weight` > 0 AND `max_score` > 0 AND (`score` IS NULL OR `score` BETWEEN 0 AND `max_score`));

-- HAND-EDIT: per-table rights for the app account. Goals change state and only a draft is deleted;
-- progress is recorded, never changed. An evaluation is NEVER deleted (P3 §24.3) and its lines change only
-- while it is a draft. Criteria are a reference list.
GRANT UPDATE, DELETE ON `goal` TO 'rupai_app'@'%';
GRANT UPDATE ON `evaluation` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `evaluation_line` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `evaluation_criteria` TO 'rupai_app'@'%';

-- CreateTable
CREATE TABLE `employment_assignment` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `employment_profile_id` BIGINT UNSIGNED NOT NULL,
    `estate_id` BIGINT UNSIGNED NOT NULL,
    `department_id` BIGINT UNSIGNED NULL,
    `designation_id` BIGINT UNSIGNED NULL,
    `division_id` BIGINT UNSIGNED NULL,
    `section_id` BIGINT UNSIGNED NULL,
    `activity_type_id` BIGINT UNSIGNED NULL,
    `cost_centre_id` BIGINT UNSIGNED NULL,
    `default_shift_id` BIGINT UNSIGNED NULL,
    `wage_basis` VARCHAR(30) NOT NULL,
    `base_rate` DECIMAL(18, 4) NULL,
    `effective_from` DATE NOT NULL,
    `effective_to` DATE NULL,
    `change_reason` VARCHAR(30) NOT NULL,
    `remarks` VARCHAR(500) NULL,
    `is_wage_change` BOOLEAN NOT NULL DEFAULT false,
    `is_retrospective` BOOLEAN NOT NULL DEFAULT false,
    `state` VARCHAR(30) NOT NULL DEFAULT 'draft',
    `state_changed_at` DATETIME(0) NULL,
    `submitted_at` DATETIME(0) NULL,
    `submitted_by` BIGINT UNSIGNED NULL,
    `approved_at` DATETIME(0) NULL,
    `approved_by` BIGINT UNSIGNED NULL,
    `rejected_at` DATETIME(0) NULL,
    `rejected_by` BIGINT UNSIGNED NULL,
    `rejection_reason` VARCHAR(500) NULL,
    -- HAND-EDIT: one assignment per profile and start date, rejected ones aside (P3 §8.3 ux_assignment_effective).
    `effective_key` VARCHAR(40) GENERATED ALWAYS AS (CASE WHEN `state` <> 'rejected' THEN CONCAT(`employment_profile_id`, ':', `effective_from`) END) STORED,
    -- HAND-EDIT: one pending change (draft or submitted) per profile at a time.
    `open_key` BIGINT UNSIGNED GENERATED ALWAYS AS (CASE WHEN `state` IN ('draft', 'submitted') THEN `employment_profile_id` END) STORED,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_assignment_profile_from`(`employment_profile_id`, `effective_from`),
    INDEX `ix_assignment_estate`(`estate_id`),
    INDEX `ix_assignment_department`(`department_id`),
    INDEX `ix_assignment_designation`(`designation_id`),
    INDEX `ix_assignment_division`(`division_id`),
    INDEX `ix_assignment_section`(`section_id`),
    INDEX `ix_assignment_activity_type`(`activity_type_id`),
    INDEX `ix_assignment_shift`(`default_shift_id`),
    INDEX `ix_assignment_from`(`effective_from`),
    INDEX `ix_assignment_to`(`effective_to`),
    INDEX `ix_assignment_state`(`state`),
    INDEX `ix_assignment_created_by`(`created_by`),
    INDEX `ix_assignment_updated_by`(`updated_by`),
    INDEX `ix_assignment_submitted_by`(`submitted_by`),
    INDEX `ix_assignment_approved_by`(`approved_by`),
    INDEX `ix_assignment_rejected_by`(`rejected_by`),
    UNIQUE INDEX `ux_assignment_effective`(`effective_key`),
    UNIQUE INDEX `ux_assignment_open`(`open_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `assignment_pay_line` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `assignment_id` BIGINT UNSIGNED NOT NULL,
    `component` VARCHAR(30) NOT NULL,
    `amount` DECIMAL(18, 4) NOT NULL,

    UNIQUE INDEX `ux_pay_line_component`(`assignment_id`, `component`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `employment_assignment` ADD CONSTRAINT `fk_assignment_profile` FOREIGN KEY (`employment_profile_id`) REFERENCES `employment_profile`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `employment_assignment` ADD CONSTRAINT `fk_assignment_estate` FOREIGN KEY (`estate_id`) REFERENCES `estate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `employment_assignment` ADD CONSTRAINT `fk_assignment_department` FOREIGN KEY (`department_id`) REFERENCES `department`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `employment_assignment` ADD CONSTRAINT `fk_assignment_designation` FOREIGN KEY (`designation_id`) REFERENCES `designation`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `employment_assignment` ADD CONSTRAINT `fk_assignment_division` FOREIGN KEY (`division_id`) REFERENCES `division`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `employment_assignment` ADD CONSTRAINT `fk_assignment_section` FOREIGN KEY (`section_id`) REFERENCES `section`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `employment_assignment` ADD CONSTRAINT `fk_assignment_activity_type` FOREIGN KEY (`activity_type_id`) REFERENCES `activity_type`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `employment_assignment` ADD CONSTRAINT `fk_assignment_shift` FOREIGN KEY (`default_shift_id`) REFERENCES `shift`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `employment_assignment` ADD CONSTRAINT `fk_assignment_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `employment_assignment` ADD CONSTRAINT `fk_assignment_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `employment_assignment` ADD CONSTRAINT `fk_assignment_submitted_by` FOREIGN KEY (`submitted_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `employment_assignment` ADD CONSTRAINT `fk_assignment_approved_by` FOREIGN KEY (`approved_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `employment_assignment` ADD CONSTRAINT `fk_assignment_rejected_by` FOREIGN KEY (`rejected_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `assignment_pay_line` ADD CONSTRAINT `fk_pay_line_assignment` FOREIGN KEY (`assignment_id`) REFERENCES `employment_assignment`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- HAND-EDIT: CHECK constraints (prisma/README.md).
ALTER TABLE `employment_assignment`
  ADD CONSTRAINT `ck_assignment_wage_basis` CHECK (`wage_basis` IN
    ('daily', 'monthly', 'hourly', 'piece_rate', 'quantity', 'fixed')),
  ADD CONSTRAINT `ck_assignment_reason` CHECK (`change_reason` IN
    ('joining', 'transfer', 'promotion', 'demotion', 'wage_revision', 'other')),
  ADD CONSTRAINT `ck_assignment_state` CHECK (`state` IN ('draft', 'submitted', 'approved', 'rejected')),
  ADD CONSTRAINT `ck_assignment_rate` CHECK (`base_rate` IS NULL OR `base_rate` >= 0),
  ADD CONSTRAINT `ck_assignment_dates` CHECK (`effective_to` IS NULL OR `effective_to` >= `effective_from`),
  -- Only an approved assignment is ever closed: a draft has no place in the timeline yet.
  ADD CONSTRAINT `ck_assignment_closed` CHECK (`effective_to` IS NULL OR `state` = 'approved'),
  ADD CONSTRAINT `ck_assignment_approval` CHECK (
    (`state` IN ('draft') OR `submitted_at` IS NOT NULL)
    AND ((`state` = 'approved') = (`approved_at` IS NOT NULL))
    AND ((`state` = 'rejected') = (`rejected_at` IS NOT NULL AND `rejection_reason` IS NOT NULL)));
ALTER TABLE `assignment_pay_line`
  ADD CONSTRAINT `ck_pay_line_component` CHECK (`component` IN
    ('basic', 'house_rent', 'medical', 'conveyance', 'other')),
  ADD CONSTRAINT `ck_pay_line_amount` CHECK (`amount` >= 0);

-- HAND-EDIT: per-table rights for the app account. An assignment changes state and is closed by the next
-- one; only a draft is deleted. Pay lines are replaced while their assignment is a draft.
GRANT UPDATE, DELETE ON `employment_assignment` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `assignment_pay_line` TO 'rupai_app'@'%';

-- CreateTable
CREATE TABLE `worker_team` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `estate_id` BIGINT UNSIGNED NOT NULL,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `team_type` VARCHAR(30) NOT NULL,
    `supervisor_profile_id` BIGINT UNSIGNED NULL,
    `division_id` BIGINT UNSIGNED NULL,
    `section_id` BIGINT UNSIGNED NULL,
    `description` VARCHAR(500) NULL,
    `status` VARCHAR(30) NOT NULL DEFAULT 'active',
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_team_supervisor`(`supervisor_profile_id`),
    INDEX `ix_team_division`(`division_id`),
    INDEX `ix_team_section`(`section_id`),
    INDEX `ix_team_type`(`team_type`),
    INDEX `ix_team_status`(`status`),
    INDEX `ix_team_created_by`(`created_by`),
    INDEX `ix_team_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_team_code`(`estate_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `team_member` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `worker_team_id` BIGINT UNSIGNED NOT NULL,
    `employment_profile_id` BIGINT UNSIGNED NOT NULL,
    `effective_from` DATE NOT NULL,
    `effective_to` DATE NULL,
    `role_in_team` VARCHAR(30) NOT NULL DEFAULT 'member',
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_team_member_profile`(`employment_profile_id`, `effective_from`),
    INDEX `ix_team_member_team`(`worker_team_id`, `effective_from`),
    INDEX `ix_team_member_to`(`effective_to`),
    INDEX `ix_team_member_created_by`(`created_by`),
    INDEX `ix_team_member_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_team_member`(`worker_team_id`, `employment_profile_id`, `effective_from`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `worker_team` ADD CONSTRAINT `fk_team_estate` FOREIGN KEY (`estate_id`) REFERENCES `estate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `worker_team` ADD CONSTRAINT `fk_team_supervisor` FOREIGN KEY (`supervisor_profile_id`) REFERENCES `employment_profile`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `worker_team` ADD CONSTRAINT `fk_team_division` FOREIGN KEY (`division_id`) REFERENCES `division`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `worker_team` ADD CONSTRAINT `fk_team_section` FOREIGN KEY (`section_id`) REFERENCES `section`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `worker_team` ADD CONSTRAINT `fk_team_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `worker_team` ADD CONSTRAINT `fk_team_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `team_member` ADD CONSTRAINT `fk_team_member_team` FOREIGN KEY (`worker_team_id`) REFERENCES `worker_team`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `team_member` ADD CONSTRAINT `fk_team_member_profile` FOREIGN KEY (`employment_profile_id`) REFERENCES `employment_profile`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `team_member` ADD CONSTRAINT `fk_team_member_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `team_member` ADD CONSTRAINT `fk_team_member_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- HAND-EDIT: CHECK constraints (prisma/README.md).
ALTER TABLE `worker_team`
  ADD CONSTRAINT `ck_team_type` CHECK (`team_type` IN ('plucking', 'field', 'factory', 'general')),
  ADD CONSTRAINT `ck_team_status` CHECK (`status` IN ('active', 'inactive'));
ALTER TABLE `team_member`
  ADD CONSTRAINT `ck_team_member_role` CHECK (`role_in_team` IN ('member', 'leader', 'assistant')),
  ADD CONSTRAINT `ck_team_member_dates` CHECK (`effective_to` IS NULL OR `effective_to` >= `effective_from`);

-- HAND-EDIT: per-table rights for the app account. A team is edited and deactivated, deleted only before
-- it ever had a member. A membership is ended (effective_to) or deleted when entered in error.
GRANT UPDATE, DELETE ON `worker_team` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `team_member` TO 'rupai_app'@'%';

-- CreateTable
CREATE TABLE `workflow` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `rule_code` VARCHAR(30) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `document_type` VARCHAR(50) NOT NULL,
    `scope_estate_id` BIGINT UNSIGNED NULL,
    `scope_department_id` BIGINT UNSIGNED NULL,
    -- HAND-EDIT: generated (core/rules/rule-sql.ts): estate 2 + department 1. The most specific workflow wins.
    `specificity` SMALLINT UNSIGNED GENERATED ALWAYS AS ((`scope_estate_id` IS NOT NULL) * 2 + (`scope_department_id` IS NOT NULL) * 1) STORED,
    `method` VARCHAR(30) NOT NULL,
    `parameters` JSON NOT NULL,
    `currency_id` BIGINT UNSIGNED NULL,
    `rounding_mode` VARCHAR(30) NULL,
    `rounding_precision` SMALLINT NULL,
    `effective_from` DATE NOT NULL,
    `effective_to` DATE NULL,
    `is_retrospective` BOOLEAN NOT NULL DEFAULT false,
    `supersedes_id` BIGINT UNSIGNED NULL,
    `notes` VARCHAR(500) NULL,
    `condition_json` JSON NULL,
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
    -- HAND-EDIT: generated (core/rules/rule-sql.ts): document type + scope + effective_from while ACTIVE,
    -- else NULL. Its unique index refuses two active workflows for the same scope and start date.
    `active_key` VARCHAR(255) GENERATED ALWAYS AS (CASE WHEN `state` = 'active' THEN CONCAT_WS('|', `document_type`, IFNULL(`scope_estate_id`, '*'), IFNULL(`scope_department_id`, '*'), `effective_from`) END) STORED,

    INDEX `ix_workflow_resolution`(`document_type`, `specificity`, `effective_from`, `effective_to`, `state`),
    INDEX `ix_workflow_code`(`rule_code`, `effective_from`),
    INDEX `ix_workflow_state`(`state`),
    INDEX `ix_workflow_retrospective`(`is_retrospective`),
    INDEX `ix_workflow_supersedes`(`supersedes_id`),
    INDEX `ix_workflow_estate`(`scope_estate_id`),
    INDEX `ix_workflow_department`(`scope_department_id`),
    INDEX `ix_workflow_created_by`(`created_by`),
    INDEX `ix_workflow_updated_by`(`updated_by`),
    INDEX `ix_workflow_submitted_by`(`submitted_by`),
    INDEX `ix_workflow_approved_by`(`approved_by`),
    INDEX `ix_workflow_rejected_by`(`rejected_by`),
    UNIQUE INDEX `ux_workflow_scope_from`(`active_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `workflow_step` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workflow_id` BIGINT UNSIGNED NOT NULL,
    `step_number` INTEGER NOT NULL,
    `name` VARCHAR(100) NULL,
    `approver_rule` VARCHAR(30) NOT NULL,
    `role_id` BIGINT UNSIGNED NULL,
    `user_id` BIGINT UNSIGNED NULL,
    `reporting_level` TINYINT UNSIGNED NULL,
    `condition_field` VARCHAR(50) NULL,
    `condition_operator` VARCHAR(20) NULL,
    `condition_value` JSON NULL,
    `allow_self_approval` BOOLEAN NOT NULL DEFAULT false,
    `sequence` INTEGER NOT NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_workflow_step_role`(`role_id`),
    INDEX `ix_workflow_step_user`(`user_id`),
    INDEX `ix_workflow_step_created_by`(`created_by`),
    INDEX `ix_workflow_step_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_workflow_step_number`(`workflow_id`, `step_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `workflow` ADD CONSTRAINT `fk_workflow_supersedes` FOREIGN KEY (`supersedes_id`) REFERENCES `workflow`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `workflow` ADD CONSTRAINT `fk_workflow_estate` FOREIGN KEY (`scope_estate_id`) REFERENCES `estate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `workflow` ADD CONSTRAINT `fk_workflow_department` FOREIGN KEY (`scope_department_id`) REFERENCES `department`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `workflow` ADD CONSTRAINT `fk_workflow_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `workflow` ADD CONSTRAINT `fk_workflow_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `workflow` ADD CONSTRAINT `fk_workflow_submitted_by` FOREIGN KEY (`submitted_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `workflow` ADD CONSTRAINT `fk_workflow_approved_by` FOREIGN KEY (`approved_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `workflow` ADD CONSTRAINT `fk_workflow_rejected_by` FOREIGN KEY (`rejected_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `workflow_step` ADD CONSTRAINT `fk_workflow_step_workflow` FOREIGN KEY (`workflow_id`) REFERENCES `workflow`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `workflow_step` ADD CONSTRAINT `fk_workflow_step_role` FOREIGN KEY (`role_id`) REFERENCES `role`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `workflow_step` ADD CONSTRAINT `fk_workflow_step_user` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `workflow_step` ADD CONSTRAINT `fk_workflow_step_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `workflow_step` ADD CONSTRAINT `fk_workflow_step_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- HAND-EDIT: CHECK constraints (prisma/README.md). The workflow ones are the rule block's (rule-sql.ts).
ALTER TABLE `workflow`
  ADD CONSTRAINT `ck_workflow_range` CHECK (`effective_to` IS NULL OR `effective_to` >= `effective_from`),
  ADD CONSTRAINT `ck_workflow_state` CHECK (`state` IN ('draft', 'submitted', 'active', 'rejected', 'superseded')),
  ADD CONSTRAINT `ck_workflow_method` CHECK (`method` IN ('sequential')),
  ADD CONSTRAINT `ck_workflow_rounding` CHECK (`rounding_mode` IS NULL OR `rounding_mode` IN ('half_up', 'half_down', 'up', 'down', 'none')),
  ADD CONSTRAINT `ck_workflow_rejection` CHECK ((`rejected_at` IS NULL) = (`rejection_reason` IS NULL)),
  ADD CONSTRAINT `ck_workflow_approved` CHECK (`state` NOT IN ('active', 'superseded') OR `approved_at` IS NOT NULL),
  ADD CONSTRAINT `ck_workflow_document_type` CHECK (`document_type` REGEXP '^[a-z][a-z0-9_]*$');

ALTER TABLE `workflow_step`
  ADD CONSTRAINT `ck_workflow_step_number` CHECK (`step_number` BETWEEN 1 AND 20 AND `sequence` = `step_number`),
  ADD CONSTRAINT `ck_workflow_step_rule` CHECK (`approver_rule` IN ('by_role', 'by_reporting_line', 'by_named_user', 'by_cost_centre_manager')),
  -- Each rule names exactly what it needs: a role, a user, a reporting level, or nothing.
  ADD CONSTRAINT `ck_workflow_step_approver` CHECK (
    (`role_id` IS NOT NULL) = (`approver_rule` = 'by_role')
    AND (`user_id` IS NOT NULL) = (`approver_rule` = 'by_named_user')
    AND (`reporting_level` IS NOT NULL) = (`approver_rule` = 'by_reporting_line')
    AND (`reporting_level` IS NULL OR `reporting_level` BETWEEN 1 AND 5)),
  -- A condition is all three columns or none (flags carry no value).
  ADD CONSTRAINT `ck_workflow_step_condition` CHECK (
    (`condition_field` IS NULL) = (`condition_operator` IS NULL)
    AND (`condition_field` IS NOT NULL OR `condition_value` IS NULL)),
  ADD CONSTRAINT `ck_workflow_step_operator` CHECK (`condition_operator` IS NULL OR `condition_operator` IN ('lt', 'lte', 'gt', 'gte', 'between', 'eq', 'in', 'not_in', 'is_true', 'is_false'));

-- HAND-EDIT: per-table rights for the app account. A workflow version is superseded, never deleted
-- (P3 §17.1): UPDATE only. Its steps are replaced as a set while it is a draft: UPDATE and DELETE.
GRANT UPDATE ON `workflow` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `workflow_step` TO 'rupai_app'@'%';

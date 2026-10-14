-- CreateTable
CREATE TABLE `approval_request` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `document_type` VARCHAR(50) NOT NULL,
    `document_id` BIGINT UNSIGNED NOT NULL,
    `workflow_id` BIGINT UNSIGNED NOT NULL,
    `path` JSON NOT NULL,
    `current_step_number` INTEGER NULL,
    `current_step_id` BIGINT UNSIGNED NULL,
    `step_started_at` DATETIME(0) NULL,
    `state` VARCHAR(30) NOT NULL DEFAULT 'pending',
    `is_unresolved` BOOLEAN NOT NULL DEFAULT false,
    `is_exceptional` BOOLEAN NOT NULL DEFAULT false,
    `guard_failure` JSON NULL,
    `submitted_at` DATETIME(0) NOT NULL,
    `submitted_by` BIGINT UNSIGNED NOT NULL,
    `document_created_by` BIGINT UNSIGNED NOT NULL,
    `completed_at` DATETIME(0) NULL,
    `final_outcome` VARCHAR(30) NULL,
    `estate_id` BIGINT UNSIGNED NULL,
    `factory_id` BIGINT UNSIGNED NULL,
    `warehouse_id` BIGINT UNSIGNED NULL,
    `department_id` BIGINT UNSIGNED NULL,
    `document_number` VARCHAR(50) NULL,
    `document_label` VARCHAR(200) NOT NULL,
    `summary_amount` DECIMAL(18, 2) NULL,
    `summary_quantity` DECIMAL(18, 3) NULL,
    -- HAND-EDIT: generated: the document while its request is pending, else NULL. Its unique index allows at
    -- most one pending request per document (P3 §28.3: "UNIQUE … where state is active").
    `active_key` VARCHAR(80) GENERATED ALWAYS AS (CASE WHEN `state` = 'pending' THEN CONCAT(`document_type`, ':', `document_id`) END) STORED,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NULL,

    INDEX `ix_approval_request_document`(`document_type`, `document_id`),
    INDEX `ix_approval_request_queue`(`state`, `current_step_id`),
    INDEX `ix_approval_request_unresolved`(`state`, `is_unresolved`),
    INDEX `ix_approval_request_workflow`(`workflow_id`),
    INDEX `ix_approval_request_step`(`current_step_id`),
    INDEX `ix_approval_request_submitted_by`(`submitted_by`),
    INDEX `ix_approval_request_document_created_by`(`document_created_by`),
    INDEX `ix_approval_request_estate`(`estate_id`),
    UNIQUE INDEX `ux_approval_request_active`(`active_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `approval_action` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `approval_request_id` BIGINT UNSIGNED NOT NULL,
    `workflow_step_id` BIGINT UNSIGNED NULL,
    `step_number` INTEGER NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `acting_for_user_id` BIGINT UNSIGNED NULL,
    `action` VARCHAR(30) NOT NULL,
    `comment` VARCHAR(1000) NULL,
    `acted_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `ip_address` VARCHAR(45) NULL,
    `is_self_approval` BOOLEAN NOT NULL DEFAULT false,
    `bulk_reference` VARCHAR(30) NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `ix_approval_action_request`(`approval_request_id`, `id`),
    INDEX `ix_approval_action_step`(`workflow_step_id`),
    INDEX `ix_approval_action_user`(`user_id`, `acted_at`),
    INDEX `ix_approval_action_acting_for`(`acting_for_user_id`),
    INDEX `ix_approval_action_bulk`(`bulk_reference`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `approval_delegation` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `from_user_id` BIGINT UNSIGNED NOT NULL,
    `to_user_id` BIGINT UNSIGNED NOT NULL,
    `document_type` VARCHAR(50) NULL,
    `valid_from` DATETIME(0) NOT NULL,
    `valid_to` DATETIME(0) NOT NULL,
    `reason` VARCHAR(500) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_approval_delegation_to`(`to_user_id`, `valid_from`, `valid_to`),
    INDEX `ix_approval_delegation_from`(`from_user_id`, `valid_from`, `valid_to`),
    INDEX `ix_approval_delegation_created_by`(`created_by`),
    INDEX `ix_approval_delegation_updated_by`(`updated_by`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `approval_request` ADD CONSTRAINT `fk_approval_request_workflow` FOREIGN KEY (`workflow_id`) REFERENCES `workflow`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `approval_request` ADD CONSTRAINT `fk_approval_request_step` FOREIGN KEY (`current_step_id`) REFERENCES `workflow_step`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `approval_request` ADD CONSTRAINT `fk_approval_request_submitted_by` FOREIGN KEY (`submitted_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `approval_request` ADD CONSTRAINT `fk_approval_request_document_created_by` FOREIGN KEY (`document_created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `approval_action` ADD CONSTRAINT `fk_approval_action_request` FOREIGN KEY (`approval_request_id`) REFERENCES `approval_request`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `approval_action` ADD CONSTRAINT `fk_approval_action_step` FOREIGN KEY (`workflow_step_id`) REFERENCES `workflow_step`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `approval_action` ADD CONSTRAINT `fk_approval_action_user` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `approval_action` ADD CONSTRAINT `fk_approval_action_acting_for` FOREIGN KEY (`acting_for_user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `approval_delegation` ADD CONSTRAINT `fk_approval_delegation_from` FOREIGN KEY (`from_user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `approval_delegation` ADD CONSTRAINT `fk_approval_delegation_to` FOREIGN KEY (`to_user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `approval_delegation` ADD CONSTRAINT `fk_approval_delegation_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `approval_delegation` ADD CONSTRAINT `fk_approval_delegation_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- HAND-EDIT: CHECK constraints (prisma/README.md).
ALTER TABLE `approval_request`
  ADD CONSTRAINT `ck_approval_request_type` CHECK (`document_type` REGEXP '^[a-z][a-z0-9_]*$'),
  ADD CONSTRAINT `ck_approval_request_state` CHECK (`state` IN ('pending', 'approved', 'rejected', 'returned')),
  -- A pending request has a current step; a finished one has none, and says how it ended.
  ADD CONSTRAINT `ck_approval_request_progress` CHECK (
    (`state` = 'pending') = (`current_step_id` IS NOT NULL AND `current_step_number` IS NOT NULL AND `completed_at` IS NULL)
    AND (`state` = 'pending' OR `final_outcome` = `state`)),
  ADD CONSTRAINT `ck_approval_request_amounts` CHECK (
    (`summary_amount` IS NULL OR `summary_amount` >= 0) AND (`summary_quantity` IS NULL OR `summary_quantity` >= 0));

ALTER TABLE `approval_action`
  ADD CONSTRAINT `ck_approval_action_action` CHECK (`action` IN ('approve', 'reject', 'return', 'comment')),
  -- Reject, return and comment always say why (P7 §10.1, §10.2).
  ADD CONSTRAINT `ck_approval_action_comment` CHECK (`action` = 'approve' OR (`comment` IS NOT NULL AND `comment` <> '')),
  ADD CONSTRAINT `ck_approval_action_acting_for` CHECK (`acting_for_user_id` IS NULL OR `acting_for_user_id` <> `user_id`);

ALTER TABLE `approval_delegation`
  ADD CONSTRAINT `ck_approval_delegation_users` CHECK (`from_user_id` <> `to_user_id`),
  ADD CONSTRAINT `ck_approval_delegation_period` CHECK (`valid_to` > `valid_from`),
  ADD CONSTRAINT `ck_approval_delegation_type` CHECK (`document_type` IS NULL OR `document_type` REGEXP '^[a-z][a-z0-9_]*$');

-- HAND-EDIT: per-table rights for the app account. A request moves through its steps (UPDATE) and is
-- never deleted. approval_action is the audit record of every decision: INSERT only (P3 §28.3, P7 §14).
-- A delegation may be ended early (UPDATE), never deleted.
GRANT UPDATE ON `approval_request` TO 'rupai_app'@'%';
GRANT UPDATE ON `approval_delegation` TO 'rupai_app'@'%';

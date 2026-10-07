-- CreateTable
CREATE TABLE `audit_change` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `record_type` VARCHAR(40) NOT NULL,
    `record_id` VARCHAR(26) NOT NULL,
    `action` VARCHAR(20) NOT NULL,
    `field` VARCHAR(64) NULL,
    `old_value` LONGTEXT NULL,
    `new_value` LONGTEXT NULL,
    `changed_by` BIGINT UNSIGNED NOT NULL,
    `acting_for_user_id` BIGINT UNSIGNED NULL,
    `changed_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `ip_address` VARCHAR(45) NULL,
    `user_agent` VARCHAR(255) NULL,
    `reason` VARCHAR(500) NULL,

    INDEX `ix_audit_record`(`record_type`, `record_id`, `changed_at`),
    INDEX `ix_audit_user`(`changed_by`, `changed_at`),
    INDEX `ix_audit_changed_at`(`changed_at`),
    INDEX `ix_audit_acting_for`(`acting_for_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `status_history` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `record_type` VARCHAR(40) NOT NULL,
    `record_id` VARCHAR(26) NOT NULL,
    `from_state` VARCHAR(30) NULL,
    `to_state` VARCHAR(30) NOT NULL,
    `changed_by` BIGINT UNSIGNED NOT NULL,
    `changed_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `workflow_step_id` BIGINT UNSIGNED NULL,
    `comment` VARCHAR(1000) NULL,

    INDEX `ix_status_history_record`(`record_type`, `record_id`, `changed_at`),
    INDEX `ix_status_history_changed_at`(`changed_at`),
    INDEX `ix_status_history_changed_by`(`changed_by`),
    INDEX `ix_status_history_workflow_step`(`workflow_step_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `access_log` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NULL,
    `event_type` VARCHAR(30) NOT NULL,
    `module` VARCHAR(40) NULL,
    `record_reference` VARCHAR(100) NULL,
    `ip_address` VARCHAR(45) NULL,
    `user_agent` VARCHAR(255) NULL,
    `occurred_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `detail` JSON NULL,

    INDEX `ix_access_log_user`(`user_id`, `occurred_at`),
    INDEX `ix_access_log_occurred_at`(`occurred_at`),
    INDEX `ix_access_log_event`(`event_type`, `occurred_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `integration_log` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `integration_key` VARCHAR(40) NOT NULL,
    `direction` VARCHAR(10) NOT NULL,
    `request_reference` VARCHAR(100) NULL,
    `endpoint` VARCHAR(255) NULL,
    `status_code` INTEGER NULL,
    `outcome` VARCHAR(20) NOT NULL,
    `duration_ms` INTEGER NULL,
    `error_message` VARCHAR(1000) NULL,
    `occurred_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `related_type` VARCHAR(40) NULL,
    `related_id` VARCHAR(26) NULL,

    INDEX `ix_integration_log_occurred_at`(`occurred_at`),
    INDEX `ix_integration_log_key`(`integration_key`, `occurred_at`),
    INDEX `ix_integration_log_related`(`related_type`, `related_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `audit_change` ADD CONSTRAINT `fk_audit_change_changed_by` FOREIGN KEY (`changed_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `audit_change` ADD CONSTRAINT `fk_audit_change_acting_for` FOREIGN KEY (`acting_for_user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `status_history` ADD CONSTRAINT `fk_status_history_changed_by` FOREIGN KEY (`changed_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `access_log` ADD CONSTRAINT `fk_access_log_user` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- HAND-EDIT: CHECK constraints (prisma/README.md).
ALTER TABLE `audit_change`
  ADD CONSTRAINT `ck_audit_change_action` CHECK (`action` IN
    ('create', 'update', 'delete', 'approve', 'reject', 'post', 'reverse', 'cancel')),
  ADD CONSTRAINT `ck_audit_change_record_type` CHECK (`record_type` REGEXP '^[a-z][a-z0-9_]*$');

ALTER TABLE `status_history`
  ADD CONSTRAINT `ck_status_history_record_type` CHECK (`record_type` REGEXP '^[a-z][a-z0-9_]*$');

-- P3 §29.2 lists login/logout/failed_login/permission_denied/scope_denied/export/print; P1 §12.4 adds
-- lockout, token issue and revocation, recorded here as their own events (BACKLOG D-1.05-3).
ALTER TABLE `access_log`
  ADD CONSTRAINT `ck_access_log_event_type` CHECK (`event_type` IN
    ('login', 'logout', 'failed_login', 'lockout', 'token_refresh', 'refresh_reuse', 'session_revoked',
     'password_changed', 'password_change_failed', 'password_reset', 'password_reset_requested',
     'permission_denied', 'scope_denied', 'export', 'print'));

ALTER TABLE `integration_log`
  ADD CONSTRAINT `ck_integration_log_direction` CHECK (`direction` IN ('inbound', 'outbound')),
  ADD CONSTRAINT `ck_integration_log_outcome` CHECK (`outcome` IN ('success', 'failure'));

-- HAND-EDIT: NO grant here. The app account keeps only its database-wide SELECT and INSERT on these four
-- tables, so the database itself makes them append-only (P3 §29, P1 §13.3, P14 §5.2).

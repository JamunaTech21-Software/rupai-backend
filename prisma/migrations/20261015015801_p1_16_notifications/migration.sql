-- CreateTable
CREATE TABLE `notification_rule` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(40) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `description` VARCHAR(500) NULL,
    `trigger_type` VARCHAR(40) NOT NULL,
    `condition_json` JSON NULL,
    `lead_days` SMALLINT NULL,
    `recipient_rule` VARCHAR(30) NOT NULL,
    `role_id` BIGINT UNSIGNED NULL,
    `user_id` BIGINT UNSIGNED NULL,
    `channel` VARCHAR(20) NOT NULL DEFAULT 'in_app',
    `severity` VARCHAR(20) NOT NULL DEFAULT 'info',
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_notification_rule_trigger`(`trigger_type`, `is_active`),
    INDEX `ix_notification_rule_role`(`role_id`),
    INDEX `ix_notification_rule_user`(`user_id`),
    INDEX `ix_notification_rule_created_by`(`created_by`),
    INDEX `ix_notification_rule_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_notification_rule_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notification` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `notification_rule_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `subject` VARCHAR(200) NOT NULL,
    `body` VARCHAR(2000) NOT NULL,
    `link_type` VARCHAR(50) NOT NULL,
    `link_id` BIGINT UNSIGNED NOT NULL,
    `severity` VARCHAR(20) NOT NULL,
    `generation_date` DATE NOT NULL,
    `read_at` DATETIME(0) NULL,
    `dismissed_at` DATETIME(0) NULL,
    `delivery_state` VARCHAR(20) NOT NULL,
    `delivery_attempts` SMALLINT NOT NULL DEFAULT 0,
    `delivery_started_at` DATETIME(0) NULL,
    `delivered_at` DATETIME(0) NULL,
    `delivery_error` VARCHAR(500) NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `ix_notification_user`(`user_id`, `dismissed_at`, `id`),
    INDEX `ix_notification_delivery`(`delivery_state`, `id`),
    INDEX `ix_notification_created_at`(`created_at`),
    UNIQUE INDEX `ux_notification_dedupe`(`notification_rule_id`, `user_id`, `link_type`, `link_id`, `generation_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `notification_rule` ADD CONSTRAINT `fk_notification_rule_role` FOREIGN KEY (`role_id`) REFERENCES `role`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `notification_rule` ADD CONSTRAINT `fk_notification_rule_user` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `notification_rule` ADD CONSTRAINT `fk_notification_rule_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `notification_rule` ADD CONSTRAINT `fk_notification_rule_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `notification` ADD CONSTRAINT `fk_notification_rule` FOREIGN KEY (`notification_rule_id`) REFERENCES `notification_rule`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `notification` ADD CONSTRAINT `fk_notification_user` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- HAND-EDIT: invariants the database can hold.
ALTER TABLE `notification_rule`
  ADD CONSTRAINT `ck_notification_rule_code` CHECK (`code` REGEXP '^[A-Z][A-Z0-9_]*$'),
  ADD CONSTRAINT `ck_notification_rule_trigger` CHECK (`trigger_type` IN (
    'approval_pending', 'approval_unresolved', 'document_expiry', 'access_review', 'budget_threshold',
    'payment_due', 'abnormal_yield', 'low_stock', 'contract_expiry', 'lease_due')),
  ADD CONSTRAINT `ck_notification_rule_recipient` CHECK (
    `recipient_rule` IN ('approvers', 'by_role', 'by_scope', 'by_named_user')
    AND (`recipient_rule` = 'by_role') = (`role_id` IS NOT NULL)
    AND (`recipient_rule` = 'by_named_user') = (`user_id` IS NOT NULL)),
  ADD CONSTRAINT `ck_notification_rule_channel` CHECK (`channel` IN ('in_app', 'email')),
  ADD CONSTRAINT `ck_notification_rule_severity` CHECK (`severity` IN ('info', 'warning', 'critical')),
  ADD CONSTRAINT `ck_notification_rule_lead_days` CHECK (`lead_days` IS NULL OR `lead_days` BETWEEN 0 AND 365);

ALTER TABLE `notification`
  ADD CONSTRAINT `ck_notification_severity` CHECK (`severity` IN ('info', 'warning', 'critical')),
  ADD CONSTRAINT `ck_notification_delivery_state` CHECK (
    `delivery_state` IN ('not_required', 'pending', 'sending', 'sent', 'failed', 'skipped')),
  -- Sent means when; and only a sent message has a delivery time.
  ADD CONSTRAINT `ck_notification_delivered` CHECK ((`delivery_state` = 'sent') = (`delivered_at` IS NOT NULL)),
  ADD CONSTRAINT `ck_notification_attempts` CHECK (`delivery_attempts` BETWEEN 0 AND 10);

-- HAND-EDIT: per-table rights for the app account.
--   notification_rule: edited and deactivated (UPDATE), never deleted: notifications refer to it.
--   notification: read, dismissed and delivered (UPDATE); purged after the retention period (DELETE).
GRANT UPDATE ON `notification_rule` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `notification` TO 'rupai_app'@'%';

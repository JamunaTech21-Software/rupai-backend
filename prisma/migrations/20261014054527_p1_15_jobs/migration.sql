-- CreateTable
CREATE TABLE `job` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `type` VARCHAR(60) NOT NULL,
    `state` VARCHAR(20) NOT NULL DEFAULT 'queued',
    `dedupe_key` VARCHAR(160) NULL,
    -- HAND-EDIT: generated: the dedupe key while the job is queued or running, else NULL. Its unique index
    -- allows one live job per (document, purpose): a second request returns the first (P4 §5.3).
    `active_key` VARCHAR(160) GENERATED ALWAYS AS (CASE WHEN `state` IN ('queued', 'running') THEN `dedupe_key` END) STORED,
    `payload` JSON NOT NULL,
    `progress_done` INTEGER NOT NULL DEFAULT 0,
    `progress_total` INTEGER NULL,
    `checkpoint` JSON NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `max_attempts` INTEGER NOT NULL,
    `available_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `run_token` CHAR(26) NULL,
    `lease_until` DATETIME(0) NULL,
    `result` JSON NULL,
    `error_code` VARCHAR(60) NULL,
    `error_message` VARCHAR(1000) NULL,
    `requested_by` BIGINT UNSIGNED NULL,
    `schedule_name` VARCHAR(60) NULL,
    `queued_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `started_at` DATETIME(0) NULL,
    `finished_at` DATETIME(0) NULL,
    `expires_at` DATETIME(0) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NULL,

    INDEX `ix_job_due`(`state`, `available_at`),
    INDEX `ix_job_lease`(`state`, `lease_until`),
    INDEX `ix_job_requested_by`(`requested_by`, `id`),
    INDEX `ix_job_type`(`type`, `state`),
    INDEX `ix_job_expires`(`expires_at`),
    UNIQUE INDEX `ux_job_active`(`active_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `job_processing_key` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `key` VARCHAR(190) NOT NULL,
    `job_id` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `ix_job_processing_key_job`(`job_id`),
    UNIQUE INDEX `ux_job_processing_key`(`key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `job_schedule` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(60) NOT NULL,
    `job_type` VARCHAR(60) NOT NULL,
    `cron` VARCHAR(60) NOT NULL,
    `is_paused` BOOLEAN NOT NULL DEFAULT false,
    `next_run_at` DATETIME(0) NULL,
    `last_run_at` DATETIME(0) NULL,
    `last_job_id` BIGINT UNSIGNED NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `ix_job_schedule_updated_by`(`updated_by`),
    UNIQUE INDEX `ux_job_schedule_name`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `process_heartbeat` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `process_key` VARCHAR(120) NOT NULL,
    `kind` VARCHAR(20) NOT NULL,
    `host` VARCHAR(100) NOT NULL,
    `pid` INTEGER NOT NULL,
    `app_version` VARCHAR(50) NOT NULL,
    `started_at` DATETIME(0) NOT NULL,
    `beat_at` DATETIME(0) NOT NULL,
    `stopped_at` DATETIME(0) NULL,

    UNIQUE INDEX `ux_process_heartbeat_key`(`process_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `job` ADD CONSTRAINT `fk_job_requested_by` FOREIGN KEY (`requested_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `job_schedule` ADD CONSTRAINT `fk_job_schedule_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- HAND-EDIT: CHECK constraints (prisma/README.md).
ALTER TABLE `job`
  ADD CONSTRAINT `ck_job_type` CHECK (`type` REGEXP '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$'),
  ADD CONSTRAINT `ck_job_state` CHECK (`state` IN ('queued', 'running', 'completed', 'failed', 'partial')),
  ADD CONSTRAINT `ck_job_progress` CHECK (
    `progress_done` >= 0 AND (`progress_total` IS NULL OR (`progress_total` >= 0 AND `progress_done` <= `progress_total`))),
  ADD CONSTRAINT `ck_job_attempts` CHECK (`max_attempts` BETWEEN 1 AND 10 AND `attempts` BETWEEN 0 AND `max_attempts`),
  -- A running job is held by exactly one run, until its lease ends; a job at rest is held by none.
  ADD CONSTRAINT `ck_job_lease` CHECK ((`state` = 'running') = (`run_token` IS NOT NULL AND `lease_until` IS NOT NULL)),
  -- A finished job says when it finished, and when it goes.
  ADD CONSTRAINT `ck_job_finished` CHECK (
    (`state` IN ('completed', 'failed', 'partial')) = (`finished_at` IS NOT NULL AND `expires_at` IS NOT NULL));

ALTER TABLE `job_processing_key`
  ADD CONSTRAINT `ck_job_processing_key` CHECK (`key` REGEXP '^[a-z][a-z0-9_]*:[^ ]+$');

ALTER TABLE `job_schedule`
  ADD CONSTRAINT `ck_job_schedule_name` CHECK (`name` REGEXP '^[a-z][a-z0-9_.]*$'),
  ADD CONSTRAINT `ck_job_schedule_cron` CHECK (`cron` <> '');

ALTER TABLE `process_heartbeat`
  ADD CONSTRAINT `ck_process_heartbeat_kind` CHECK (`kind` IN ('scheduler', 'worker')),
  ADD CONSTRAINT `ck_process_heartbeat_beat` CHECK (`beat_at` >= `started_at`);

-- HAND-EDIT: per-table rights for the app account.
--   job: a job moves through its states (UPDATE); finished jobs are purged after their retention (DELETE).
--   job_processing_key: INSERT only. A key is the proof an effect happened and is never removed.
--   job_schedule: paused, resumed and advanced (UPDATE); a schedule is never deleted.
--   process_heartbeat: renewed (UPDATE); entries of processes long gone are purged (DELETE).
--   auth_refresh_token, password_reset_token: purged once long expired (D-1.02-2). auth_session is the
--   record of who was signed in, and is kept.
GRANT UPDATE, DELETE ON `job` TO 'rupai_app'@'%';
GRANT UPDATE ON `job_schedule` TO 'rupai_app'@'%';
GRANT UPDATE, DELETE ON `process_heartbeat` TO 'rupai_app'@'%';
GRANT DELETE ON `auth_refresh_token` TO 'rupai_app'@'%';
GRANT DELETE ON `password_reset_token` TO 'rupai_app'@'%';

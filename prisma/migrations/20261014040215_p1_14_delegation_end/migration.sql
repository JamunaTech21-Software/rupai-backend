-- AlterTable
ALTER TABLE `approval_delegation` ADD COLUMN `ended_at` DATETIME(0) NULL;

-- HAND-EDIT: an ended delegation stays ended.
ALTER TABLE `approval_delegation`
  ADD CONSTRAINT `ck_approval_delegation_ended` CHECK (`ended_at` IS NULL OR `ended_at` >= `created_at`);

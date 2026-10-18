-- HAND-EDIT note: a numbered Worker ID (prefix, estate code, year, sequence) can exceed P3's code(20)
-- when estate codes are long; 40 holds any format the number formats allow (D-2.02-8).
-- AlterTable
ALTER TABLE `employment_profile` MODIFY `profile_number` VARCHAR(40) NOT NULL;

-- Runs once, on first start of an empty data volume (local development only).
-- Production provisioning mirrors this with real secrets (Spec P14 §5.2, BACKLOG §2.1).

CREATE DATABASE IF NOT EXISTS rupai        CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- Scratch database for `prisma migrate dev` / `migrate diff`. Never holds real data.
CREATE DATABASE IF NOT EXISTS rupai_shadow CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------------------------
-- Migration account: schema changes (DDL). Used only by `prisma migrate deploy` / `migrate dev`.
-- WITH GRANT OPTION, because migrations grant UPDATE/DELETE per table to the app account (below).
-- It may also create and drop throwaway databases named rupai_tmp_* for tests.
-- ---------------------------------------------------------------------------------------------
CREATE USER IF NOT EXISTS 'rupai_migrator'@'%' IDENTIFIED BY 'rupai_migrator_dev';
GRANT ALL PRIVILEGES ON rupai.*          TO 'rupai_migrator'@'%' WITH GRANT OPTION;
GRANT ALL PRIVILEGES ON rupai_shadow.*   TO 'rupai_migrator'@'%' WITH GRANT OPTION;
GRANT ALL PRIVILEGES ON `rupai\_tmp\_%`.* TO 'rupai_migrator'@'%' WITH GRANT OPTION;

-- ---------------------------------------------------------------------------------------------
-- Application account: data only, and append-only by default.
--
-- Database-wide it may only SELECT and INSERT. UPDATE and DELETE are granted PER TABLE by the
-- migration that creates the table. Append-only tables (audit_change, status_history, access_log,
-- integration_log, stock_movement, journal_line, ...) never receive them, so the database itself
-- enforces immutability (Spec P3 §29, P14 §5.2). MySQL cannot revoke a table from a database-wide
-- grant, which is why the grant is built up per table rather than taken away.
-- ---------------------------------------------------------------------------------------------
CREATE USER IF NOT EXISTS 'rupai_app'@'%' IDENTIFIED BY 'rupai_app_dev';
GRANT SELECT, INSERT ON rupai.*          TO 'rupai_app'@'%';
GRANT SELECT, INSERT ON `rupai\_tmp\_%`.* TO 'rupai_app'@'%';

FLUSH PRIVILEGES;

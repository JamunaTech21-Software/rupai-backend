#!/bin/bash
# Runs once, on first start of an empty data volume (MySQL image entrypoint). Same accounts and rights
# as docker/mysql/init (local), with the passwords from deploy/staging/.env instead of dev defaults.
set -euo pipefail

# Executable init scripts run in their own process, so the entrypoint's helper functions are not
# available: talk to the temporary init server over its socket instead.
mysql --protocol=socket -uroot -p"${MYSQL_ROOT_PASSWORD}" <<-EOSQL
	CREATE DATABASE IF NOT EXISTS rupai CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

	-- Migration account: DDL, and it grants UPDATE/DELETE per table to the app account.
	CREATE USER IF NOT EXISTS 'rupai_migrator'@'%' IDENTIFIED BY '${MIGRATOR_DB_PASSWORD}';
	GRANT ALL PRIVILEGES ON rupai.* TO 'rupai_migrator'@'%' WITH GRANT OPTION;

	-- Application account: SELECT/INSERT database-wide; UPDATE/DELETE granted per table by migrations.
	CREATE USER IF NOT EXISTS 'rupai_app'@'%' IDENTIFIED BY '${APP_DB_PASSWORD}';
	GRANT SELECT, INSERT ON rupai.* TO 'rupai_app'@'%';

	FLUSH PRIVILEGES;
EOSQL

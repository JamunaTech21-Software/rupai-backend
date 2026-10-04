#!/bin/bash
# Nightly logical backup of the staging database (P0.08). Runs in the `backup` container.
# A consistent snapshot without locking (InnoDB, --single-transaction), gzipped, one file per day,
# files older than BACKUP_KEEP_DAYS removed. Restore: gunzip -c FILE | mysql -h mysql -uroot -p rupai
set -uo pipefail

KEEP="${BACKUP_KEEP_DAYS:-14}"
backup() {
  local file="/backups/rupai-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
  if mysqldump -h mysql -uroot --single-transaction --routines --triggers --set-gtid-purged=OFF rupai \
    | gzip > "$file.part"; then
    mv "$file.part" "$file"
    echo "backup written: $file"
  else
    rm -f "$file.part"
    echo "BACKUP FAILED" >&2
    return 1
  fi
  find /backups -name 'rupai-*.sql.gz' -mtime +"$KEEP" -delete
  return 0
}

if [ "${1:-}" = "--once" ]; then # deploy.sh: one backup before migrating; its exit code matters
  backup
  exit $?
fi

backup # once at start, so a fresh deploy has a backup immediately
while true; do
  # Next run at 20:00 UTC = 02:00 in Dhaka, when nobody is using staging.
  now=$(date -u +%s)
  next=$(date -u -d "today 20:00" +%s)
  if [ "$next" -le "$now" ]; then next=$(date -u -d "tomorrow 20:00" +%s); fi
  sleep $((next - now))
  backup
done

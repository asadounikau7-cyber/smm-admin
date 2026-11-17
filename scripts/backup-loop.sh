#!/bin/sh
# Nightly pg_dump into ./backups, keeps the 14 newest dumps.
while true; do
  pg_dump -h db -U smm -Fc smm > "/backups/smm-$(date +%F).dump"
  ls -1t /backups/*.dump 2>/dev/null | tail -n +15 | while read -r old; do rm -f -- "$old"; done
  sleep 86400
done

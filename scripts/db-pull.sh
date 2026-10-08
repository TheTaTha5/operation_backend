#!/bin/sh
# Run by docker-compose's `pull` service: `docker compose --profile pull run --rm pull`.
#
# 1. Dumps Railway's operations database (APP_URL) and legacy's (LEGACY_URL) to /dumps, in read-only
#    sessions: legacy is production, and neither is ever written from here.
# 2. Drops and recreates the local `operations` and `legacy` databases and restores the dumps into
#    them. Whatever was there is replaced; connections to them (the API's) are closed.
#
# SKIP_DUMP=1 restores the dumps already in /dumps without fetching new ones.
set -u

if [ -z "${SKIP_DUMP}" ]; then
  [ -n "${LEGACY_URL}" ] || { echo "ORIGINAL_DATABASE_URL is not set in .env"; exit 1; }
  [ -n "${APP_URL}" ] || { echo "DATABASE_URL is not set in .env"; exit 1; }
  for pair in "legacy ${LEGACY_URL}" "operations ${APP_URL}"; do
    name=${pair%% *}; url=${pair#* }
    echo "dumping ${name} …"
    PGOPTIONS='-c default_transaction_read_only=on' \
      pg_dump --format=custom --no-owner --no-acl --file="/dumps/${name}.dump.part" "${url}" \
      || { echo "pg_dump of ${name} failed; nothing was restored"; rm -f "/dumps/${name}.dump.part"; exit 1; }
    mv "/dumps/${name}.dump.part" "/dumps/${name}.dump"
    echo "  $(du -h "/dumps/${name}.dump" | cut -f1) → .docker/dumps/${name}.dump"
  done
fi

failed=""
for name in operations legacy; do
  [ -f "/dumps/${name}.dump" ] || { echo "no .docker/dumps/${name}.dump; run without SKIP_DUMP first"; exit 1; }
  echo "restoring ${name} …"
  psql -h db -U postgres -d postgres -v ON_ERROR_STOP=1 -q \
    -c "DROP DATABASE IF EXISTS \"${name}\" WITH (FORCE)" -c "CREATE DATABASE \"${name}\"" || exit 1
  # Not --exit-on-error: a restore that hits, say, an extension this image lacks still loads every
  # table it can. Each error is printed, and the run fails at the end so it is not mistaken for clean.
  pg_restore -h db -U postgres -d "${name}" --no-owner --no-acl "/dumps/${name}.dump" || failed="${failed} ${name}"
done

if [ -n "${failed}" ]; then
  echo "pg_restore reported errors for:${failed}. Read them above: most tables may still have loaded."
  exit 1
fi
echo "done: local databases operations and legacy now match the dumps."

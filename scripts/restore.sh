#!/usr/bin/env bash
set -euo pipefail
: "${DIRECT_DATABASE_URL:?DIRECT_DATABASE_URL must be set}"
DUMP="${1:?Usage: scripts/restore.sh <path-to-dump-file>}"
pg_restore --clean --if-exists --no-owner --no-acl --dbname="$DIRECT_DATABASE_URL" "$DUMP"
echo "Restore complete from: $DUMP"

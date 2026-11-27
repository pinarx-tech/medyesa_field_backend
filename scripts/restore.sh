#!/usr/bin/env bash
set -euo pipefail
: "${DIRECT_DATABASE_URL:?DIRECT_DATABASE_URL must be set}"
DUMP="${1:?Usage: scripts/restore.sh <path-to-dump-file>}"
LIBPQ_URL=$(node -e '
const u = new URL(process.env.DIRECT_DATABASE_URL);
for (const k of ["schema", "pgbouncer", "connection_limit"]) u.searchParams.delete(k);
console.log(u.toString());
')
pg_restore --clean --if-exists --no-owner --no-acl --dbname="$LIBPQ_URL" "$DUMP"
echo "Restore complete from: $DUMP"

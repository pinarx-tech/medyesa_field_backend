#!/usr/bin/env bash
set -euo pipefail
: "${DIRECT_DATABASE_URL:?DIRECT_DATABASE_URL must be set}"
# Strip Prisma-specific query parameters (schema, pgbouncer, connection_limit) unsupported by libpq pg_dump.
LIBPQ_URL=$(node -e '
const u = new URL(process.env.DIRECT_DATABASE_URL);
for (const k of ["schema", "pgbouncer", "connection_limit"]) u.searchParams.delete(k);
console.log(u.toString());
')
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="backups/medyesa_${STAMP}.dump"
mkdir -p backups
pg_dump "$LIBPQ_URL" --format=custom --no-owner --no-acl -f "$OUT"
echo "Backup written: $OUT ($(du -h "$OUT" | cut -f1))"

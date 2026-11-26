#!/usr/bin/env bash
set -euo pipefail
: "${DIRECT_DATABASE_URL:?DIRECT_DATABASE_URL must be set}"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="backups/medyesa_${STAMP}.dump"
mkdir -p backups
pg_dump "$DIRECT_DATABASE_URL" --format=custom --no-owner --no-acl -f "$OUT"
echo "Backup written: $OUT ($(du -h "$OUT" | cut -f1))"

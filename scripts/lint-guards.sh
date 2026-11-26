#!/usr/bin/env bash
set -euo pipefail

# 1. Forbid destructive Prisma commands anywhere in src, prisma, or package.json
if grep -rnE 'prisma\s+(migrate\s+reset|db\s+push)' src prisma package.json >/dev/null 2>&1; then
  echo "ERROR: Forbidden Prisma command (migrate reset / db push) detected."
  exit 1
fi

# 2. Secrets hygiene check (never allow literal credentials in src or prisma)
if grep -rnE "(postgres(ql)?://|JWT_SECRET=|AIza[0-9A-Za-z_-]{20,}|sk-live|password:\s*'[^']+')" src prisma >/dev/null 2>&1; then
  echo "ERROR: Potential hardcoded secret or credential detected in src/ or prisma/."
  exit 1
fi

# 3. Heuristic tenant-scoping check in repositories
# Note: Heuristic safety net — verifies every raw tenant-model query in src/repos
# references companyId or a Repo scoping helper. Real proof is test/tenant-isolation.test.ts.
if grep -rnE 'prisma\.(doctor|doctorClinicLocation|territory|mrTerritoryAssignment|territoryDoctor|visit|visitNote|workDay|activityLog|hcNotificationPrefs)\.(findMany|findFirst|update|updateMany|delete|deleteMany)\(' src/repos --include='*.ts' \
  | grep -vE 'companyId|scopeCompany|scopeSelf|scopeCompanyExplicit' >/dev/null 2>&1; then
  echo "WARNING/ERROR: Potential unscoped Prisma call in src/repos."
  exit 1
fi

echo "All lint guards passed."

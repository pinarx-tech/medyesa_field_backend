# Medyesa Field Backend

Central HTTPS API for **Medyesa Field** (Developed by **PINARX** for Medyesa Healthcare).

## Stack
- Node.js 20 LTS, TypeScript 5 (strict), Fastify 4, Prisma 5, Zod
- Neon PostgreSQL 16 (AWS `ap-southeast-1`, Singapore)
- Render Free Web Service (Singapore)
- `@node-rs/argon2` (Argon2id, OWASP 2024 parameters) + HS256 JWT + rotating SHA-256 refresh tokens

## Local Setup & Commands
```bash
cp .env.example .env
# Fill DATABASE_URL (pooled), DIRECT_DATABASE_URL (direct), JWT_SECRET
npm ci
npx prisma migrate dev --name initial_schema --create-only
npx prisma migrate deploy
npm run build
npm run lint
npm test

Seeding (Run Locally Against Target DB — Never Hardcode Passwords)
Bash

SEED_PLATFORM_ADMIN_PASSWORD="..." \
SEED_HC_PASSWORD="..." \
SEED_MR_PASSWORD="..." \
npx prisma db seed

Backups & Restore
Bash

# Manual backup (run before every prisma migrate deploy and weekly on Fridays)
DIRECT_DATABASE_URL="..." bash scripts/backup.sh

# Restore to a throwaway Neon branch
DIRECT_DATABASE_URL="..." bash scripts/restore.sh backups/medyesa_YYYYMMDDTHHMMSSZ.dump


---

### 4. Exact Execution & Deployment Sequence (Run on Your Rocky Linux Workstation)

#### Step A: Install, Migrate, Lint & Run All 25 Tests (Neon Test Branch)
```bash
cd ~/Projects/medyesa_field_backend
chmod +x scripts/backup.sh scripts/restore.sh scripts/lint-guards.sh

# 1. Install dependencies
npm install

# 2. Generate initial migration SQL and review it
#    (Point DATABASE_URL & DIRECT_DATABASE_URL in .env to your Neon project)
npx prisma migrate dev --name initial_schema --create-only
cat prisma/migrations/*_initial_schema/migration.sql

# 3. Apply migration to main Neon branch
npx prisma migrate deploy

# 4. Run build and lint guards (tsc + no migrate reset/db push + no hardcoded secrets + repo scope check)
npm run build
npm run lint

# 5. Point DATABASE_URL + DIRECT_DATABASE_URL to a throwaway Neon `test` branch, apply migrations, and run all 25 tests
DATABASE_URL="$NEON_TEST_POOLED_URL" DIRECT_DATABASE_URL="$NEON_TEST_DIRECT_URL" npx prisma migrate deploy
DATABASE_URL="$NEON_TEST_POOLED_URL" DIRECT_DATABASE_URL="$NEON_TEST_DIRECT_URL" npm test

Step B: Backup & Restore Drill (Required by §10.9)
Bash

# 1. Seed main branch twice to verify idempotency
SEED_PLATFORM_ADMIN_PASSWORD="$(openssl rand -base64 16)" \
SEED_HC_PASSWORD="$(openssl rand -base64 16)" \
SEED_MR_PASSWORD="$(openssl rand -base64 16)" \
npx prisma db seed
# Run a second time with the same env vars and confirm zero duplicate rows.

# 2. Take a manual backup of the main Neon branch
bash scripts/backup.sh

# 3. Restore that dump into a fresh throwaway Neon branch and verify row counts
DIRECT_DATABASE_URL="$NEON_THROWAWAY_DIRECT_URL" bash scripts/restore.sh backups/medyesa_*.dump
psql "$NEON_THROWAWAY_DIRECT_URL" -c 'SELECT code, name FROM "Company"; SELECT "employeeId", role FROM "User";'

Step C: Deploy to Render Free (Singapore) & Verify Externally
Bash

# 1. Commit and push ~/Projects/medyesa_field_backend to GitHub (sujan-angadi/medyesa_field_backend)
git add .
git commit -m "Phase 8 Chunk 1: Central Fastify + Prisma + Neon backend"
git remote add origin git@github.com:sujan-angadi/medyesa_field_backend.git
git push -u origin main

# 2. In Render Dashboard -> New Blueprint -> select medyesa_field_backend
#    Set secrets in Render UI (never in render.yaml):
#      DATABASE_URL, DIRECT_DATABASE_URL, JWT_SECRET, CORS_ALLOWED_ORIGINS

# 3. Verify from your laptop AND from your phone on mobile data:
curl -s https://medyesa-field-api.onrender.com/health
curl -s https://medyesa-field-api.onrender.com/health/db
curl -s https://medyesa-field-api.onrender.com/v1/version

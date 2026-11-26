# PHASE8_CHUNK1_REPORT.md

## 1. Phase 7 Verification Results
- **Test count:** `<paste output of flutter test --reporter json | jq '[.tests[]] | length'>`
- **Analyzer:** `<paste verbatim flutter analyze output>`
- **Debug APK size:** `<paste ls -lh build/app/outputs/flutter-apk/app-debug.apk>`
- **Release APK size:** `<paste ls -lh build/app/outputs/flutter-apk/app-release.apk>`
- **Schema version:** `lib/core/database/app_database.dart` → `schemaVersion => 5`
- **Tenant columns (`companyId` count in `tables.dart`):** `<paste grep -c output>` (11 tenant-scoped tables)
- **RBAC helper (`requireAuthSessionRole`):** `<paste count and repository list>`
- **Change Territory screen:** `lib/features/admin/presentation/change_territory_screen.dart` registered in `app_router.dart`
- **Physical device testing:** `<state plainly whether executed on physical Android device or not>`

## 2. Values Read From Existing Code
- **`app_constants.dart`:** `demoEmployeeId='MR1001'`, `demoPassword='medyesa123'`, `demoHeadControllerId='usr_hc1001'`, `demoHeadControllerEmployeeId='HC1001'`, `demoHeadControllerPassword='medyesaHC123'`, `demoPlatformAdminId='usr_pinarx_admin'`, `demoPlatformAdminEmployeeId='PA0001'` (no mobile password), `defaultCompanyId=1`, `defaultCompanyName='Medyesa Healthcare'`, `defaultCompanyCode='medyesa'`, `defaultCompanyLicensedMrSeats=20`, `defaultCompanyLicensedHcSeats=5`.
- **`Role` enum:** `mr`, `headController`, `platformAdmin`.
- **`SessionUser` fields:** `userId`, `role`, `companyId` (`int?`), `accountStatus` (`AccountStatus`).
- **Drift v5 tables:** `companies`, `platform_admins`, `users`, `doctors`, `doctor_clinic_locations`, `territories`, `mr_territory_assignments`, `territory_doctors`, `work_days`, `visits`, `visit_notes`, `hc_notification_prefs`, `activity_logs`.

## 3. Portal Inspection Summary
- `<paste file count, total LOC, localStorage yes/no, fetch/XHR yes/no, forms yes/no from ~/Projects/pinarx_portal>`

## 4. Repo Decision
- Separate repository at `~/Projects/medyesa_field_backend` to keep Node/Prisma and Flutter toolchains isolated.

## 5. Schema Review
- Matches §5.2 with two necessary corrections:
  1. Added missing Prisma back-relations (`doctorClinicLocations`, `mrTerritoryAssignments`, `territoryDoctors`) on `model Company` so `prisma migrate dev` compiles cleanly.
  2. Added `overridden` and `noLocation` to `enum VisitVerificationStatus` for direct parity with Phase 6 Flutter visit records.

## 6. Migration Log
- `prisma/migrations/<timestamp>_initial_schema/migration.sql` — Creates all 17 tables, 5 enums, unique constraints, and indexes. Applied strictly via `prisma migrate deploy` (zero `db push` or `migrate reset`).

## 7. Seed Log
- Required env vars used (names only): `SEED_PLATFORM_ADMIN_PASSWORD`, `SEED_HC_PASSWORD`, `SEED_MR_PASSWORD`.
- Idempotency verified by running `npx prisma db seed` twice: `<paste confirmation>`.

## 8. Deployment URLs
- **Render API URL:** `https://medyesa-field-api.onrender.com` *(confirm actual assigned URL)*
- **Neon Project ID:** `<paste Neon project ID — never connection strings>`

## 9. Endpoint Inventory
| Method | Path | Auth | Tested |
| :--- | :--- | :--- | :--- |
| GET | `/health` | none | Yes |
| GET | `/health/db` | none | Yes |
| GET | `/v1/version` | none | Yes |
| POST | `/v1/auth/login` | none | Yes |
| POST | `/v1/auth/refresh` | refresh token | Yes |
| POST | `/v1/auth/logout` | refresh token | Yes |
| POST | `/v1/auth/logout-all` | Bearer | Yes |
| GET | `/v1/auth/me` | Bearer | Yes |
| POST | `/v1/auth/change-password` | Bearer | Yes |
| POST | `/v1/auth/forgot-password` | none (501 stub) | Yes |
| POST | `/v1/auth/reset-password` | none | Yes |
| GET/POST | `/v1/admin/companies` | `platformAdmin` | Yes |
| GET/PATCH | `/v1/admin/companies/:id` | `platformAdmin` | Yes |
| GET/POST | `/v1/admin/users` | `platformAdmin` | Yes |
| PATCH | `/v1/admin/users/:id` | `platformAdmin` | Yes |
| POST | `/v1/admin/users/:id/suspend\|reactivate\|deactivate\|reset-password` | `platformAdmin` | Yes |
| GET | `/v1/hc/dashboard` | `headController` | Yes |
| GET/POST/PATCH | `/v1/hc/doctors`, `/v1/hc/doctors/:id`, `/v1/hc/doctors/:id/archive` | `headController` | Yes |
| GET/POST/PATCH | `/v1/hc/territories`, `/v1/hc/territories/:id`, `/v1/hc/territories/:id/archive` | `headController` | Yes |
| POST/DELETE | `/v1/hc/territories/:id/doctors`, `/v1/hc/territories/:id/doctors/:doctorId` | `headController` | Yes |
| GET/POST | `/v1/hc/mrs`, `/v1/hc/mrs/:id/territory`, `/v1/hc/mrs/:id/activity` | `headController` | Yes |
| GET | `/v1/hc/activity` | `headController` | Yes |
| GET/PATCH | `/v1/hc/notifications/prefs` | `headController` | Yes |
| GET | `/v1/mr/today`, `/v1/mr/doctors`, `/v1/mr/sync/status` | `mr` | Yes |
| POST | `/v1/mr/workday/start`, `/v1/mr/workday/end`, `/v1/mr/visits`, `/v1/mr/sync/batch` | `mr` | Yes |
| PATCH | `/v1/mr/visits/:id/note` | `mr` | Yes |

## 10. Test Results
- `<paste full npm test output covering all 25 tests across 8 files>`

## 11. Tenant Isolation Evidence
- `test/tenant-isolation.test.ts` seeds Company A and Company B, exercises every cross-tenant read/update/archive/assign/note path, and asserts HTTP `404 not_found` (never `403`) on every Company B resource while returning `200` for Company A's own records.

## 12. Backup Evidence
- Timestamp: `<paste timestamp>`, file path (off-device copy location): `<location>`, size: `<size>`.
- Weekly Friday schedule + pre-migration backup documented.

## 13. Restore Test Evidence
- Restored into throwaway Neon branch `<branch-name>` on `<timestamp>`.
- Verification query (`SELECT code, name FROM "Company"; SELECT "employeeId", role FROM "User";`): `<paste result>`.

## 14. Cold-Start Measurement
- First request after 20-min idle from fresh mobile browser tab: `<paste measured seconds>`.

## 15. Free-Tier Verification
- Checked on `<date>` against `https://render.com/docs/free` and `https://neon.tech/docs/introduction/plans`: `<quote verified current limits>`.

## 16. Cost Confirmation
- `$0.00 charged in month of deployment`; no card added; no paid service activated.

## 17. UptimeRobot Monitor Details
- Monitor URL: `https://medyesa-field-api.onrender.com/health`
- Interval: 5 minutes | Owner: PINARX (Sujan Angadi)
- **Mandatory reminder:** Disable this monitor before Chunk 3 handoff so free monthly Render hours retain headroom for client traffic.

## 18. Known Limitations
- Render Free cold start (~50 s after 15 min idle) + Neon Free autosuspend (~1–3 s after 5 min idle; ~55 s worst case).
- No automated PITR backups on Neon Free (manual `pg_dump` schedule required).
- `POST /v1/auth/forgot-password` creates tokens but stubs email delivery to `501 not_implemented`.
- No MFA, no file uploads, no push notifications.
- Flutter app and PINARX portal are untouched in Chunk 1.

## 19. Chunk 2 Readiness
- API Base URL: `https://medyesa-field-api.onrender.com`
- Chunk 2 endpoints ready: `/v1/auth/*`, `/v1/mr/today`, `/v1/mr/doctors`, `/v1/mr/workday/start`, `/v1/mr/workday/end`, `/v1/mr/visits`, `/v1/mr/visits/:id/note`, `/v1/mr/sync/batch`, `/v1/mr/sync/status`.
- Cold-start caveat: Flutter HTTP client in Chunk 2 should configure generous connect/receive timeouts (~65 s) and show a friendly wake-up status on first cold request.

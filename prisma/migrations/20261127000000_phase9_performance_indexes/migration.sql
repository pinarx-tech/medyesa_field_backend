-- Phase 9 additive performance indexes (non-destructive, idempotent)
CREATE INDEX IF NOT EXISTS "idx_sync_op_company_actor_status"
  ON "SyncOperation" ("companyId", "actorId", "status");

CREATE INDEX IF NOT EXISTS "idx_visit_company_mr_status_captured"
  ON "Visit" ("companyId", "mrId", "status", "capturedAtClient");

CREATE INDEX IF NOT EXISTS "idx_doctor_company_archived_deleted"
  ON "Doctor" ("companyId", "isArchived", "deletedAt");

CREATE INDEX IF NOT EXISTS "idx_dcl_company_doctor_current"
  ON "DoctorClinicLocation" ("companyId", "doctorId", "isCurrent");

CREATE INDEX IF NOT EXISTS "idx_td_company_territory_unassigned_doc"
  ON "TerritoryDoctor" ("companyId", "territoryId", "unassignedAt", "doctorId");

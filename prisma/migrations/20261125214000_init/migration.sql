-- CreateEnum
CREATE TYPE "Role" AS ENUM ('platformAdmin', 'headController', 'mr');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('active', 'deactivated', 'suspended');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('active', 'pastDue', 'canceled', 'suspended');

-- CreateEnum
CREATE TYPE "VisitVerificationStatus" AS ENUM ('verified', 'outsideRadius', 'overridden', 'noLocation', 'locationUnavailable', 'permissionDenied', 'accuracyInsufficient', 'unverified');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('pending', 'synced', 'failed');

-- CreateTable
CREATE TABLE "Company" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "licensedMrSeats" INTEGER NOT NULL DEFAULT 10,
    "licensedHcSeats" INTEGER NOT NULL DEFAULT 2,
    "subscriptionStatus" "SubscriptionStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "companyId" INTEGER,
    "employeeId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "phone" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "accountStatus" "AccountStatus" NOT NULL DEFAULT 'active',
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformAdmin" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformAdmin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Doctor" (
    "id" TEXT NOT NULL,
    "companyId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "specialty" TEXT NOT NULL,
    "clinicName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "isCustom" BOOLEAN NOT NULL DEFAULT false,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "geofenceRadiusMeters" INTEGER NOT NULL DEFAULT 100,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Doctor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DoctorClinicLocation" (
    "id" TEXT NOT NULL,
    "companyId" INTEGER NOT NULL,
    "doctorId" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "accuracyMeters" DOUBLE PRECISION,
    "clinicName" TEXT,
    "formattedAddress" TEXT,
    "placeName" TEXT,
    "placeProvider" TEXT,
    "placeProviderId" TEXT,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "capturedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DoctorClinicLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Territory" (
    "id" TEXT NOT NULL,
    "companyId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "notes" TEXT,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdByHeadControllerId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Territory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MrTerritoryAssignment" (
    "id" TEXT NOT NULL,
    "companyId" INTEGER NOT NULL,
    "mrId" TEXT NOT NULL,
    "territoryId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unassignedAt" TIMESTAMP(3),
    "assignedByHeadControllerId" TEXT NOT NULL,

    CONSTRAINT "MrTerritoryAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TerritoryDoctor" (
    "id" TEXT NOT NULL,
    "companyId" INTEGER NOT NULL,
    "territoryId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unassignedAt" TIMESTAMP(3),
    "assignedByHeadControllerId" TEXT NOT NULL,

    CONSTRAINT "TerritoryDoctor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkDay" (
    "id" TEXT NOT NULL,
    "companyId" INTEGER NOT NULL,
    "mrId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "autoClosed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Visit" (
    "id" TEXT NOT NULL,
    "companyId" INTEGER NOT NULL,
    "mrId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "workDayId" TEXT,
    "status" TEXT NOT NULL,
    "checkInLatitude" DOUBLE PRECISION,
    "checkInLongitude" DOUBLE PRECISION,
    "checkInAccuracyMeters" DOUBLE PRECISION,
    "checkInDistanceMeters" DOUBLE PRECISION,
    "checkInVerificationStatus" "VisitVerificationStatus" NOT NULL DEFAULT 'unverified',
    "checkInOverrideReason" TEXT,
    "checkInCapturedAt" TIMESTAMP(3),
    "checkOutAt" TIMESTAMP(3),
    "doctorClinicLocationIdAtCheckIn" TEXT,
    "territoryIdAtVisit" TEXT,
    "correctsVisitId" TEXT,
    "capturedAtClient" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Visit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisitNote" (
    "id" TEXT NOT NULL,
    "companyId" INTEGER NOT NULL,
    "visitId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "visitDate" DATE NOT NULL,
    "noteText" VARCHAR(500) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VisitNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "companyId" INTEGER,
    "actorId" TEXT NOT NULL,
    "actorRole" "Role" NOT NULL,
    "actorDisplayName" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "subjectType" TEXT,
    "subjectId" TEXT,
    "subjectDisplayName" TEXT,
    "territoryId" TEXT,
    "detailsJson" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HcNotificationPrefs" (
    "id" TEXT NOT NULL,
    "companyId" INTEGER NOT NULL,
    "headControllerId" TEXT NOT NULL,
    "verifiedVisitNotificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "overrideNotificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HcNotificationPrefs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncOperation" (
    "id" TEXT NOT NULL,
    "companyId" INTEGER NOT NULL,
    "actorId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "serverId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "SyncOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "companyId" INTEGER,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Company_code_key" ON "Company"("code");

-- CreateIndex
CREATE INDEX "Company_code_idx" ON "Company"("code");

-- CreateIndex
CREATE INDEX "User_companyId_idx" ON "User"("companyId");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_companyId_employeeId_key" ON "User"("companyId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "User_companyId_email_key" ON "User"("companyId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformAdmin_userId_key" ON "PlatformAdmin"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "Doctor_companyId_idx" ON "Doctor"("companyId");

-- CreateIndex
CREATE INDEX "Doctor_companyId_isArchived_idx" ON "Doctor"("companyId", "isArchived");

-- CreateIndex
CREATE INDEX "DoctorClinicLocation_doctorId_isCurrent_idx" ON "DoctorClinicLocation"("doctorId", "isCurrent");

-- CreateIndex
CREATE INDEX "DoctorClinicLocation_companyId_idx" ON "DoctorClinicLocation"("companyId");

-- CreateIndex
CREATE INDEX "Territory_companyId_idx" ON "Territory"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Territory_companyId_code_key" ON "Territory"("companyId", "code");

-- CreateIndex
CREATE INDEX "MrTerritoryAssignment_companyId_mrId_unassignedAt_idx" ON "MrTerritoryAssignment"("companyId", "mrId", "unassignedAt");

-- CreateIndex
CREATE INDEX "MrTerritoryAssignment_territoryId_unassignedAt_idx" ON "MrTerritoryAssignment"("territoryId", "unassignedAt");

-- CreateIndex
CREATE INDEX "TerritoryDoctor_companyId_territoryId_unassignedAt_idx" ON "TerritoryDoctor"("companyId", "territoryId", "unassignedAt");

-- CreateIndex
CREATE INDEX "TerritoryDoctor_doctorId_unassignedAt_idx" ON "TerritoryDoctor"("doctorId", "unassignedAt");

-- CreateIndex
CREATE INDEX "WorkDay_companyId_mrId_startedAt_idx" ON "WorkDay"("companyId", "mrId", "startedAt");

-- CreateIndex
CREATE INDEX "WorkDay_mrId_endedAt_idx" ON "WorkDay"("mrId", "endedAt");

-- CreateIndex
CREATE INDEX "Visit_companyId_mrId_capturedAtClient_idx" ON "Visit"("companyId", "mrId", "capturedAtClient");

-- CreateIndex
CREATE INDEX "Visit_companyId_doctorId_capturedAtClient_idx" ON "Visit"("companyId", "doctorId", "capturedAtClient");

-- CreateIndex
CREATE INDEX "Visit_correctsVisitId_idx" ON "Visit"("correctsVisitId");

-- CreateIndex
CREATE UNIQUE INDEX "VisitNote_visitId_key" ON "VisitNote"("visitId");

-- CreateIndex
CREATE INDEX "VisitNote_companyId_doctorId_visitDate_idx" ON "VisitNote"("companyId", "doctorId", "visitDate");

-- CreateIndex
CREATE INDEX "ActivityLog_companyId_occurredAt_idx" ON "ActivityLog"("companyId", "occurredAt");

-- CreateIndex
CREATE INDEX "ActivityLog_actorId_occurredAt_idx" ON "ActivityLog"("actorId", "occurredAt");

-- CreateIndex
CREATE INDEX "ActivityLog_actionType_idx" ON "ActivityLog"("actionType");

-- CreateIndex
CREATE INDEX "HcNotificationPrefs_companyId_idx" ON "HcNotificationPrefs"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "HcNotificationPrefs_companyId_headControllerId_key" ON "HcNotificationPrefs"("companyId", "headControllerId");

-- CreateIndex
CREATE INDEX "SyncOperation_companyId_status_idx" ON "SyncOperation"("companyId", "status");

-- CreateIndex
CREATE INDEX "SyncOperation_companyId_entityType_entityId_idx" ON "SyncOperation"("companyId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_companyId_occurredAt_idx" ON "AuditLog"("companyId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformAdmin" ADD CONSTRAINT "PlatformAdmin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Doctor" ADD CONSTRAINT "Doctor_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoctorClinicLocation" ADD CONSTRAINT "DoctorClinicLocation_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoctorClinicLocation" ADD CONSTRAINT "DoctorClinicLocation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Territory" ADD CONSTRAINT "Territory_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MrTerritoryAssignment" ADD CONSTRAINT "MrTerritoryAssignment_territoryId_fkey" FOREIGN KEY ("territoryId") REFERENCES "Territory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MrTerritoryAssignment" ADD CONSTRAINT "MrTerritoryAssignment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TerritoryDoctor" ADD CONSTRAINT "TerritoryDoctor_territoryId_fkey" FOREIGN KEY ("territoryId") REFERENCES "Territory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TerritoryDoctor" ADD CONSTRAINT "TerritoryDoctor_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TerritoryDoctor" ADD CONSTRAINT "TerritoryDoctor_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkDay" ADD CONSTRAINT "WorkDay_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkDay" ADD CONSTRAINT "WorkDay_mrId_fkey" FOREIGN KEY ("mrId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_mrId_fkey" FOREIGN KEY ("mrId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_workDayId_fkey" FOREIGN KEY ("workDayId") REFERENCES "WorkDay"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_correctsVisitId_fkey" FOREIGN KEY ("correctsVisitId") REFERENCES "Visit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitNote" ADD CONSTRAINT "VisitNote_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitNote" ADD CONSTRAINT "VisitNote_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

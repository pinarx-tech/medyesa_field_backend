-- CreateEnum
CREATE TYPE "DataClassification" AS ENUM ('production', 'demo', 'seed', 'test', 'historicalImported');

-- AlterTable
ALTER TABLE "ActivityLog" ADD COLUMN     "dataClassification" "DataClassification" NOT NULL DEFAULT 'production';

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "dataClassification" "DataClassification" NOT NULL DEFAULT 'production';

-- AlterTable
ALTER TABLE "Doctor" ADD COLUMN     "clinicId" TEXT,
ADD COLUMN     "dataClassification" "DataClassification" NOT NULL DEFAULT 'production';

-- AlterTable
ALTER TABLE "Territory" ADD COLUMN     "dataClassification" "DataClassification" NOT NULL DEFAULT 'production';

-- AlterTable
ALTER TABLE "Visit" ADD COLUMN     "dataClassification" "DataClassification" NOT NULL DEFAULT 'production';

-- AlterTable
ALTER TABLE "WorkDay" ADD COLUMN     "dataClassification" "DataClassification" NOT NULL DEFAULT 'production',
ADD COLUMN     "previousEndedAt" TIMESTAMP(3),
ADD COLUMN     "reopenReason" TEXT,
ADD COLUMN     "reopenedAt" TIMESTAMP(3),
ADD COLUMN     "reopenedByUserId" TEXT;

-- CreateTable
CREATE TABLE "Clinic" (
    "id" TEXT NOT NULL,
    "companyId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "formattedAddress" TEXT NOT NULL,
    "landmark" TEXT,
    "phone" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "accuracyMeters" DOUBLE PRECISION,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "dataClassification" "DataClassification" NOT NULL DEFAULT 'production',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Clinic_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Clinic_companyId_idx" ON "Clinic"("companyId");

-- CreateIndex
CREATE INDEX "Clinic_companyId_normalizedName_idx" ON "Clinic"("companyId", "normalizedName");

-- CreateIndex
CREATE INDEX "Doctor_clinicId_idx" ON "Doctor"("clinicId");

-- AddForeignKey
ALTER TABLE "Clinic" ADD CONSTRAINT "Clinic_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Doctor" ADD CONSTRAINT "Doctor_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE SET NULL ON UPDATE CASCADE;

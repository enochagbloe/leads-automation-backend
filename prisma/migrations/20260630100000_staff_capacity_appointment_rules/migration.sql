CREATE TYPE "ServiceCapacityMode" AS ENUM ('STAFF_BASED', 'BUSINESS_WIDE', 'UNLIMITED');

ALTER TABLE "Service"
  ADD COLUMN "allowedLocationTypes" "AppointmentLocationType"[] NOT NULL DEFAULT ARRAY[]::"AppointmentLocationType"[],
  ADD COLUMN "defaultLocationType" "AppointmentLocationType",
  ADD COLUMN "requiresStaffAssignmentBeforeConfirmation" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "requiresManagerApproval" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "capacityMode" "ServiceCapacityMode" NOT NULL DEFAULT 'STAFF_BASED',
  ADD COLUMN "requiredStaffRole" TEXT,
  ADD COLUMN "requiredSkillTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "allowAiToChooseLocationType" BOOLEAN NOT NULL DEFAULT false;

ALTER TYPE "AuditAction" ADD VALUE 'BUSINESS_PROFILE_UPDATED';

ALTER TABLE "Business"
  ALTER COLUMN "email" DROP NOT NULL,
  ADD COLUMN "website" TEXT,
  ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'Africa/Accra',
  ADD COLUMN "defaultCurrency" TEXT NOT NULL DEFAULT 'GHS',
  ADD COLUMN "defaultNotificationEmail" TEXT,
  DROP COLUMN "handoffEmail",
  DROP COLUMN "handoffPhone";

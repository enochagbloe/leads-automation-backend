ALTER TYPE "AuditAction" ADD VALUE 'BUSINESS_POLICY_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'BUSINESS_POLICY_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'BUSINESS_POLICY_ARCHIVED';
ALTER TYPE "AuditAction" ADD VALUE 'BUSINESS_POLICY_RESTORED';
ALTER TYPE "AuditAction" ADD VALUE 'BUSINESS_POLICY_REORDERED';

CREATE TYPE "BusinessPolicyCategory" AS ENUM (
  'GENERAL', 'PAYMENT', 'DEPOSIT', 'REFUND', 'CANCELLATION', 'RESCHEDULING',
  'LATE_ARRIVAL', 'NO_SHOW', 'TRANSPORTATION', 'SERVICE_AREA', 'APPOINTMENT',
  'PRIVACY', 'TERMS', 'OTHER'
);
CREATE TYPE "BusinessPolicyVisibility" AS ENUM ('INTERNAL_ONLY', 'CUSTOMER_FACING');
CREATE TYPE "BusinessPolicySource" AS ENUM ('MANUAL', 'IMPORTED', 'AI_SUGGESTED', 'AI_APPROVED');

ALTER TABLE "BusinessPolicy"
  ADD COLUMN "category" "BusinessPolicyCategory" NOT NULL DEFAULT 'GENERAL',
  ADD COLUMN "shortSummary" TEXT,
  ADD COLUMN "visibility" "BusinessPolicyVisibility" NOT NULL DEFAULT 'CUSTOMER_FACING',
  ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "displayOrder" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "source" "BusinessPolicySource" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "createdById" TEXT,
  ADD COLUMN "updatedById" TEXT,
  ADD COLUMN "archivedAt" TIMESTAMP(3);

UPDATE "BusinessPolicy"
SET "isArchived" = true, "isActive" = false, "archivedAt" = "deletedAt"
WHERE "deletedAt" IS NOT NULL;

UPDATE "BusinessPolicy"
SET
  "title" = CASE
    WHEN char_length(btrim("title")) < 2 THEN 'Legacy Policy'
    ELSE left(btrim("title"), 120)
  END,
  "content" = CASE
    WHEN char_length(btrim("content")) < 10 THEN left(concat(coalesce(nullif(btrim("content"), ''), 'Legacy policy'), ' [legacy]'), 3000)
    ELSE left(btrim("content"), 3000)
  END;

ALTER TABLE "BusinessPolicy" DROP COLUMN "deletedAt";

CREATE INDEX "BusinessPolicy_businessId_idx" ON "BusinessPolicy"("businessId");
CREATE INDEX "BusinessPolicy_businessId_isArchived_idx" ON "BusinessPolicy"("businessId", "isArchived");
CREATE INDEX "BusinessPolicy_businessId_category_idx" ON "BusinessPolicy"("businessId", "category");
CREATE INDEX "BusinessPolicy_businessId_visibility_idx" ON "BusinessPolicy"("businessId", "visibility");
CREATE INDEX "BusinessPolicy_businessId_displayOrder_idx" ON "BusinessPolicy"("businessId", "displayOrder");

ALTER TABLE "BusinessPolicy"
  ADD CONSTRAINT "BusinessPolicy_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "BusinessPolicy_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "BusinessPolicy_title_length_check" CHECK (char_length(btrim("title")) BETWEEN 2 AND 120),
  ADD CONSTRAINT "BusinessPolicy_content_length_check" CHECK (char_length(btrim("content")) BETWEEN 10 AND 3000),
  ADD CONSTRAINT "BusinessPolicy_summary_length_check" CHECK ("shortSummary" IS NULL OR char_length("shortSummary") <= 300),
  ADD CONSTRAINT "BusinessPolicy_priority_nonnegative_check" CHECK ("priority" >= 0),
  ADD CONSTRAINT "BusinessPolicy_displayOrder_nonnegative_check" CHECK ("displayOrder" >= 0),
  ADD CONSTRAINT "BusinessPolicy_archived_inactive_check" CHECK ("isArchived" = false OR "isActive" = false);

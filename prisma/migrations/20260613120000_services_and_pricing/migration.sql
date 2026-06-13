CREATE TYPE "ServicePriceType" AS ENUM ('FIXED', 'STARTING_FROM', 'RANGE', 'QUOTE_ONLY', 'FREE', 'NOT_SET');
CREATE TYPE "ServiceReadinessStatus" AS ENUM ('DRAFT', 'INCOMPLETE', 'READY_FOR_AI', 'READY_FOR_BOOKING', 'ARCHIVED');
CREATE TYPE "ServiceSource" AS ENUM ('MANUAL', 'IMPORTED', 'AI_SUGGESTED', 'AI_APPROVED');

ALTER TYPE "AuditAction" ADD VALUE 'BUSINESS_SERVICE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'BUSINESS_SERVICE_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'BUSINESS_SERVICE_ARCHIVED';
ALTER TYPE "AuditAction" ADD VALUE 'BUSINESS_SERVICE_RESTORED';
ALTER TYPE "AuditAction" ADD VALUE 'BUSINESS_SERVICE_REORDERED';

ALTER TABLE "Service" RENAME COLUMN "price" TO "basePrice";
ALTER TABLE "Service" RENAME COLUMN "pricingNote" TO "priceDescription";
ALTER TABLE "Service" RENAME COLUMN "deletedAt" TO "archivedAt";

ALTER TABLE "Service"
  ADD COLUMN "slug" TEXT,
  ADD COLUMN "category" TEXT,
  ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'GHS',
  ADD COLUMN "priceType" "ServicePriceType" NOT NULL DEFAULT 'NOT_SET',
  ADD COLUMN "durationMinutes" INTEGER,
  ADD COLUMN "bufferMinutes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "requiresPayment" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "paymentRequiredBeforeBooking" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "isBookable" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "readinessStatus" "ServiceReadinessStatus" NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN "missingFields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "displayOrder" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "source" "ServiceSource" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "createdById" TEXT,
  ADD COLUMN "updatedById" TEXT;

UPDATE "Service" service
SET
  "slug" = LOWER(REGEXP_REPLACE(TRIM(service."name"), '[^a-zA-Z0-9]+', '-', 'g')) || '-' || SUBSTRING(md5(service."id"), 1, 8),
  "currency" = business."defaultCurrency",
  "isArchived" = service."archivedAt" IS NOT NULL,
  "isActive" = CASE WHEN service."archivedAt" IS NOT NULL THEN false ELSE service."isActive" END,
  "priceType" = CASE
    WHEN service."basePrice" IS NOT NULL THEN 'FIXED'::"ServicePriceType"
    WHEN NULLIF(BTRIM(service."priceDescription"), '') IS NOT NULL THEN 'QUOTE_ONLY'::"ServicePriceType"
    ELSE 'NOT_SET'::"ServicePriceType"
  END,
  "readinessStatus" = CASE WHEN service."archivedAt" IS NOT NULL THEN 'ARCHIVED'::"ServiceReadinessStatus" ELSE 'DRAFT'::"ServiceReadinessStatus" END,
  "missingFields" = ARRAY['description', 'durationMinutes']::TEXT[]
    || CASE
      WHEN service."basePrice" IS NOT NULL OR NULLIF(BTRIM(service."priceDescription"), '') IS NOT NULL THEN ARRAY[]::TEXT[]
      ELSE ARRAY['price']::TEXT[]
    END
FROM "Business" business
WHERE business."id" = service."businessId";

ALTER TABLE "Service" ALTER COLUMN "slug" SET NOT NULL;
ALTER TABLE "Service" ADD CONSTRAINT "Service_basePrice_nonnegative" CHECK ("basePrice" IS NULL OR "basePrice" >= 0);
ALTER TABLE "Service" ADD CONSTRAINT "Service_duration_positive" CHECK ("durationMinutes" IS NULL OR "durationMinutes" > 0);
ALTER TABLE "Service" ADD CONSTRAINT "Service_buffer_nonnegative" CHECK ("bufferMinutes" >= 0);
ALTER TABLE "Service" ADD CONSTRAINT "Service_payment_requirement_valid" CHECK (NOT "paymentRequiredBeforeBooking" OR "requiresPayment");

-- Legacy service names were not unique. Preserve the oldest non-archived record and
-- archive later case-insensitive duplicates before adding the unique index.
WITH ranked_duplicates AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "businessId", LOWER("name")
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS duplicate_rank
  FROM "Service"
  WHERE "isArchived" = false
)
UPDATE "Service" service
SET
  "isArchived" = true,
  "isActive" = false,
  "readinessStatus" = 'ARCHIVED'::"ServiceReadinessStatus",
  "missingFields" = ARRAY[]::TEXT[],
  "archivedAt" = COALESCE(service."archivedAt", NOW())
FROM ranked_duplicates duplicate
WHERE service."id" = duplicate."id"
  AND duplicate.duplicate_rank > 1;

DROP INDEX IF EXISTS "Service_businessId_deletedAt_idx";
CREATE INDEX "Service_businessId_idx" ON "Service"("businessId");
CREATE INDEX "Service_businessId_isArchived_idx" ON "Service"("businessId", "isArchived");
CREATE INDEX "Service_businessId_readinessStatus_idx" ON "Service"("businessId", "readinessStatus");
CREATE INDEX "Service_businessId_name_idx" ON "Service"("businessId", "name");
CREATE INDEX "Service_businessId_slug_idx" ON "Service"("businessId", "slug");
CREATE UNIQUE INDEX "Service_businessId_name_active_key"
  ON "Service"("businessId", LOWER("name"))
  WHERE "isArchived" = false;

ALTER TABLE "Service" ADD CONSTRAINT "Service_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Service" ADD CONSTRAINT "Service_updatedById_fkey"
  FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

UPDATE "Plan" SET "maxServices" = 100 WHERE "code" = 'PREMIUM';

UPDATE "AccountUsageRecord" usage
SET "servicesCount" = (
  SELECT COUNT(*)
  FROM "Service" service
  JOIN "Business" business ON business."id" = service."businessId"
  WHERE business."businessAccountId" = usage."businessAccountId"
    AND business."deletedAt" IS NULL
    AND service."isActive" = true
    AND service."isArchived" = false
);

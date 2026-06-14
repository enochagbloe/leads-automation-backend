ALTER TYPE "AuditAction" ADD VALUE 'BUSINESS_AVAILABILITY_UPDATED';

CREATE TYPE "DayOfWeek" AS ENUM (
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY'
);

ALTER TABLE "BusinessAvailability"
  ADD COLUMN "dayOfWeekNew" "DayOfWeek",
  ADD COLUMN "isOpen" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "breakStartTime" TEXT,
  ADD COLUMN "breakEndTime" TEXT,
  ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'Africa/Accra',
  ADD COLUMN "appliesToAllServices" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "createdById" TEXT,
  ADD COLUMN "updatedById" TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "BusinessAvailability"
    WHERE "dayOfWeek" NOT BETWEEN 0 AND 6
  ) THEN
    RAISE EXCEPTION 'BusinessAvailability contains an unsupported legacy dayOfWeek value';
  END IF;
END $$;

UPDATE "BusinessAvailability" availability
SET
  "dayOfWeekNew" = CASE availability."dayOfWeek"
    WHEN 0 THEN 'SUNDAY'::"DayOfWeek"
    WHEN 1 THEN 'MONDAY'::"DayOfWeek"
    WHEN 2 THEN 'TUESDAY'::"DayOfWeek"
    WHEN 3 THEN 'WEDNESDAY'::"DayOfWeek"
    WHEN 4 THEN 'THURSDAY'::"DayOfWeek"
    WHEN 5 THEN 'FRIDAY'::"DayOfWeek"
    WHEN 6 THEN 'SATURDAY'::"DayOfWeek"
  END,
  "isOpen" = true,
  "timezone" = business."timezone"
FROM "Business" business
WHERE business."id" = availability."businessId";

DROP INDEX "BusinessAvailability_businessId_dayOfWeek_key";

ALTER TABLE "BusinessAvailability"
  DROP COLUMN "dayOfWeek";

ALTER TABLE "BusinessAvailability"
  RENAME COLUMN "dayOfWeekNew" TO "dayOfWeek";

ALTER TABLE "BusinessAvailability"
  ALTER COLUMN "dayOfWeek" SET NOT NULL,
  ALTER COLUMN "openTime" DROP NOT NULL,
  ALTER COLUMN "closeTime" DROP NOT NULL;

CREATE UNIQUE INDEX "BusinessAvailability_businessId_dayOfWeek_key"
  ON "BusinessAvailability"("businessId", "dayOfWeek");
CREATE INDEX "BusinessAvailability_businessId_idx"
  ON "BusinessAvailability"("businessId");

ALTER TABLE "BusinessAvailability"
  ADD CONSTRAINT "BusinessAvailability_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "BusinessAvailability_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "BusinessAvailability_valid_times_check" CHECK (
    (
      "isOpen" = false
      AND "openTime" IS NULL
      AND "closeTime" IS NULL
      AND "breakStartTime" IS NULL
      AND "breakEndTime" IS NULL
    )
    OR
    (
      "isOpen" = true
      AND "openTime" ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
      AND "closeTime" ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
      AND "openTime" < "closeTime"
      AND (
        ("breakStartTime" IS NULL AND "breakEndTime" IS NULL)
        OR (
          "breakStartTime" ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
          AND "breakEndTime" ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
          AND "openTime" < "breakStartTime"
          AND "breakStartTime" < "breakEndTime"
          AND "breakEndTime" < "closeTime"
        )
      )
    )
  );

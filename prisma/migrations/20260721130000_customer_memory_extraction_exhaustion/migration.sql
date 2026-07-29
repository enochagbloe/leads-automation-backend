ALTER TYPE "CustomerMemoryExtractionStatus" ADD VALUE IF NOT EXISTS 'EXHAUSTED';
ALTER TYPE "BusinessNotificationType" ADD VALUE IF NOT EXISTS 'CUSTOMER_MEMORY_EXTRACTION_EXHAUSTED';

ALTER TABLE "CustomerMemoryExtractionJob"
  ALTER COLUMN "nextAttemptAt" DROP NOT NULL,
  ADD COLUMN "finalErrorCode" TEXT,
  ADD COLUMN "exhaustedAt" TIMESTAMP(3);

CREATE INDEX "CustomerMemoryExtractionJob_status_exhaustedAt_idx"
  ON "CustomerMemoryExtractionJob"("status", "exhaustedAt");

ALTER TABLE "AccountUsageRecord"
  ADD COLUMN "aiMemoryExtractionRequestsUsed" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "aiMemoryExtractionTokensUsed" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "CustomerMemoryExtractionJob"
  ADD COLUMN "processingBatchId" TEXT;

CREATE INDEX "CustomerMemoryExtractionJob_processingBatchId_status_idx"
  ON "CustomerMemoryExtractionJob"("processingBatchId", "status");

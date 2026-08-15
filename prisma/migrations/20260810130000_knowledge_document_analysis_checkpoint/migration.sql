ALTER TABLE "KnowledgeDocumentAnalysis"
  ADD COLUMN "providerResultSnapshot" JSONB,
  ADD COLUMN "providerResultContentHash" TEXT,
  ADD COLUMN "providerUsageReservationKey" TEXT,
  ADD COLUMN "providerCheckpointedAt" TIMESTAMP(3);

CREATE INDEX "KnowledgeDocumentAnalysis_providerCheckpointedAt_idx"
  ON "KnowledgeDocumentAnalysis"("providerCheckpointedAt");

ALTER TABLE "KnowledgeGovernanceResolutionOperation"
  ADD COLUMN "requestInput" JSONB,
  ADD COLUMN "processingStartedAt" TIMESTAMP(3),
  ADD COLUMN "leaseOwner" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "KnowledgeGovernanceResolutionOperation_status_leaseExpiresAt_idx"
  ON "KnowledgeGovernanceResolutionOperation"("status", "leaseExpiresAt");

ALTER TABLE "Service"
  ADD COLUMN "governanceCreationOperationId" TEXT;

CREATE UNIQUE INDEX "Service_governanceCreationOperationId_key"
  ON "Service"("governanceCreationOperationId");

ALTER TABLE "Service"
  ADD CONSTRAINT "Service_governanceCreationOperationId_fkey"
  FOREIGN KEY ("governanceCreationOperationId")
  REFERENCES "KnowledgeGovernanceResolutionOperation"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TYPE "KnowledgeRuntimeRefreshJobStatus" AS ENUM (
  'SCHEDULED',
  'PROCESSING',
  'FAILED',
  'COMPLETED',
  'EXHAUSTED'
);

CREATE TABLE "KnowledgeRuntimeRefreshJob" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "status" "KnowledgeRuntimeRefreshJobStatus" NOT NULL DEFAULT 'SCHEDULED',
  "requestedRevision" INTEGER NOT NULL DEFAULT 1,
  "processingRevision" INTEGER,
  "completedRevision" INTEGER NOT NULL DEFAULT 0,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  "processingStartedAt" TIMESTAMP(3),
  "cacheInvalidatedAt" TIMESTAMP(3),
  "embeddingsSyncedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "lastErrorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "KnowledgeRuntimeRefreshJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "KnowledgeRuntimeRefreshJob_documentId_key"
  ON "KnowledgeRuntimeRefreshJob"("documentId");
CREATE UNIQUE INDEX "KnowledgeRuntimeRefreshJob_documentId_businessId_key"
  ON "KnowledgeRuntimeRefreshJob"("documentId", "businessId");
CREATE INDEX "KnowledgeRuntimeRefreshJob_status_nextAttemptAt_idx"
  ON "KnowledgeRuntimeRefreshJob"("status", "nextAttemptAt");
CREATE INDEX "KnowledgeRuntimeRefreshJob_businessId_status_idx"
  ON "KnowledgeRuntimeRefreshJob"("businessId", "status");

ALTER TABLE "KnowledgeRuntimeRefreshJob"
  ADD CONSTRAINT "KnowledgeRuntimeRefreshJob_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "KnowledgeRuntimeRefreshJob"
  ADD CONSTRAINT "KnowledgeRuntimeRefreshJob_documentId_businessId_fkey"
  FOREIGN KEY ("documentId", "businessId") REFERENCES "KnowledgeDocument"("id", "businessId")
  ON DELETE CASCADE ON UPDATE CASCADE;

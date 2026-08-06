CREATE TYPE "KnowledgeStorageMigrationJobStatus" AS ENUM (
  'SCHEDULED',
  'PROCESSING',
  'SOURCE_CLEANUP_PENDING',
  'FAILED',
  'COMPLETED',
  'EXHAUSTED'
);

ALTER TABLE "KnowledgeArticle"
  ADD COLUMN "pdfStorageProvider" "KnowledgeStorageProvider",
  ADD COLUMN "pdfStorageObjectKey" TEXT;

UPDATE "KnowledgeArticle"
SET "pdfStorageObjectKey" = "pdfFileKey"
WHERE "pdfFileKey" IS NOT NULL;

ALTER TABLE "ConversationMessageAttachment"
  ADD COLUMN "storageProvider" "KnowledgeStorageProvider",
  ADD COLUMN "storageObjectKey" TEXT;

UPDATE "ConversationMessageAttachment"
SET "storageObjectKey" = "fileKey"
WHERE "fileKey" IS NOT NULL;

CREATE TABLE "KnowledgeStorageMigrationJob" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "sourceProvider" "KnowledgeStorageProvider" NOT NULL,
  "sourceObjectKey" TEXT NOT NULL,
  "targetProvider" "KnowledgeStorageProvider" NOT NULL,
  "targetObjectKey" TEXT NOT NULL,
  "status" "KnowledgeStorageMigrationJobStatus" NOT NULL DEFAULT 'SCHEDULED',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3),
  "processingStartedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnowledgeStorageMigrationJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "KnowledgeStorageMigrationJob_source_target_key"
ON "KnowledgeStorageMigrationJob"("businessId", "sourceProvider", "sourceObjectKey", "targetProvider");

CREATE INDEX "KnowledgeStorageMigrationJob_status_next_created_idx"
ON "KnowledgeStorageMigrationJob"("status", "nextAttemptAt", "createdAt");

CREATE INDEX "KnowledgeStorageMigrationJob_business_status_idx"
ON "KnowledgeStorageMigrationJob"("businessId", "status");

CREATE INDEX "KnowledgeArticle_businessId_pdfStorageProvider_idx"
ON "KnowledgeArticle"("businessId", "pdfStorageProvider");

CREATE INDEX "ConversationMessageAttachment_businessId_storageProvider_idx"
ON "ConversationMessageAttachment"("businessId", "storageProvider");

ALTER TABLE "KnowledgeStorageMigrationJob"
ADD CONSTRAINT "KnowledgeStorageMigrationJob_businessId_fkey"
FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

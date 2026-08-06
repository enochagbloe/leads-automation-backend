ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_DOCUMENT_STORAGE_DELETION_COMPLETED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_DOCUMENT_STORAGE_DELETION_FAILED';

CREATE TYPE "KnowledgeDocumentRetentionStatus" AS ENUM (
  'RETAINED',
  'PENDING_DELETION',
  'DELETION_IN_PROGRESS',
  'DELETION_FAILED',
  'PURGED'
);

CREATE TYPE "KnowledgeDocumentStorageDeletionJobStatus" AS ENUM (
  'SCHEDULED',
  'PROCESSING',
  'FAILED',
  'COMPLETED',
  'EXHAUSTED'
);

ALTER TABLE "KnowledgeDocument"
  ADD COLUMN "retentionStatus" "KnowledgeDocumentRetentionStatus" NOT NULL DEFAULT 'RETAINED',
  ADD COLUMN "retentionExpiresAt" TIMESTAMP(3),
  ADD COLUMN "storageDeletedAt" TIMESTAMP(3);

ALTER TABLE "KnowledgeDocumentVersion"
  ADD COLUMN "storageDeletedAt" TIMESTAMP(3);

CREATE TABLE "KnowledgeDocumentStorageDeletionJob" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "versionId" TEXT NOT NULL,
  "storageProvider" "KnowledgeStorageProvider" NOT NULL,
  "storageObjectKey" TEXT NOT NULL,
  "status" "KnowledgeDocumentStorageDeletionJobStatus" NOT NULL DEFAULT 'SCHEDULED',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "scheduledFor" TIMESTAMP(3) NOT NULL,
  "nextAttemptAt" TIMESTAMP(3),
  "processingStartedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "lastErrorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnowledgeDocumentStorageDeletionJob_pkey" PRIMARY KEY ("id")
);

UPDATE "KnowledgeDocument"
SET
  "retentionStatus" = 'PENDING_DELETION',
  "retentionExpiresAt" = COALESCE("deletedAt", CURRENT_TIMESTAMP) + INTERVAL '30 days'
WHERE "status" = 'DELETED';

INSERT INTO "KnowledgeDocumentStorageDeletionJob" (
  "id", "businessId", "documentId", "versionId", "storageProvider",
  "storageObjectKey", "scheduledFor", "nextAttemptAt"
)
SELECT
  'knowledge_storage_delete_' || md5(version."id"),
  version."businessId",
  version."documentId",
  version."id",
  version."storageProvider",
  version."storageObjectKey",
  document."retentionExpiresAt",
  document."retentionExpiresAt"
FROM "KnowledgeDocumentVersion" version
JOIN "KnowledgeDocument" document ON document."id" = version."documentId"
WHERE document."status" = 'DELETED'
  AND version."storageObjectKey" IS NOT NULL;

UPDATE "KnowledgeDocument" document
SET
  "retentionStatus" = 'PURGED',
  "storageDeletedAt" = CURRENT_TIMESTAMP,
  "activeVersionId" = NULL,
  "fileKey" = NULL,
  "storageObjectKey" = NULL
WHERE document."status" = 'DELETED'
  AND NOT EXISTS (
    SELECT 1
    FROM "KnowledgeDocumentVersion" version
    WHERE version."documentId" = document."id"
      AND version."storageObjectKey" IS NOT NULL
  );

CREATE UNIQUE INDEX "KnowledgeDocumentStorageDeletionJob_versionId_key"
  ON "KnowledgeDocumentStorageDeletionJob"("versionId");
CREATE UNIQUE INDEX "KDStorageDeleteJob_version_document_business_key"
  ON "KnowledgeDocumentStorageDeletionJob"("versionId", "documentId", "businessId");
CREATE INDEX "KnowledgeDocumentStorageDeletionJob_status_next_scheduled_idx"
  ON "KnowledgeDocumentStorageDeletionJob"("status", "nextAttemptAt", "scheduledFor");
CREATE INDEX "KnowledgeDocumentStorageDeletionJob_business_document_idx"
  ON "KnowledgeDocumentStorageDeletionJob"("businessId", "documentId");
CREATE INDEX "KnowledgeDocument_business_retention_expiry_idx"
  ON "KnowledgeDocument"("businessId", "retentionStatus", "retentionExpiresAt");

ALTER TABLE "KnowledgeDocumentStorageDeletionJob"
  ADD CONSTRAINT "KnowledgeDocumentStorageDeletionJob_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "KnowledgeDocumentStorageDeletionJob"
  ADD CONSTRAINT "KnowledgeDocumentStorageDeletionJob_document_business_fkey"
  FOREIGN KEY ("documentId", "businessId")
  REFERENCES "KnowledgeDocument"("id", "businessId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "KnowledgeDocumentStorageDeletionJob"
  ADD CONSTRAINT "KDStorageDeleteJob_version_document_business_fkey"
  FOREIGN KEY ("versionId", "documentId", "businessId")
  REFERENCES "KnowledgeDocumentVersion"("id", "documentId", "businessId") ON DELETE CASCADE ON UPDATE CASCADE;

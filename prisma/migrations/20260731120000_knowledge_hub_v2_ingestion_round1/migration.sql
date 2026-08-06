ALTER TYPE "KnowledgeDocumentStatus" ADD VALUE IF NOT EXISTS 'DELETED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_DOCUMENT_UPLOAD_STARTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_DOCUMENT_UPLOAD_COMPLETED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_DOCUMENT_UPLOAD_FAILED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_DOCUMENT_PROCESSING_QUEUED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_DOCUMENT_RESTORED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_DOCUMENT_DELETED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_DOCUMENT_PROCESSING_RETRY_REQUESTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_DOCUMENT_DOWNLOADED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_DOCUMENT_DUPLICATE_DETECTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_DOCUMENT_SCOPE_VIOLATION';

CREATE TYPE "KnowledgeDocumentProcessingStatus" AS ENUM (
  'UPLOADING', 'QUEUED', 'PROCESSING', 'READY', 'NEEDS_REVIEW', 'FAILED'
);
CREATE TYPE "KnowledgeStorageProvider" AS ENUM ('LOCAL_PRIVATE', 'S3_COMPATIBLE');
CREATE TYPE "KnowledgeDocumentProcessingJobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED');

ALTER TABLE "KnowledgeDocument"
  ADD COLUMN "originalFileName" TEXT,
  ADD COLUMN "safeFileName" TEXT,
  ADD COLUMN "fileExtension" TEXT,
  ADD COLUMN "storageProvider" "KnowledgeStorageProvider" NOT NULL DEFAULT 'LOCAL_PRIVATE',
  ADD COLUMN "storageObjectKey" TEXT,
  ADD COLUMN "checksum" TEXT,
  ADD COLUMN "processingStatus" "KnowledgeDocumentProcessingStatus" NOT NULL DEFAULT 'READY',
  ADD COLUMN "processingErrorCode" TEXT,
  ADD COLUMN "processingErrorMessage" TEXT,
  ADD COLUMN "activeVersionId" TEXT,
  ADD COLUMN "uploadedByUserId" TEXT,
  ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "deletedAt" TIMESTAMP(3);

UPDATE "KnowledgeDocument" d
SET
  "originalFileName" = d."fileName",
  "safeFileName" = d."fileName",
  "fileExtension" = lower(regexp_replace(d."fileName", '^.*\.', '')),
  "storageObjectKey" = d."fileKey",
  "checksum" = 'legacy:' || d."id",
  "uploadedByUserId" = m."userId"
FROM "BusinessMember" m
WHERE d."uploadedByMembershipId" = m."id";

UPDATE "KnowledgeDocument"
SET
  "originalFileName" = COALESCE("originalFileName", "fileName"),
  "safeFileName" = COALESCE("safeFileName", "fileName"),
  "fileExtension" = COALESCE("fileExtension", 'pdf'),
  "storageObjectKey" = COALESCE("storageObjectKey", "fileKey"),
  "checksum" = COALESCE("checksum", 'legacy:' || "id");

ALTER TABLE "KnowledgeDocument"
  ALTER COLUMN "originalFileName" SET NOT NULL,
  ALTER COLUMN "safeFileName" SET NOT NULL,
  ALTER COLUMN "fileExtension" SET NOT NULL,
  ALTER COLUMN "checksum" SET NOT NULL;

CREATE TABLE "KnowledgeDocumentVersion" (
  "id" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "versionNumber" INTEGER NOT NULL,
  "originalFileName" TEXT NOT NULL,
  "safeFileName" TEXT NOT NULL,
  "fileExtension" TEXT NOT NULL,
  "storageProvider" "KnowledgeStorageProvider" NOT NULL,
  "storageObjectKey" TEXT,
  "fileSize" INTEGER NOT NULL,
  "mimeType" TEXT NOT NULL,
  "checksum" TEXT NOT NULL,
  "uploadedByUserId" TEXT,
  "uploadedByMembershipId" TEXT,
  "processingStatus" "KnowledgeDocumentProcessingStatus" NOT NULL DEFAULT 'UPLOADING',
  "processingErrorCode" TEXT,
  "processingErrorMessage" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT false,
  "uploadIdempotencyKey" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnowledgeDocumentVersion_pkey" PRIMARY KEY ("id")
);

INSERT INTO "KnowledgeDocumentVersion" (
  "id", "documentId", "businessId", "versionNumber", "originalFileName",
  "safeFileName", "fileExtension", "storageProvider", "storageObjectKey",
  "fileSize", "mimeType", "checksum", "uploadedByUserId",
  "uploadedByMembershipId", "processingStatus", "isActive", "createdAt", "updatedAt"
)
SELECT
  d."id" || '_v1', d."id", d."businessId", 1, d."originalFileName",
  d."safeFileName", d."fileExtension", d."storageProvider", d."storageObjectKey",
  d."fileSize", d."mimeType", d."checksum", d."uploadedByUserId",
  d."uploadedByMembershipId", 'READY', true, d."createdAt", d."updatedAt"
FROM "KnowledgeDocument" d;

UPDATE "KnowledgeDocument" SET "activeVersionId" = "id" || '_v1';

CREATE TABLE "KnowledgeDocumentProcessingJob" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "versionId" TEXT NOT NULL,
  "status" "KnowledgeDocumentProcessingJobStatus" NOT NULL DEFAULT 'QUEUED',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3),
  "processingStartedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnowledgeDocumentProcessingJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "KnowledgeDocumentVersion_documentId_versionNumber_key" ON "KnowledgeDocumentVersion"("documentId", "versionNumber");
CREATE UNIQUE INDEX "KnowledgeDocumentVersion_businessId_uploadIdempotencyKey_key" ON "KnowledgeDocumentVersion"("businessId", "uploadIdempotencyKey");
CREATE INDEX "KnowledgeDocumentVersion_businessId_checksum_idx" ON "KnowledgeDocumentVersion"("businessId", "checksum");
CREATE INDEX "KnowledgeDocumentVersion_businessId_processingStatus_idx" ON "KnowledgeDocumentVersion"("businessId", "processingStatus");
CREATE UNIQUE INDEX "KnowledgeDocumentProcessingJob_versionId_key" ON "KnowledgeDocumentProcessingJob"("versionId");
CREATE INDEX "KnowledgeDocumentProcessingJob_businessId_status_nextAttemptAt_idx" ON "KnowledgeDocumentProcessingJob"("businessId", "status", "nextAttemptAt");
CREATE INDEX "KnowledgeDocumentProcessingJob_businessId_documentId_idx" ON "KnowledgeDocumentProcessingJob"("businessId", "documentId");
CREATE INDEX "KnowledgeDocument_businessId_processingStatus_idx" ON "KnowledgeDocument"("businessId", "processingStatus");
CREATE INDEX "KnowledgeDocument_businessId_checksum_idx" ON "KnowledgeDocument"("businessId", "checksum");
CREATE INDEX "KnowledgeDocument_businessId_deletedAt_idx" ON "KnowledgeDocument"("businessId", "deletedAt");

ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "KnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_activeVersionId_fkey" FOREIGN KEY ("activeVersionId") REFERENCES "KnowledgeDocumentVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "KnowledgeDocumentProcessingJob" ADD CONSTRAINT "KnowledgeDocumentProcessingJob_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeDocumentProcessingJob" ADD CONSTRAINT "KnowledgeDocumentProcessingJob_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "KnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeDocumentProcessingJob" ADD CONSTRAINT "KnowledgeDocumentProcessingJob_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "KnowledgeDocumentVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

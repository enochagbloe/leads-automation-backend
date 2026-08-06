CREATE TYPE "KnowledgeDocumentUploadOperationStatus" AS ENUM (
  'UPLOADING',
  'COMPLETED',
  'FAILED'
);

CREATE TABLE "KnowledgeDocumentUploadOperation" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestChecksum" TEXT NOT NULL,
  "status" "KnowledgeDocumentUploadOperationStatus" NOT NULL DEFAULT 'UPLOADING',
  "documentId" TEXT,
  "versionId" TEXT,
  "duplicateDocumentId" TEXT,
  "resultSnapshot" JSONB,
  "failureStatusCode" INTEGER,
  "failureCode" TEXT,
  "failureMessage" TEXT,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnowledgeDocumentUploadOperation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "KnowledgeDocumentUploadOperation_businessId_idempotencyKey_key"
  ON "KnowledgeDocumentUploadOperation"("businessId", "idempotencyKey");
CREATE INDEX "KnowledgeDocumentUploadOperation_businessId_status_updatedAt_idx"
  ON "KnowledgeDocumentUploadOperation"("businessId", "status", "updatedAt");
CREATE INDEX "KnowledgeDocumentUploadOperation_businessId_versionId_idx"
  ON "KnowledgeDocumentUploadOperation"("businessId", "versionId");

ALTER TABLE "KnowledgeDocumentUploadOperation"
  ADD CONSTRAINT "KnowledgeDocumentUploadOperation_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

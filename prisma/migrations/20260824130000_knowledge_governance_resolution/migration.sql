CREATE TYPE "KnowledgeGovernanceResolutionOperationStatus" AS ENUM ('APPLYING', 'COMPLETED', 'FAILED');
CREATE TYPE "KnowledgeDocumentArchiveReason" AS ENUM ('USER_ARCHIVED', 'REVIEW_NOT_APPLIED', 'SUPERSEDED', 'DUPLICATE');

ALTER TYPE "KnowledgeGovernanceReviewStatus" ADD VALUE IF NOT EXISTS 'APPLYING' BEFORE 'RESOLVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_FACT_REVIEW_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_FACT_REVIEW_REJECTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_SETTINGS_SYNCED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_DOCUMENT_REPLACEMENT_CONFIRMED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_DOCUMENT_PERMANENTLY_DELETED';

ALTER TABLE "KnowledgeDocument"
  ADD COLUMN "archiveReason" "KnowledgeDocumentArchiveReason",
  ADD COLUMN "replacesDocumentId" TEXT,
  ADD COLUMN "supersededByDocumentId" TEXT;

ALTER TABLE "KnowledgeDocumentFact"
  ADD COLUMN "reviewedByMembershipId" TEXT,
  ADD COLUMN "canonicalEntityType" "KnowledgeGovernanceCanonicalEntityType",
  ADD COLUMN "canonicalEntityId" TEXT,
  ADD COLUMN "canonicalField" TEXT,
  ADD COLUMN "acceptedValue" JSONB;

CREATE UNIQUE INDEX "BusinessMember_id_businessId_key" ON "BusinessMember"("id", "businessId");
CREATE UNIQUE INDEX "KnowledgeGovernanceReview_id_businessId_key" ON "KnowledgeGovernanceReview"("id", "businessId");
CREATE INDEX "KnowledgeDocument_businessId_replacesDocumentId_idx" ON "KnowledgeDocument"("businessId", "replacesDocumentId");
CREATE INDEX "KnowledgeDocument_businessId_supersededByDocumentId_idx" ON "KnowledgeDocument"("businessId", "supersededByDocumentId");
CREATE INDEX "KnowledgeDocumentFact_businessId_canonicalEntityType_canonicalEntityId_idx"
  ON "KnowledgeDocumentFact"("businessId", "canonicalEntityType", "canonicalEntityId");

ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_replacesDocument_business_fkey"
  FOREIGN KEY ("replacesDocumentId", "businessId") REFERENCES "KnowledgeDocument"("id", "businessId") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_supersededByDocument_business_fkey"
  FOREIGN KEY ("supersededByDocumentId", "businessId") REFERENCES "KnowledgeDocument"("id", "businessId") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "KnowledgeDocumentFact" ADD CONSTRAINT "KnowledgeDocumentFact_reviewedByMembershipId_fkey"
  FOREIGN KEY ("reviewedByMembershipId") REFERENCES "BusinessMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "KnowledgeGovernanceResolutionOperation" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "reviewId" TEXT NOT NULL,
  "actorMembershipId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "action" "KnowledgeGovernanceResolutionAction" NOT NULL,
  "expectedVersionId" TEXT NOT NULL,
  "settingsInput" JSONB,
  "status" "KnowledgeGovernanceResolutionOperationStatus" NOT NULL DEFAULT 'APPLYING',
  "resultSnapshot" JSONB,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KnowledgeGovernanceResolutionOperation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "KnowledgeGovernanceResolutionOperation_businessId_idempotencyKey_key"
  ON "KnowledgeGovernanceResolutionOperation"("businessId", "idempotencyKey");
CREATE INDEX "KnowledgeGovernanceResolutionOperation_businessId_reviewId_status_idx"
  ON "KnowledgeGovernanceResolutionOperation"("businessId", "reviewId", "status");
CREATE INDEX "KnowledgeGovernanceResolutionOperation_businessId_actorMembershipId_idx"
  ON "KnowledgeGovernanceResolutionOperation"("businessId", "actorMembershipId");

ALTER TABLE "KnowledgeGovernanceResolutionOperation" ADD CONSTRAINT "KnowledgeGovernanceResolutionOperation_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeGovernanceResolutionOperation" ADD CONSTRAINT "KnowledgeGovernanceResolutionOperation_review_business_fkey"
  FOREIGN KEY ("reviewId", "businessId") REFERENCES "KnowledgeGovernanceReview"("id", "businessId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeGovernanceResolutionOperation" ADD CONSTRAINT "KnowledgeGovernanceResolutionOperation_actor_business_fkey"
  FOREIGN KEY ("actorMembershipId", "businessId") REFERENCES "BusinessMember"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

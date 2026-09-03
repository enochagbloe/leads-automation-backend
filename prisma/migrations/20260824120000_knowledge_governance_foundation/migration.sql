CREATE TYPE "KnowledgeGovernanceStatus" AS ENUM ('REVIEW_REQUIRED', 'APPROVED', 'OUTDATED', 'ARCHIVED');
CREATE TYPE "KnowledgeFactGovernanceStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SUPERSEDED', 'CONFLICT', 'ARCHIVED', 'OUTDATED');
CREATE TYPE "KnowledgeGovernanceComparisonType" AS ENUM ('MATCH', 'CONFLICT', 'MISSING_IN_SETTINGS', 'MISSING_IN_DOCUMENT', 'POTENTIAL_REPLACEMENT');
CREATE TYPE "KnowledgeGovernancePriority" AS ENUM ('CRITICAL', 'HIGH', 'NORMAL');
CREATE TYPE "KnowledgeGovernanceReviewStatus" AS ENUM ('PENDING_REVIEW', 'RESOLVED');
CREATE TYPE "KnowledgeGovernanceCanonicalEntityType" AS ENUM ('SERVICE', 'BUSINESS_PROFILE', 'BUSINESS_AVAILABILITY', 'APPOINTMENT_SETTINGS', 'APPROVED_KNOWLEDGE', 'DOCUMENT_VERSION');
CREATE TYPE "KnowledgeGovernanceResolutionAction" AS ENUM ('UPDATE_SETTINGS', 'KEEP_CURRENT_SETTINGS', 'ADD_TO_SETTINGS', 'APPROVE_KNOWLEDGE_ONLY', 'REVIEW_FIELDS', 'ARCHIVE', 'REPLACE', 'REVIEW_NOT_APPLIED');

ALTER TYPE "KnowledgeDocumentFactType" ADD VALUE IF NOT EXISTS 'SERVICE_DURATION' AFTER 'PRICE';

ALTER TABLE "KnowledgeDocument"
  ADD COLUMN "governanceStatus" "KnowledgeGovernanceStatus" NOT NULL DEFAULT 'REVIEW_REQUIRED';
ALTER TABLE "KnowledgeDocumentVersion"
  ADD COLUMN "governanceStatus" "KnowledgeGovernanceStatus" NOT NULL DEFAULT 'REVIEW_REQUIRED';
ALTER TABLE "KnowledgeDocumentFact"
  ADD COLUMN "governanceStatus" "KnowledgeFactGovernanceStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
  ADD COLUMN "governedAt" TIMESTAMP(3);

CREATE INDEX "KnowledgeDocument_businessId_governanceStatus_idx"
  ON "KnowledgeDocument"("businessId", "governanceStatus");
CREATE INDEX "KnowledgeDocumentVersion_businessId_governanceStatus_idx"
  ON "KnowledgeDocumentVersion"("businessId", "governanceStatus");

CREATE UNIQUE INDEX "KnowledgeDocumentFact_id_versionId_documentId_businessId_key"
  ON "KnowledgeDocumentFact"("id", "versionId", "documentId", "businessId");
CREATE INDEX "KnowledgeDocumentFact_businessId_governanceStatus_idx"
  ON "KnowledgeDocumentFact"("businessId", "governanceStatus");

CREATE TABLE "KnowledgeGovernanceReview" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "versionId" TEXT NOT NULL,
  "factId" TEXT,
  "comparisonKey" TEXT NOT NULL,
  "comparisonType" "KnowledgeGovernanceComparisonType" NOT NULL,
  "priority" "KnowledgeGovernancePriority" NOT NULL,
  "reviewStatus" "KnowledgeGovernanceReviewStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
  "canonicalEntityType" "KnowledgeGovernanceCanonicalEntityType" NOT NULL,
  "canonicalEntityId" TEXT,
  "canonicalField" TEXT,
  "existingValue" JSONB,
  "documentValue" JSONB,
  "normalizedExistingValue" TEXT,
  "normalizedDocumentValue" TEXT,
  "requiresHumanReview" BOOLEAN NOT NULL DEFAULT true,
  "blocksAiUse" BOOLEAN NOT NULL DEFAULT true,
  "relatedDocumentId" TEXT,
  "relatedVersionId" TEXT,
  "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  "reviewedByMembershipId" TEXT,
  "resolutionAction" "KnowledgeGovernanceResolutionAction",
  "resolutionReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KnowledgeGovernanceReview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "KnowledgeGovernanceReview_businessId_versionId_comparisonKey_key"
  ON "KnowledgeGovernanceReview"("businessId", "versionId", "comparisonKey");
CREATE INDEX "KnowledgeGovernanceReview_businessId_reviewStatus_priority_idx"
  ON "KnowledgeGovernanceReview"("businessId", "reviewStatus", "priority");
CREATE INDEX "KnowledgeGovernanceReview_businessId_documentId_versionId_idx"
  ON "KnowledgeGovernanceReview"("businessId", "documentId", "versionId");
CREATE INDEX "KnowledgeGovernanceReview_businessId_factId_idx"
  ON "KnowledgeGovernanceReview"("businessId", "factId");
CREATE INDEX "KnowledgeGovernanceReview_canonicalEntityType_canonicalEntityId_idx"
  ON "KnowledgeGovernanceReview"("canonicalEntityType", "canonicalEntityId");
CREATE INDEX "KnowledgeGovernanceReview_relatedDocumentId_relatedVersionId_idx"
  ON "KnowledgeGovernanceReview"("relatedDocumentId", "relatedVersionId");

ALTER TABLE "KnowledgeGovernanceReview" ADD CONSTRAINT "KnowledgeGovernanceReview_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeGovernanceReview" ADD CONSTRAINT "KnowledgeGovernanceReview_document_business_fkey"
  FOREIGN KEY ("documentId", "businessId") REFERENCES "KnowledgeDocument"("id", "businessId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeGovernanceReview" ADD CONSTRAINT "KnowledgeGovernanceReview_version_document_business_fkey"
  FOREIGN KEY ("versionId", "documentId", "businessId") REFERENCES "KnowledgeDocumentVersion"("id", "documentId", "businessId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeGovernanceReview" ADD CONSTRAINT "KnowledgeGovernanceReview_fact_version_document_business_fkey"
  FOREIGN KEY ("factId", "versionId", "documentId", "businessId") REFERENCES "KnowledgeDocumentFact"("id", "versionId", "documentId", "businessId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeGovernanceReview" ADD CONSTRAINT "KnowledgeGovernanceReview_reviewedByMembershipId_fkey"
  FOREIGN KEY ("reviewedByMembershipId") REFERENCES "BusinessMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

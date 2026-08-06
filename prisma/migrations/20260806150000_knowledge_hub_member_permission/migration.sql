ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_DOCUMENT_PERMISSION_DENIED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_HUB_PERMISSION_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_ARTICLE_SCOPE_VIOLATION';

ALTER TABLE "BusinessMember"
  ADD COLUMN "canManageKnowledgeHub" BOOLEAN NOT NULL DEFAULT false;

-- Preserve existing access as an explicit grant. New managers default to no grant.
UPDATE "BusinessMember"
SET "canManageKnowledgeHub" = true
WHERE "role" IN ('BUSINESS_OWNER', 'MANAGER');

CREATE INDEX "BusinessMember_businessId_canManageKnowledgeHub_idx"
  ON "BusinessMember"("businessId", "canManageKnowledgeHub");

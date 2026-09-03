ALTER TYPE "HumanReviewType" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_CONFLICT';
ALTER TYPE "BusinessNotificationType" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_CONFLICT_REQUIRES_REVIEW';
ALTER TYPE "KnowledgeGovernanceComparisonType" ADD VALUE IF NOT EXISTS 'SETTINGS_CHANGED';

CREATE TYPE "KnowledgeGovernanceNotificationStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'EXHAUSTED');

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_FACT_MARKED_OUTDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_RUNTIME_CONFLICT_BLOCKED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_SETTINGS_RECONCILED';

ALTER TABLE "KnowledgeGovernanceReview"
  ADD COLUMN "criticalNotificationStatus" "KnowledgeGovernanceNotificationStatus",
  ADD COLUMN "criticalNotificationAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "criticalNotificationStartedAt" TIMESTAMP(3),
  ADD COLUMN "criticalNotificationSentAt" TIMESTAMP(3),
  ADD COLUMN "criticalNotificationNextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "criticalNotificationErrorCode" TEXT;

CREATE INDEX "KnowledgeGovernanceReview_runtime_guard_idx"
  ON "KnowledgeGovernanceReview"(
    "businessId",
    "reviewStatus",
    "blocksAiUse",
    "canonicalEntityType",
    "canonicalEntityId",
    "canonicalField"
  );

CREATE INDEX "KnowledgeGovernanceReview_notification_queue_idx"
  ON "KnowledgeGovernanceReview"("criticalNotificationStatus", "criticalNotificationNextAttemptAt");

UPDATE "KnowledgeGovernanceReview"
SET
  "criticalNotificationStatus" = 'PENDING',
  "criticalNotificationNextAttemptAt" = NOW()
WHERE "comparisonType" = 'CONFLICT'
  AND "priority" = 'CRITICAL'
  AND "reviewStatus" <> 'RESOLVED'
  AND "criticalNotificationStatus" IS NULL;

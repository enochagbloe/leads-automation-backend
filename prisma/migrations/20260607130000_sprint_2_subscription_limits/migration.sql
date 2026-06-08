ALTER TYPE "PlanCode" RENAME VALUE 'PRO' TO 'PLUS';

ALTER TYPE "AuditAction" ADD VALUE 'PLAN_LIMIT_REACHED';
ALTER TYPE "AuditAction" ADD VALUE 'PLAN_UPGRADE_REQUIRED';
ALTER TYPE "AuditAction" ADD VALUE 'PLAN_CHANGED_PLACEHOLDER';
ALTER TYPE "AuditAction" ADD VALUE 'USAGE_RECORD_UPDATED';

ALTER TABLE "Plan"
  RENAME COLUMN "maxConversations" TO "maxConversationsPerMonth";

ALTER TABLE "Plan"
  ALTER COLUMN "maxStaff" DROP NOT NULL,
  ALTER COLUMN "maxKnowledgeItems" DROP NOT NULL,
  ADD COLUMN "maxServices" INTEGER,
  ADD COLUMN "maxAppointmentsPerMonth" INTEGER,
  ADD COLUMN "maxAiRepliesPerMonth" INTEGER,
  ADD COLUMN "allowAnalytics" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "allowRemoveBranding" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "allowPrioritySupport" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Plan" SET
  "maxServices" = CASE "code"
    WHEN 'BASIC' THEN 5
    WHEN 'PLUS' THEN 20
    ELSE NULL
  END,
  "maxAppointmentsPerMonth" = CASE "code"
    WHEN 'BASIC' THEN 100
    WHEN 'PLUS' THEN 500
    ELSE NULL
  END,
  "maxAiRepliesPerMonth" = "maxConversationsPerMonth",
  "allowAnalytics" = "code" IN ('PLUS', 'PREMIUM'),
  "allowRemoveBranding" = "code" = 'PREMIUM',
  "allowPrioritySupport" = "code" = 'PREMIUM',
  "maxStaff" = CASE WHEN "code" = 'PREMIUM' THEN NULL ELSE "maxStaff" END,
  "maxKnowledgeItems" = CASE WHEN "code" = 'PREMIUM' THEN NULL ELSE "maxKnowledgeItems" END;

ALTER TABLE "Plan"
  DROP COLUMN "maxBusinesses",
  DROP COLUMN "features";

ALTER TABLE "UsageRecord"
  RENAME COLUMN "aiMessagesUsed" TO "aiRepliesUsed";

ALTER TABLE "UsageRecord"
  ADD COLUMN "servicesCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "appointmentsUsed" INTEGER NOT NULL DEFAULT 0;

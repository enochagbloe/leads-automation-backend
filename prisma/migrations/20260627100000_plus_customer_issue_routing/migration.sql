ALTER TYPE "BusinessNotificationType" ADD VALUE IF NOT EXISTS 'CUSTOMER_ISSUE_ASSIGNED';
ALTER TYPE "BusinessNotificationType" ADD VALUE IF NOT EXISTS 'CUSTOMER_ISSUE_VISIBILITY';
ALTER TYPE "BusinessNotificationType" ADD VALUE IF NOT EXISTS 'CUSTOMER_ISSUE_UNROUTED';

ALTER TYPE "BusinessNotificationEntityType" ADD VALUE IF NOT EXISTS 'CUSTOMER_ISSUE';

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AI_SAFE_HANDOFF_TRIGGERED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AI_SAFE_HANDOFF_NOTIFICATION_SENT';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AI_COMPLAINT_DETECTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CUSTOMER_ISSUE_LOG_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CUSTOMER_ISSUE_ROUTED_TO_STAFF';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CUSTOMER_ISSUE_ROUTING_FALLBACK_TO_MANAGER';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CUSTOMER_ISSUE_EMAIL_SENT';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CUSTOMER_ISSUE_STATUS_UPDATED';

DO $$ BEGIN
  CREATE TYPE "CustomerIssueType" AS ENUM ('COMPLAINT', 'ISSUE', 'REQUEST_REQUIRES_INTERNAL_ACTION');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "CustomerIssueCategory" AS ENUM ('DELAY', 'POOR_SERVICE', 'QUALITY_ISSUE', 'STAFF_BEHAVIOR', 'MISCOMMUNICATION', 'PAYMENT_ISSUE', 'APPOINTMENT_ISSUE', 'DELIVERY_OR_SITE_ISSUE', 'MISSING_ITEM_OR_MISSING_WORK', 'FOLLOW_UP_REQUIRED', 'OTHER');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "CustomerIssueSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "CustomerIssueStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'CLOSED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "CustomerIssueCreatedBy" AS ENUM ('AI', 'MANUAL');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "AccountUsageRecord" ADD COLUMN IF NOT EXISTS "aiSafeHandoffsTriggered" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AccountUsageRecord" ADD COLUMN IF NOT EXISTS "aiSafeHandoffEmailsSent" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AccountUsageRecord" ADD COLUMN IF NOT EXISTS "aiComplaintsDetected" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AccountUsageRecord" ADD COLUMN IF NOT EXISTS "customerIssuesLogged" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AccountUsageRecord" ADD COLUMN IF NOT EXISTS "customerIssuesRouted" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AccountUsageRecord" ADD COLUMN IF NOT EXISTS "customerIssueEmailsSent" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "CustomerIssueLog" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "leadId" TEXT,
  "conversationId" TEXT,
  "customerMessageId" TEXT,
  "type" "CustomerIssueType" NOT NULL,
  "category" "CustomerIssueCategory" NOT NULL,
  "subcategory" TEXT,
  "severity" "CustomerIssueSeverity" NOT NULL,
  "summary" TEXT NOT NULL,
  "customerMessageExcerpt" TEXT,
  "clientOwnerMembershipId" TEXT,
  "conversationAssignedMembershipId" TEXT,
  "suggestedResponsibleMembershipId" TEXT,
  "responsibleMembershipId" TEXT,
  "routingReason" TEXT,
  "status" "CustomerIssueStatus" NOT NULL DEFAULT 'OPEN',
  "createdBy" "CustomerIssueCreatedBy" NOT NULL DEFAULT 'AI',
  "createdByUserId" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "CustomerIssueLog_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "CustomerIssueLog" ADD CONSTRAINT "CustomerIssueLog_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "CustomerIssueLog" ADD CONSTRAINT "CustomerIssueLog_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "CustomerIssueLog" ADD CONSTRAINT "CustomerIssueLog_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "CustomerIssueLog" ADD CONSTRAINT "CustomerIssueLog_customerMessageId_fkey" FOREIGN KEY ("customerMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "CustomerIssueLog" ADD CONSTRAINT "CustomerIssueLog_clientOwnerMembershipId_fkey" FOREIGN KEY ("clientOwnerMembershipId") REFERENCES "BusinessMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "CustomerIssueLog" ADD CONSTRAINT "CustomerIssueLog_conversationAssignedMembershipId_fkey" FOREIGN KEY ("conversationAssignedMembershipId") REFERENCES "BusinessMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "CustomerIssueLog" ADD CONSTRAINT "CustomerIssueLog_suggestedResponsibleMembershipId_fkey" FOREIGN KEY ("suggestedResponsibleMembershipId") REFERENCES "BusinessMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "CustomerIssueLog" ADD CONSTRAINT "CustomerIssueLog_responsibleMembershipId_fkey" FOREIGN KEY ("responsibleMembershipId") REFERENCES "BusinessMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "CustomerIssueLog" ADD CONSTRAINT "CustomerIssueLog_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "CustomerIssueLog_businessId_status_createdAt_idx" ON "CustomerIssueLog"("businessId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "CustomerIssueLog_businessId_category_createdAt_idx" ON "CustomerIssueLog"("businessId", "category", "createdAt");
CREATE INDEX IF NOT EXISTS "CustomerIssueLog_businessId_severity_createdAt_idx" ON "CustomerIssueLog"("businessId", "severity", "createdAt");
CREATE INDEX IF NOT EXISTS "CustomerIssueLog_businessId_responsibleMembershipId_createdAt_idx" ON "CustomerIssueLog"("businessId", "responsibleMembershipId", "createdAt");
CREATE INDEX IF NOT EXISTS "CustomerIssueLog_businessId_leadId_createdAt_idx" ON "CustomerIssueLog"("businessId", "leadId", "createdAt");
CREATE INDEX IF NOT EXISTS "CustomerIssueLog_businessId_conversationId_createdAt_idx" ON "CustomerIssueLog"("businessId", "conversationId", "createdAt");
CREATE INDEX IF NOT EXISTS "CustomerIssueLog_customerMessageId_idx" ON "CustomerIssueLog"("customerMessageId");

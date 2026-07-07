-- Follow-up automation foundation.
CREATE TYPE "FollowUpRuleType" AS ENUM (
  'NO_RESPONSE_AFTER_MESSAGE',
  'CONTACT_EMAIL_REQUEST',
  'BEFORE_APPOINTMENT',
  'AFTER_APPOINTMENT',
  'AFTER_QUOTE_SENT',
  'STALE_LEAD'
);

CREATE TYPE "FollowUpContextType" AS ENUM (
  'GENERAL_NO_RESPONSE',
  'MISSING_CUSTOMER_DETAIL',
  'CONTACT_EMAIL_REQUEST',
  'APPOINTMENT_CONFIRMATION',
  'QUOTE_RESPONSE',
  'PAYMENT_RESPONSE',
  'SERVICE_SELECTION',
  'LOCATION_REQUEST',
  'DATE_TIME_REQUEST',
  'POST_APPOINTMENT_FEEDBACK'
);

CREATE TYPE "FollowUpJobStatus" AS ENUM (
  'SCHEDULED',
  'CANCELLED',
  'SKIPPED',
  'SENT',
  'FAILED'
);

CREATE TYPE "FollowUpSendLogSentBy" AS ENUM ('SYSTEM', 'AI');
CREATE TYPE "FollowUpSendLogDeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'FOLLOW_UP_RULE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'FOLLOW_UP_RULE_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'FOLLOW_UP_RULE_DELETED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'FOLLOW_UP_AUTOMATION_ENABLED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'FOLLOW_UP_AUTOMATION_DISABLED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'FOLLOW_UP_JOB_SCHEDULED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'FOLLOW_UP_JOB_CANCELLED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'FOLLOW_UP_JOB_RESCHEDULED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'FOLLOW_UP_JOB_SKIPPED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'FOLLOW_UP_JOB_SENT';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'FOLLOW_UP_JOB_FAILED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'FOLLOW_UP_CONTEXT_EVALUATED';

ALTER TABLE "Business" ADD COLUMN "followUpAutomationEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "FollowUpAutomationRule" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "type" "FollowUpRuleType" NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "delayMinutes" INTEGER NOT NULL,
  "messageTemplate" TEXT NOT NULL,
  "useAiRewrite" BOOLEAN NOT NULL DEFAULT false,
  "maxSendsPerLead" INTEGER NOT NULL DEFAULT 1,
  "maxSendsPerConversation" INTEGER NOT NULL DEFAULT 1,
  "cooldownMinutes" INTEGER,
  "onlyDuringBusinessHours" BOOLEAN NOT NULL DEFAULT true,
  "planRequired" "PlanCode" NOT NULL DEFAULT 'BASIC',
  "deletedAt" TIMESTAMP(3),
  "createdByMembershipId" TEXT NOT NULL,
  "updatedByMembershipId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FollowUpAutomationRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FollowUpJob" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "ruleId" TEXT NOT NULL,
  "leadId" TEXT,
  "conversationId" TEXT,
  "appointmentId" TEXT,
  "quoteId" TEXT,
  "contextType" "FollowUpContextType" NOT NULL,
  "pendingQuestion" TEXT,
  "expectedResponseType" TEXT,
  "relatedMessageId" TEXT,
  "status" "FollowUpJobStatus" NOT NULL DEFAULT 'SCHEDULED',
  "scheduledFor" TIMESTAMP(3) NOT NULL,
  "cancelReason" TEXT,
  "skipReason" TEXT,
  "failureReason" TEXT,
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FollowUpJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FollowUpSendLog" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "ruleId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "leadId" TEXT,
  "conversationId" TEXT,
  "appointmentId" TEXT,
  "quoteId" TEXT,
  "messageText" TEXT NOT NULL,
  "sentBy" "FollowUpSendLogSentBy" NOT NULL DEFAULT 'SYSTEM',
  "deliveryStatus" "FollowUpSendLogDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
  "whatsappMessageId" TEXT,
  "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FollowUpSendLog_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "FollowUpAutomationRule" ADD CONSTRAINT "FollowUpAutomationRule_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FollowUpAutomationRule" ADD CONSTRAINT "FollowUpAutomationRule_createdByMembershipId_fkey" FOREIGN KEY ("createdByMembershipId") REFERENCES "BusinessMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FollowUpAutomationRule" ADD CONSTRAINT "FollowUpAutomationRule_updatedByMembershipId_fkey" FOREIGN KEY ("updatedByMembershipId") REFERENCES "BusinessMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "FollowUpJob" ADD CONSTRAINT "FollowUpJob_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FollowUpJob" ADD CONSTRAINT "FollowUpJob_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "FollowUpAutomationRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FollowUpJob" ADD CONSTRAINT "FollowUpJob_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FollowUpJob" ADD CONSTRAINT "FollowUpJob_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FollowUpJob" ADD CONSTRAINT "FollowUpJob_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "FollowUpSendLog" ADD CONSTRAINT "FollowUpSendLog_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FollowUpSendLog" ADD CONSTRAINT "FollowUpSendLog_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "FollowUpAutomationRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FollowUpSendLog" ADD CONSTRAINT "FollowUpSendLog_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "FollowUpJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FollowUpSendLog" ADD CONSTRAINT "FollowUpSendLog_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FollowUpSendLog" ADD CONSTRAINT "FollowUpSendLog_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FollowUpSendLog" ADD CONSTRAINT "FollowUpSendLog_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "FollowUpAutomationRule_businessId_idx" ON "FollowUpAutomationRule"("businessId");
CREATE INDEX "FollowUpAutomationRule_businessId_type_idx" ON "FollowUpAutomationRule"("businessId", "type");
CREATE INDEX "FollowUpAutomationRule_businessId_enabled_idx" ON "FollowUpAutomationRule"("businessId", "enabled");
CREATE INDEX "FollowUpAutomationRule_businessId_deletedAt_idx" ON "FollowUpAutomationRule"("businessId", "deletedAt");

CREATE INDEX "FollowUpJob_businessId_idx" ON "FollowUpJob"("businessId");
CREATE INDEX "FollowUpJob_businessId_status_scheduledFor_idx" ON "FollowUpJob"("businessId", "status", "scheduledFor");
CREATE INDEX "FollowUpJob_businessId_ruleId_idx" ON "FollowUpJob"("businessId", "ruleId");
CREATE INDEX "FollowUpJob_businessId_leadId_idx" ON "FollowUpJob"("businessId", "leadId");
CREATE INDEX "FollowUpJob_businessId_conversationId_idx" ON "FollowUpJob"("businessId", "conversationId");
CREATE INDEX "FollowUpJob_businessId_appointmentId_idx" ON "FollowUpJob"("businessId", "appointmentId");
CREATE INDEX "FollowUpJob_businessId_quoteId_idx" ON "FollowUpJob"("businessId", "quoteId");
CREATE INDEX "FollowUpJob_businessId_contextType_idx" ON "FollowUpJob"("businessId", "contextType");
CREATE UNIQUE INDEX "FollowUpJob_businessId_ruleId_conversationId_contextType_relatedMessageId_key" ON "FollowUpJob"("businessId", "ruleId", "conversationId", "contextType", "relatedMessageId");

CREATE INDEX "FollowUpSendLog_businessId_idx" ON "FollowUpSendLog"("businessId");
CREATE INDEX "FollowUpSendLog_businessId_ruleId_idx" ON "FollowUpSendLog"("businessId", "ruleId");
CREATE INDEX "FollowUpSendLog_businessId_jobId_idx" ON "FollowUpSendLog"("businessId", "jobId");
CREATE INDEX "FollowUpSendLog_businessId_leadId_idx" ON "FollowUpSendLog"("businessId", "leadId");
CREATE INDEX "FollowUpSendLog_businessId_conversationId_idx" ON "FollowUpSendLog"("businessId", "conversationId");
CREATE INDEX "FollowUpSendLog_businessId_appointmentId_idx" ON "FollowUpSendLog"("businessId", "appointmentId");
CREATE INDEX "FollowUpSendLog_businessId_quoteId_idx" ON "FollowUpSendLog"("businessId", "quoteId");
CREATE INDEX "FollowUpSendLog_businessId_deliveryStatus_idx" ON "FollowUpSendLog"("businessId", "deliveryStatus");
CREATE INDEX "FollowUpSendLog_businessId_createdAt_idx" ON "FollowUpSendLog"("businessId", "createdAt");

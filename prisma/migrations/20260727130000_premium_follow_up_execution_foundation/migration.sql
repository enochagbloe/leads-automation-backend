CREATE TYPE "PremiumFollowUpExecutionStatus" AS ENUM (
  'EXECUTING',
  'READY_TO_SEND',
  'SCHEDULED',
  'STOPPED',
  'RECALCULATION_REQUIRED',
  'ESCALATION_STARTED',
  'ESCALATED',
  'SENT',
  'BLOCKED',
  'FAILED',
  'EXHAUSTED'
);

ALTER TABLE "FollowUpSendLog"
  ADD COLUMN "executionIdempotencyKey" TEXT;

CREATE UNIQUE INDEX "FollowUpSendLog_executionIdempotencyKey_key"
  ON "FollowUpSendLog"("executionIdempotencyKey");

CREATE TABLE "PremiumFollowUpExecution" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "ruleId" TEXT NOT NULL,
  "leadId" TEXT,
  "conversationId" TEXT,
  "generationId" TEXT,
  "sequenceStage" "PremiumFollowUpSequenceStage" NOT NULL,
  "finalDecision" TEXT NOT NULL,
  "validationStatus" TEXT NOT NULL,
  "executionStatus" "PremiumFollowUpExecutionStatus" NOT NULL DEFAULT 'EXECUTING',
  "executionReason" TEXT,
  "executionBlocked" BOOLEAN NOT NULL DEFAULT false,
  "blockReason" TEXT,
  "messageSource" "PremiumFollowUpMessageSource" NOT NULL DEFAULT 'NONE',
  "fallbackMessageUsed" BOOLEAN NOT NULL DEFAULT false,
  "contextVersion" TEXT NOT NULL,
  "promptVersions" JSONB,
  "memoryVersion" TEXT,
  "validationSnapshot" JSONB NOT NULL,
  "executionIdempotencyKey" TEXT NOT NULL,
  "recalculationCount" INTEGER NOT NULL DEFAULT 0,
  "outboundMessageId" TEXT,
  "sendLogId" TEXT,
  "scheduledFor" TIMESTAMP(3),
  "processingStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "executedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PremiumFollowUpExecution_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PremiumFollowUpExecution_executionIdempotencyKey_key"
  ON "PremiumFollowUpExecution"("executionIdempotencyKey");

CREATE UNIQUE INDEX "PremiumFollowUpExecution_jobId_contextVersion_sequenceStage_key"
  ON "PremiumFollowUpExecution"("jobId", "contextVersion", "sequenceStage");

CREATE INDEX "PremiumFollowUpExecution_businessId_createdAt_idx"
  ON "PremiumFollowUpExecution"("businessId", "createdAt");

CREATE INDEX "PremiumFollowUpExecution_businessId_jobId_idx"
  ON "PremiumFollowUpExecution"("businessId", "jobId");

CREATE INDEX "PremiumFollowUpExecution_businessId_conversationId_idx"
  ON "PremiumFollowUpExecution"("businessId", "conversationId");

CREATE INDEX "PremiumFollowUpExecution_businessId_executionStatus_idx"
  ON "PremiumFollowUpExecution"("businessId", "executionStatus");

ALTER TABLE "PremiumFollowUpExecution"
  ADD CONSTRAINT "PremiumFollowUpExecution_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PremiumFollowUpExecution"
  ADD CONSTRAINT "PremiumFollowUpExecution_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "FollowUpJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PremiumFollowUpExecution"
  ADD CONSTRAINT "PremiumFollowUpExecution_ruleId_fkey"
  FOREIGN KEY ("ruleId") REFERENCES "FollowUpAutomationRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PremiumFollowUpExecution"
  ADD CONSTRAINT "PremiumFollowUpExecution_leadId_fkey"
  FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PremiumFollowUpExecution"
  ADD CONSTRAINT "PremiumFollowUpExecution_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PremiumFollowUpExecution"
  ADD CONSTRAINT "PremiumFollowUpExecution_generationId_fkey"
  FOREIGN KEY ("generationId") REFERENCES "PremiumFollowUpMessageGeneration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

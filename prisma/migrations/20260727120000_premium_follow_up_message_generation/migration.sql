CREATE TYPE "PremiumFollowUpGenerationStatus" AS ENUM (
  'GENERATING',
  'GENERATED',
  'FALLBACK_GENERATED',
  'NOT_REQUIRED',
  'REJECTED',
  'RECALCULATION_REQUIRED',
  'ESCALATION_REQUIRED',
  'GENERATION_FAILED'
);

CREATE TYPE "PremiumFollowUpMessageSource" AS ENUM (
  'AI_GENERATED',
  'DETERMINISTIC_FALLBACK',
  'ESCALATION_TEMPLATE',
  'NONE'
);

CREATE TABLE "PremiumFollowUpMessageGeneration" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "ruleId" TEXT NOT NULL,
  "leadId" TEXT,
  "conversationId" TEXT,
  "messageId" TEXT,
  "contextType" "FollowUpContextType" NOT NULL,
  "sequenceStage" "PremiumFollowUpSequenceStage" NOT NULL,
  "finalDecision" TEXT NOT NULL,
  "validationStatus" TEXT NOT NULL,
  "generationStatus" "PremiumFollowUpGenerationStatus" NOT NULL DEFAULT 'GENERATING',
  "generatedMessage" TEXT,
  "fallbackMessageUsed" BOOLEAN NOT NULL DEFAULT false,
  "messageSource" "PremiumFollowUpMessageSource" NOT NULL DEFAULT 'NONE',
  "customerGoalUsed" TEXT,
  "customerObjectionUsed" TEXT,
  "timingContextUsed" TEXT,
  "unresolvedRequestUsed" TEXT,
  "appointmentFactsUsed" JSONB,
  "promptVersionsUsed" JSONB,
  "memoryVersionUsed" TEXT,
  "generationModelUsed" TEXT,
  "promptConflict" BOOLEAN NOT NULL DEFAULT false,
  "missingKnowledge" BOOLEAN NOT NULL DEFAULT false,
  "validationPassed" BOOLEAN NOT NULL DEFAULT false,
  "validationIssues" JSONB NOT NULL,
  "regenerationAttempted" BOOLEAN NOT NULL DEFAULT false,
  "idempotencyKey" TEXT NOT NULL,
  "contextVersion" TEXT NOT NULL,
  "inputSnapshot" JSONB NOT NULL,
  "providerMetadata" JSONB,
  "processingStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "generatedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PremiumFollowUpMessageGeneration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PremiumFollowUpMessageGeneration_idempotencyKey_key"
  ON "PremiumFollowUpMessageGeneration"("idempotencyKey");

CREATE UNIQUE INDEX "PremiumFollowUpMessageGeneration_jobId_contextVersion_sequenceStage_key"
  ON "PremiumFollowUpMessageGeneration"("jobId", "contextVersion", "sequenceStage");

CREATE INDEX "PremiumFollowUpMessageGeneration_businessId_createdAt_idx"
  ON "PremiumFollowUpMessageGeneration"("businessId", "createdAt");

CREATE INDEX "PremiumFollowUpMessageGeneration_businessId_jobId_idx"
  ON "PremiumFollowUpMessageGeneration"("businessId", "jobId");

CREATE INDEX "PremiumFollowUpMessageGeneration_businessId_conversationId_idx"
  ON "PremiumFollowUpMessageGeneration"("businessId", "conversationId");

CREATE INDEX "PremiumFollowUpMessageGeneration_businessId_generationStatus_idx"
  ON "PremiumFollowUpMessageGeneration"("businessId", "generationStatus");

ALTER TABLE "PremiumFollowUpMessageGeneration"
  ADD CONSTRAINT "PremiumFollowUpMessageGeneration_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PremiumFollowUpMessageGeneration"
  ADD CONSTRAINT "PremiumFollowUpMessageGeneration_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "FollowUpJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PremiumFollowUpMessageGeneration"
  ADD CONSTRAINT "PremiumFollowUpMessageGeneration_ruleId_fkey"
  FOREIGN KEY ("ruleId") REFERENCES "FollowUpAutomationRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PremiumFollowUpMessageGeneration"
  ADD CONSTRAINT "PremiumFollowUpMessageGeneration_leadId_fkey"
  FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PremiumFollowUpMessageGeneration"
  ADD CONSTRAINT "PremiumFollowUpMessageGeneration_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PremiumFollowUpMessageGeneration"
  ADD CONSTRAINT "PremiumFollowUpMessageGeneration_messageId_fkey"
  FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

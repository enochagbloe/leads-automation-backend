CREATE TYPE "PremiumFollowUpDecision" AS ENUM (
  'SCHEDULE',
  'SEND',
  'RESCHEDULE',
  'CANCEL',
  'STOP'
);

CREATE TYPE "PremiumFollowUpSequenceStage" AS ENUM (
  'INITIAL_CHECK_IN',
  'HELPFUL_CLARIFICATION',
  'FINAL_POLITE_FOLLOW_UP'
);

CREATE TABLE "PremiumFollowUpIntelligenceSnapshot" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "leadId" TEXT,
  "conversationId" TEXT,
  "jobId" TEXT,
  "sourceMessageId" TEXT,
  "attemptNumber" INTEGER NOT NULL DEFAULT 1,
  "sequenceStage" "PremiumFollowUpSequenceStage" NOT NULL DEFAULT 'INITIAL_CHECK_IN',
  "decision" "PremiumFollowUpDecision" NOT NULL,
  "customerGoal" TEXT,
  "customerObjection" TEXT,
  "preferredFollowUpAt" TIMESTAMP(3),
  "preferredFollowUpText" TEXT,
  "conversationStillActive" BOOLEAN NOT NULL DEFAULT true,
  "staffRecentlyActive" BOOLEAN NOT NULL DEFAULT false,
  "shouldStopAutomation" BOOLEAN NOT NULL DEFAULT false,
  "stopReason" TEXT,
  "recommendedMessageAngle" TEXT,
  "confidence" DOUBLE PRECISION,
  "rawDecision" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PremiumFollowUpIntelligenceSnapshot_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PremiumFollowUpIntelligenceSnapshot" ADD CONSTRAINT "PremiumFollowUpIntelligenceSnapshot_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PremiumFollowUpIntelligenceSnapshot" ADD CONSTRAINT "PremiumFollowUpIntelligenceSnapshot_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PremiumFollowUpIntelligenceSnapshot" ADD CONSTRAINT "PremiumFollowUpIntelligenceSnapshot_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PremiumFollowUpIntelligenceSnapshot" ADD CONSTRAINT "PremiumFollowUpIntelligenceSnapshot_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "FollowUpJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PremiumFollowUpIntelligenceSnapshot" ADD CONSTRAINT "PremiumFollowUpIntelligenceSnapshot_sourceMessageId_fkey" FOREIGN KEY ("sourceMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "PremiumFollowUpIntelligenceSnapshot_businessId_idx" ON "PremiumFollowUpIntelligenceSnapshot"("businessId");
CREATE INDEX "PremiumFollowUpIntelligenceSnapshot_businessId_conversationId_createdAt_idx" ON "PremiumFollowUpIntelligenceSnapshot"("businessId", "conversationId", "createdAt");
CREATE INDEX "PremiumFollowUpIntelligenceSnapshot_businessId_leadId_createdAt_idx" ON "PremiumFollowUpIntelligenceSnapshot"("businessId", "leadId", "createdAt");
CREATE INDEX "PremiumFollowUpIntelligenceSnapshot_businessId_jobId_idx" ON "PremiumFollowUpIntelligenceSnapshot"("businessId", "jobId");
CREATE INDEX "PremiumFollowUpIntelligenceSnapshot_businessId_decision_idx" ON "PremiumFollowUpIntelligenceSnapshot"("businessId", "decision");

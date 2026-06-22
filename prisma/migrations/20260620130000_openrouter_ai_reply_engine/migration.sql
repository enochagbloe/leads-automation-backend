-- Add account-level AI usage counters used by the shared AI reply engine.
ALTER TABLE "AccountUsageRecord"
ADD COLUMN IF NOT EXISTS "aiRequestsUsed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "aiTokensUsed" INTEGER NOT NULL DEFAULT 0;

-- Store provider decisions and execution outcomes without raw prompts or provider secrets.
CREATE TABLE IF NOT EXISTS "AiInteractionLog" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "businessAccountId" TEXT,
  "conversationId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "aiMessageId" TEXT,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "intent" TEXT,
  "confidence" DOUBLE PRECISION,
  "suggestedAction" TEXT,
  "shouldReply" BOOLEAN NOT NULL DEFAULT false,
  "requiresHumanReview" BOOLEAN NOT NULL DEFAULT false,
  "blockedReason" TEXT,
  "promptTokens" INTEGER,
  "completionTokens" INTEGER,
  "totalTokens" INTEGER,
  "latencyMs" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AiInteractionLog_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AiInteractionLog_businessId_fkey'
  ) THEN
    ALTER TABLE "AiInteractionLog"
    ADD CONSTRAINT "AiInteractionLog_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AiInteractionLog_businessAccountId_fkey'
  ) THEN
    ALTER TABLE "AiInteractionLog"
    ADD CONSTRAINT "AiInteractionLog_businessAccountId_fkey"
    FOREIGN KEY ("businessAccountId") REFERENCES "BusinessAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AiInteractionLog_conversationId_fkey'
  ) THEN
    ALTER TABLE "AiInteractionLog"
    ADD CONSTRAINT "AiInteractionLog_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AiInteractionLog_messageId_fkey'
  ) THEN
    ALTER TABLE "AiInteractionLog"
    ADD CONSTRAINT "AiInteractionLog_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AiInteractionLog_aiMessageId_fkey'
  ) THEN
    ALTER TABLE "AiInteractionLog"
    ADD CONSTRAINT "AiInteractionLog_aiMessageId_fkey"
    FOREIGN KEY ("aiMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "AiInteractionLog_businessId_createdAt_idx" ON "AiInteractionLog"("businessId", "createdAt");
CREATE INDEX IF NOT EXISTS "AiInteractionLog_businessAccountId_createdAt_idx" ON "AiInteractionLog"("businessAccountId", "createdAt");
CREATE INDEX IF NOT EXISTS "AiInteractionLog_conversationId_createdAt_idx" ON "AiInteractionLog"("conversationId", "createdAt");
CREATE INDEX IF NOT EXISTS "AiInteractionLog_messageId_idx" ON "AiInteractionLog"("messageId");
CREATE INDEX IF NOT EXISTS "AiInteractionLog_aiMessageId_idx" ON "AiInteractionLog"("aiMessageId");
CREATE INDEX IF NOT EXISTS "AiInteractionLog_status_createdAt_idx" ON "AiInteractionLog"("status", "createdAt");

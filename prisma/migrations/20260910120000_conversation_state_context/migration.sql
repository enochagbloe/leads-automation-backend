CREATE UNIQUE INDEX "Conversation_id_businessId_key" ON "Conversation"("id", "businessId");
CREATE TABLE "ConversationState" (
  "id" TEXT NOT NULL, "businessId" TEXT NOT NULL, "conversationId" TEXT NOT NULL,
  "activeTopic" TEXT, "previousTopic" TEXT, "activeWorkflow" TEXT,
  "workflowStatus" TEXT NOT NULL DEFAULT 'IDLE', "awaiting" JSONB,
  "knownEntities" JSONB NOT NULL DEFAULT '{}', "offeredOptions" JSONB NOT NULL DEFAULT '[]',
  "lastAssistantQuestion" TEXT, "lastResolvedIntent" TEXT, "revision" INTEGER NOT NULL DEFAULT 0,
  "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConversationState_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ConversationState_scope_fkey" FOREIGN KEY ("conversationId", "businessId") REFERENCES "Conversation"("id", "businessId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ConversationState_revision_check" CHECK ("revision" >= 0),
  CONSTRAINT "ConversationState_status_check" CHECK ("workflowStatus" IN ('IDLE','ACTIVE','WAITING_FOR_CUSTOMER','WAITING_FOR_SYSTEM','COMPLETED','CANCELLED','PAUSED'))
);
CREATE UNIQUE INDEX "ConversationState_conversationId_key" ON "ConversationState"("conversationId");
CREATE UNIQUE INDEX "ConversationState_conversationId_businessId_key" ON "ConversationState"("conversationId", "businessId");
CREATE INDEX "ConversationState_businessId_lastActivityAt_idx" ON "ConversationState"("businessId", "lastActivityAt");
CREATE TABLE "ConversationStateEffect" (
  "id" TEXT NOT NULL, "businessId" TEXT NOT NULL, "conversationId" TEXT NOT NULL,
  "effectKey" TEXT NOT NULL, "commandHash" TEXT NOT NULL, "source" TEXT NOT NULL, "sourceMessageId" TEXT,
  "revisionBefore" INTEGER NOT NULL, "revisionAfter" INTEGER NOT NULL, "changedFields" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConversationStateEffect_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ConversationStateEffect_scope_fkey" FOREIGN KEY ("conversationId", "businessId") REFERENCES "Conversation"("id", "businessId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ConversationStateEffect_scope_key" ON "ConversationStateEffect"("businessId", "conversationId", "effectKey");
CREATE INDEX "ConversationStateEffect_businessId_conversationId_createdAt_idx" ON "ConversationStateEffect"("businessId", "conversationId", "createdAt");

ALTER TABLE "ConversationState" ADD COLUMN "offeredOptionsCreatedAt" TIMESTAMP(3);
CREATE TABLE "ConversationInterpretation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "businessId" TEXT NOT NULL, "conversationId" TEXT NOT NULL, "sourceMessageId" TEXT NOT NULL,
  "snapshotRevision" INTEGER NOT NULL, "appliedRevision" INTEGER NOT NULL,
  "result" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConversationInterpretation_scope_fkey" FOREIGN KEY ("conversationId", "businessId") REFERENCES "Conversation"("id", "businessId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ConversationInterpretation_source_key" ON "ConversationInterpretation"("businessId", "conversationId", "sourceMessageId");
CREATE INDEX "ConversationInterpretation_businessId_conversationId_createdAt_idx" ON "ConversationInterpretation"("businessId", "conversationId", "createdAt");

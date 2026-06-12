ALTER TYPE "LeadActivityAction" ADD VALUE 'CONVERSATION_ENDED';
ALTER TYPE "LeadActivityAction" ADD VALUE 'CONVERSATION_REOPENED';
ALTER TYPE "LeadActivityAction" ADD VALUE 'MESSAGE_STATUS_UPDATED';

ALTER TYPE "AuditAction" ADD VALUE 'CONVERSATION_ENDED';
ALTER TYPE "AuditAction" ADD VALUE 'CONVERSATION_REOPENED';
ALTER TYPE "AuditAction" ADD VALUE 'WHATSAPP_MESSAGE_STATUS_UPDATED';

ALTER TYPE "WebhookEventType" ADD VALUE 'WHATSAPP_INBOUND_MESSAGE';
ALTER TYPE "WebhookEventType" ADD VALUE 'WHATSAPP_STATUS_UPDATE';

ALTER TYPE "WebhookProcessingStatus" ADD VALUE 'MESSAGE_NOT_FOUND';

ALTER TABLE "WebhookEventLog"
ADD COLUMN "conversationId" TEXT,
ADD COLUMN "messageId" TEXT;

CREATE INDEX "WebhookEventLog_conversationId_receivedAt_idx" ON "WebhookEventLog"("conversationId", "receivedAt");
CREATE INDEX "WebhookEventLog_messageId_receivedAt_idx" ON "WebhookEventLog"("messageId", "receivedAt");

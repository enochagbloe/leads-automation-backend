CREATE TYPE "ConversationChannel" AS ENUM ('MANUAL', 'WHATSAPP', 'OTHER', 'INSTAGRAM', 'FACEBOOK', 'WEBSITE_CHAT', 'EMAIL');
CREATE TYPE "ConversationStatus" AS ENUM ('OPEN', 'AI_HANDLING', 'HUMAN_HANDLING', 'CLOSED');
CREATE TYPE "ConversationPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');
CREATE TYPE "MessageSenderType" AS ENUM ('CUSTOMER', 'STAFF', 'AI', 'SYSTEM');
CREATE TYPE "MessageType" AS ENUM ('TEXT', 'SYSTEM', 'IMAGE', 'DOCUMENT', 'AUDIO', 'VIDEO', 'LOCATION');
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND', 'INTERNAL');
CREATE TYPE "MessageDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'INTERNAL');

ALTER TYPE "LeadActivityAction" ADD VALUE 'CONVERSATION_CREATED';
ALTER TYPE "LeadActivityAction" ADD VALUE 'CONVERSATION_ASSIGNED';
ALTER TYPE "LeadActivityAction" ADD VALUE 'CONVERSATION_STATUS_CHANGED';
ALTER TYPE "LeadActivityAction" ADD VALUE 'CONVERSATION_DELETED';
ALTER TYPE "LeadActivityAction" ADD VALUE 'MESSAGE_CREATED';
ALTER TYPE "LeadActivityAction" ADD VALUE 'CONVERSATION_MARKED_READ';

ALTER TYPE "AuditAction" ADD VALUE 'CONVERSATION_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'CONVERSATION_ASSIGNED';
ALTER TYPE "AuditAction" ADD VALUE 'CONVERSATION_STATUS_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'CONVERSATION_DELETED';
ALTER TYPE "AuditAction" ADD VALUE 'MESSAGE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'CONVERSATION_MARKED_READ';
ALTER TYPE "AuditAction" ADD VALUE 'CONVERSATION_READ_FAILED';
ALTER TYPE "AuditAction" ADD VALUE 'MESSAGE_CREATE_FAILED';

CREATE SEQUENCE "Conversation_display_seq" START 1000;

CREATE TABLE "Conversation" (
  "id" TEXT NOT NULL,
  "displayId" TEXT NOT NULL DEFAULT ('CONV-' || LPAD(nextval('"Conversation_display_seq"')::TEXT, 6, '0')),
  "businessId" TEXT NOT NULL,
  "leadId" TEXT NOT NULL,
  "assignedStaffId" TEXT,
  "channel" "ConversationChannel" NOT NULL,
  "status" "ConversationStatus" NOT NULL DEFAULT 'OPEN',
  "subject" TEXT,
  "priority" "ConversationPriority" NOT NULL DEFAULT 'NORMAL',
  "pinned" BOOLEAN NOT NULL DEFAULT false,
  "lastMessagePreview" TEXT,
  "lastMessageAt" TIMESTAMP(3),
  "unreadCount" INTEGER NOT NULL DEFAULT 0,
  "aiEnabled" BOOLEAN NOT NULL DEFAULT false,
  "humanTakeover" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "closedAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Message" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "leadId" TEXT NOT NULL,
  "senderType" "MessageSenderType" NOT NULL,
  "senderUserId" TEXT,
  "content" TEXT NOT NULL,
  "messageType" "MessageType" NOT NULL,
  "direction" "MessageDirection" NOT NULL,
  "deliveryStatus" "MessageDeliveryStatus" NOT NULL,
  "metadata" JSONB,
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Conversation_businessId_idx" ON "Conversation"("businessId");
CREATE UNIQUE INDEX "Conversation_displayId_key" ON "Conversation"("displayId");
CREATE INDEX "Conversation_businessId_leadId_idx" ON "Conversation"("businessId", "leadId");
CREATE INDEX "Conversation_businessId_assignedStaffId_idx" ON "Conversation"("businessId", "assignedStaffId");
CREATE INDEX "Conversation_businessId_status_idx" ON "Conversation"("businessId", "status");
CREATE INDEX "Conversation_businessId_priority_idx" ON "Conversation"("businessId", "priority");
CREATE INDEX "Conversation_businessId_pinned_idx" ON "Conversation"("businessId", "pinned");
CREATE INDEX "Conversation_businessId_channel_idx" ON "Conversation"("businessId", "channel");
CREATE INDEX "Conversation_businessId_lastMessageAt_idx" ON "Conversation"("businessId", "lastMessageAt");
CREATE INDEX "Conversation_businessId_deletedAt_idx" ON "Conversation"("businessId", "deletedAt");
CREATE UNIQUE INDEX "Conversation_active_businessId_leadId_channel_key" ON "Conversation"("businessId", "leadId", "channel") WHERE "deletedAt" IS NULL AND "status" <> 'CLOSED';

CREATE INDEX "Message_businessId_idx" ON "Message"("businessId");
CREATE INDEX "Message_conversationId_idx" ON "Message"("conversationId");
CREATE INDEX "Message_businessId_conversationId_idx" ON "Message"("businessId", "conversationId");
CREATE INDEX "Message_businessId_leadId_idx" ON "Message"("businessId", "leadId");
CREATE INDEX "Message_createdAt_idx" ON "Message"("createdAt");
CREATE INDEX "Message_senderType_idx" ON "Message"("senderType");
CREATE INDEX "Message_deliveryStatus_idx" ON "Message"("deliveryStatus");

ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_assignedStaffId_fkey" FOREIGN KEY ("assignedStaffId") REFERENCES "BusinessMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

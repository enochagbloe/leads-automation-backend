CREATE TYPE "CustomerMemoryCategory" AS ENUM (
  'GOAL',
  'INTERESTED_SERVICE',
  'PREFERENCE',
  'OBJECTION',
  'TIMING_STATEMENT',
  'MISSING_DETAIL',
  'UNRESOLVED_REQUEST',
  'APPOINTMENT_CONTEXT',
  'LEAD_CONTEXT',
  'LAST_CUSTOMER_ACTION',
  'LAST_STAFF_ACTION',
  'HUMAN_TAKEOVER'
);

CREATE TYPE "CustomerMemoryStatus" AS ENUM ('ACTIVE', 'RESOLVED', 'SUPERSEDED', 'NEEDS_CLARIFICATION', 'DELETED');
CREATE TYPE "CustomerMemoryTruthType" AS ENUM ('BACKEND_CONFIRMED', 'CUSTOMER_STATED', 'STAFF_CONFIRMED', 'AI_INFERRED');
CREATE TYPE "CustomerMemorySourceType" AS ENUM (
  'CUSTOMER_MESSAGE',
  'STAFF_MESSAGE',
  'AI_MESSAGE',
  'APPOINTMENT',
  'LEAD',
  'COMPLAINT',
  'SYSTEM_EVENT',
  'MANUAL_CORRECTION'
);
CREATE TYPE "CustomerMemoryMissingDetailState" AS ENUM ('MISSING', 'REQUESTED', 'PROVIDED', 'NO_LONGER_REQUIRED');
CREATE TYPE "CustomerMemoryExtractionStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

ALTER TYPE "AuditAction" ADD VALUE 'CUSTOMER_MEMORY_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'CUSTOMER_MEMORY_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'CUSTOMER_MEMORY_SUPERSEDED';
ALTER TYPE "AuditAction" ADD VALUE 'CUSTOMER_MEMORY_RESOLVED';
ALTER TYPE "AuditAction" ADD VALUE 'CUSTOMER_MEMORY_DELETED';
ALTER TYPE "AuditAction" ADD VALUE 'CUSTOMER_MEMORY_SUMMARY_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'CUSTOMER_MEMORY_EXTRACTION_FAILED';
ALTER TYPE "AuditAction" ADD VALUE 'CUSTOMER_MEMORY_CONFLICT_DETECTED';
ALTER TYPE "AuditAction" ADD VALUE 'CUSTOMER_MEMORY_MANUALLY_CORRECTED';

CREATE TABLE "CustomerMemoryProfile" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "leadId" TEXT NOT NULL,
  "conversationSummary" TEXT,
  "summaryConversationId" TEXT,
  "summaryUpdatedAt" TIMESTAMP(3),
  "lastMeaningfulActivityAt" TIMESTAMP(3),
  "lastExtractionAt" TIMESTAMP(3),
  "memoryEnabled" BOOLEAN NOT NULL DEFAULT true,
  "reconciliationRequiredAt" TIMESTAMP(3),
  "reconciliationReason" TEXT,
  "lastReconciledAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerMemoryProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CustomerMemoryItem" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "leadId" TEXT NOT NULL,
  "sourceConversationId" TEXT,
  "sourceMessageId" TEXT,
  "category" "CustomerMemoryCategory" NOT NULL,
  "memoryKey" TEXT NOT NULL,
  "valueText" TEXT NOT NULL,
  "structuredValue" JSONB,
  "status" "CustomerMemoryStatus" NOT NULL DEFAULT 'ACTIVE',
  "activeKey" TEXT,
  "truthType" "CustomerMemoryTruthType" NOT NULL,
  "sourceType" "CustomerMemorySourceType" NOT NULL,
  "confidence" DOUBLE PRECISION,
  "missingDetailState" "CustomerMemoryMissingDetailState",
  "sourceStatement" TEXT,
  "supersedesId" TEXT,
  "supersededById" TEXT,
  "correctedByMembershipId" TEXT,
  "learnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerMemoryItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CustomerMemoryExtractionJob" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "leadId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "status" "CustomerMemoryExtractionStatus" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "processingStartedAt" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "lastErrorAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerMemoryExtractionJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CustomerMemoryConversationTombstone" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "leadId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "deletedByMembershipId" TEXT,
  "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerMemoryConversationTombstone_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomerMemoryProfile_businessId_leadId_key" ON "CustomerMemoryProfile"("businessId", "leadId");
CREATE UNIQUE INDEX "CustomerMemoryProfile_leadId_key" ON "CustomerMemoryProfile"("leadId");
CREATE INDEX "CustomerMemoryProfile_businessId_updatedAt_idx" ON "CustomerMemoryProfile"("businessId", "updatedAt");
CREATE INDEX "CustomerMemoryProfile_reconciliationRequiredAt_idx" ON "CustomerMemoryProfile"("reconciliationRequiredAt");
CREATE UNIQUE INDEX "CustomerMemoryItem_businessId_leadId_category_memoryKey_activeKey_key" ON "CustomerMemoryItem"("businessId", "leadId", "category", "memoryKey", "activeKey");
CREATE INDEX "CustomerMemoryItem_businessId_leadId_status_category_idx" ON "CustomerMemoryItem"("businessId", "leadId", "status", "category");
CREATE INDEX "CustomerMemoryItem_businessId_sourceConversationId_idx" ON "CustomerMemoryItem"("businessId", "sourceConversationId");
CREATE INDEX "CustomerMemoryItem_sourceMessageId_idx" ON "CustomerMemoryItem"("sourceMessageId");
CREATE INDEX "CustomerMemoryItem_supersedesId_idx" ON "CustomerMemoryItem"("supersedesId");
CREATE INDEX "CustomerMemoryItem_supersededById_idx" ON "CustomerMemoryItem"("supersededById");
CREATE UNIQUE INDEX "CustomerMemoryExtractionJob_messageId_key" ON "CustomerMemoryExtractionJob"("messageId");
CREATE INDEX "CustomerMemoryExtractionJob_status_nextAttemptAt_idx" ON "CustomerMemoryExtractionJob"("status", "nextAttemptAt");
CREATE INDEX "CustomerMemoryExtractionJob_businessId_leadId_createdAt_idx" ON "CustomerMemoryExtractionJob"("businessId", "leadId", "createdAt");
CREATE UNIQUE INDEX "CustomerMemoryConversationTombstone_conversationId_key" ON "CustomerMemoryConversationTombstone"("conversationId");
CREATE UNIQUE INDEX "CustomerMemoryConversationTombstone_businessId_leadId_conversationId_key" ON "CustomerMemoryConversationTombstone"("businessId", "leadId", "conversationId");
CREATE INDEX "CustomerMemoryConversationTombstone_businessId_leadId_deletedAt_idx" ON "CustomerMemoryConversationTombstone"("businessId", "leadId", "deletedAt");

ALTER TABLE "CustomerMemoryProfile" ADD CONSTRAINT "CustomerMemoryProfile_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerMemoryProfile" ADD CONSTRAINT "CustomerMemoryProfile_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerMemoryItem" ADD CONSTRAINT "CustomerMemoryItem_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerMemoryItem" ADD CONSTRAINT "CustomerMemoryItem_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerMemoryItem" ADD CONSTRAINT "CustomerMemoryItem_sourceConversationId_fkey" FOREIGN KEY ("sourceConversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CustomerMemoryItem" ADD CONSTRAINT "CustomerMemoryItem_sourceMessageId_fkey" FOREIGN KEY ("sourceMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CustomerMemoryExtractionJob" ADD CONSTRAINT "CustomerMemoryExtractionJob_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerMemoryExtractionJob" ADD CONSTRAINT "CustomerMemoryExtractionJob_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerMemoryExtractionJob" ADD CONSTRAINT "CustomerMemoryExtractionJob_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerMemoryExtractionJob" ADD CONSTRAINT "CustomerMemoryExtractionJob_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerMemoryConversationTombstone" ADD CONSTRAINT "CustomerMemoryConversationTombstone_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerMemoryConversationTombstone" ADD CONSTRAINT "CustomerMemoryConversationTombstone_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerMemoryConversationTombstone" ADD CONSTRAINT "CustomerMemoryConversationTombstone_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

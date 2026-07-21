CREATE TYPE "CustomerMemorySuppressionMode" AS ENUM ('SOURCE_OCCURRENCE', 'MEMORY_KEY');

CREATE TABLE "CustomerMemoryItemTombstone" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "leadId" TEXT NOT NULL,
  "deletedMemoryId" TEXT NOT NULL,
  "category" "CustomerMemoryCategory" NOT NULL,
  "memoryKey" TEXT NOT NULL,
  "mode" "CustomerMemorySuppressionMode" NOT NULL,
  "suppressionKey" TEXT NOT NULL,
  "sourceConversationId" TEXT,
  "sourceMessageId" TEXT,
  "suppressThrough" TIMESTAMP(3),
  "deletedByMembershipId" TEXT,
  "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CustomerMemoryItemTombstone_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomerMemoryItemTombstone_businessId_leadId_suppressionKey_key"
  ON "CustomerMemoryItemTombstone"("businessId", "leadId", "suppressionKey");
CREATE INDEX "CustomerMemoryItemTombstone_businessId_leadId_category_memoryKey_mode_idx"
  ON "CustomerMemoryItemTombstone"("businessId", "leadId", "category", "memoryKey", "mode");
CREATE INDEX "CustomerMemoryItemTombstone_sourceMessageId_idx"
  ON "CustomerMemoryItemTombstone"("sourceMessageId");
CREATE INDEX "CustomerMemoryItemTombstone_deletedAt_idx"
  ON "CustomerMemoryItemTombstone"("deletedAt");

ALTER TABLE "CustomerMemoryItemTombstone"
  ADD CONSTRAINT "CustomerMemoryItemTombstone_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerMemoryItemTombstone"
  ADD CONSTRAINT "CustomerMemoryItemTombstone_leadId_fkey"
  FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

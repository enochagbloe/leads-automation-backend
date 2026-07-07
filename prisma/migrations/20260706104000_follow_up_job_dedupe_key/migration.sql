ALTER TABLE "FollowUpJob"
  ADD COLUMN "dedupeKey" TEXT;

DROP INDEX IF EXISTS "FollowUpJob_businessId_ruleId_conversationId_contextType_relatedMessageId_key";

CREATE INDEX "FollowUpJob_businessId_dedupeKey_idx"
  ON "FollowUpJob"("businessId", "dedupeKey");

CREATE UNIQUE INDEX "FollowUpJob_businessId_dedupeKey_scheduled_key"
  ON "FollowUpJob"("businessId", "dedupeKey")
  WHERE "status" = 'SCHEDULED' AND "dedupeKey" IS NOT NULL;

ALTER TABLE "PremiumFollowUpExecution"
  ADD COLUMN "continuationStatus" TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN "continuationJobId" TEXT,
  ADD COLUMN "continuationReason" TEXT,
  ADD COLUMN "continuationAttemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "continuationProcessingStartedAt" TIMESTAMP(3),
  ADD COLUMN "continuationNextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "continuationCompletedAt" TIMESTAMP(3);

CREATE INDEX "PremiumFollowUpExecution_businessId_continuationStatus_continuationNextAttemptAt_idx"
  ON "PremiumFollowUpExecution"("businessId", "continuationStatus", "continuationNextAttemptAt");

DROP INDEX IF EXISTS "FollowUpJob_businessId_dedupeKey_scheduled_key";

CREATE UNIQUE INDEX "FollowUpJob_businessId_dedupeKey_active_key"
  ON "FollowUpJob"("businessId", "dedupeKey")
  WHERE "status" IN ('SCHEDULED', 'PROCESSING') AND "dedupeKey" IS NOT NULL;

UPDATE "PremiumFollowUpExecution"
SET
  "continuationStatus" = 'PENDING',
  "continuationReason" = 'PREMIUM_NEXT_STAGE_BACKFILL_REQUIRED',
  "continuationNextAttemptAt" = CURRENT_TIMESTAMP
WHERE
  "executionStatus" = 'SENT'
  AND "sequenceStage" <> 'FINAL_POLITE_FOLLOW_UP'
  AND "finalDecision" <> 'ESCALATE_TO_STAFF'
  AND "outboundMessageId" IS NOT NULL;

CREATE TYPE "AiUsageReservationStatus" AS ENUM (
  'RESERVED',
  'SETTLED',
  'RELEASED',
  'RECONCILIATION_REQUIRED'
);

CREATE TABLE "AiUsageReservation" (
  "id" TEXT NOT NULL,
  "businessAccountId" TEXT NOT NULL,
  "accountUsageId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "feature" TEXT NOT NULL,
  "processingBatchId" TEXT,
  "status" "AiUsageReservationStatus" NOT NULL DEFAULT 'RESERVED',
  "reservedRequests" INTEGER NOT NULL,
  "actualRequests" INTEGER,
  "actualTokens" INTEGER,
  "providerAttemptStartedAt" TIMESTAMP(3),
  "providerRequestId" TEXT,
  "failureCode" TEXT,
  "settledAt" TIMESTAMP(3),
  "releasedAt" TIMESTAMP(3),
  "reconciliationRequiredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AiUsageReservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiUsageReservation_idempotencyKey_key"
  ON "AiUsageReservation"("idempotencyKey");
CREATE INDEX "AiUsageReservation_businessAccountId_status_createdAt_idx"
  ON "AiUsageReservation"("businessAccountId", "status", "createdAt");
CREATE INDEX "AiUsageReservation_processingBatchId_status_idx"
  ON "AiUsageReservation"("processingBatchId", "status");
CREATE INDEX "AiUsageReservation_accountUsageId_idx"
  ON "AiUsageReservation"("accountUsageId");

ALTER TABLE "AiUsageReservation"
  ADD CONSTRAINT "AiUsageReservation_businessAccountId_fkey"
  FOREIGN KEY ("businessAccountId") REFERENCES "BusinessAccount"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiUsageReservation"
  ADD CONSTRAINT "AiUsageReservation_accountUsageId_fkey"
  FOREIGN KEY ("accountUsageId") REFERENCES "AccountUsageRecord"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

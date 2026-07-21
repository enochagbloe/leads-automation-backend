CREATE TYPE "CustomerMemorySensitiveDataPolicy" AS ENUM (
  'ALLOWED',
  'REDACT',
  'DO_NOT_STORE',
  'REQUIRES_EXPLICIT_BUSINESS_CONFIGURATION'
);

ALTER TABLE "CustomerMemoryItem"
  ADD COLUMN "sensitiveDataPolicy" "CustomerMemorySensitiveDataPolicy" NOT NULL DEFAULT 'ALLOWED',
  ADD COLUMN "sensitiveDataPolicyVersion" TEXT,
  ADD COLUMN "retentionExpiresAt" TIMESTAMP(3);

CREATE INDEX "CustomerMemoryItem_retentionExpiresAt_status_idx"
  ON "CustomerMemoryItem"("retentionExpiresAt", "status");

CREATE INDEX "CustomerMemoryItem_sensitiveDataPolicyVersion_idx"
  ON "CustomerMemoryItem"("sensitiveDataPolicyVersion");

DROP INDEX IF EXISTS "WhatsAppIntegration_provider_phoneNumberId_key";
DROP INDEX IF EXISTS "WhatsAppIntegration_businessId_provider_key";

ALTER TABLE "WhatsAppIntegration"
  ADD COLUMN "businessAccountId" TEXT,
  ADD COLUMN "automationEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "deactivatedAt" TIMESTAMP(3),
  ADD COLUMN "lastHealthCheckAt" TIMESTAMP(3),
  ADD COLUMN "lastErrorCode" TEXT,
  ADD COLUMN "lastErrorMessage" TEXT,
  ADD COLUMN "metadata" JSONB;

UPDATE "WhatsAppIntegration"
SET
  "automationEnabled" = CASE WHEN "status" IN ('CONNECTED', 'MOCK_CONNECTED') THEN true ELSE false END,
  "deactivatedAt" = CASE WHEN "status" = 'DISCONNECTED' THEN COALESCE("disconnectedAt", "updatedAt") ELSE NULL END;

CREATE INDEX "WhatsAppIntegration_provider_phoneNumberId_idx"
  ON "WhatsAppIntegration"("provider", "phoneNumberId");
CREATE INDEX "WhatsAppIntegration_phoneNumberId_idx"
  ON "WhatsAppIntegration"("phoneNumberId");
CREATE INDEX "WhatsAppIntegration_businessId_createdAt_idx"
  ON "WhatsAppIntegration"("businessId", "createdAt");

CREATE UNIQUE INDEX "WhatsAppIntegration_one_active_per_business"
  ON "WhatsAppIntegration"("businessId")
  WHERE "status" IN ('CONNECTING', 'CONNECTED', 'MOCK_CONNECTED');

CREATE UNIQUE INDEX "WhatsAppIntegration_one_active_phone_number"
  ON "WhatsAppIntegration"("phoneNumberId")
  WHERE "status" IN ('CONNECTING', 'CONNECTED', 'MOCK_CONNECTED');

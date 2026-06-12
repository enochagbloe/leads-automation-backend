-- CreateEnum
CREATE TYPE "WhatsAppProvider" AS ENUM ('META');

-- CreateEnum
CREATE TYPE "WhatsAppIntegrationStatus" AS ENUM ('NOT_CONNECTED', 'MOCK_CONNECTED', 'CONNECTED', 'DISCONNECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "WebhookProvider" AS ENUM ('META_WHATSAPP');

-- CreateEnum
CREATE TYPE "WebhookEventType" AS ENUM ('INBOUND_TEXT', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "WebhookProcessingStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'DUPLICATE', 'FAILED', 'LIMIT_BLOCKED');

-- AlterTable
ALTER TABLE "Message" ADD COLUMN "provider" TEXT,
ADD COLUMN "providerMessageId" TEXT;

-- CreateTable
CREATE TABLE "WhatsAppIntegration" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "provider" "WhatsAppProvider" NOT NULL DEFAULT 'META',
    "phoneNumberId" TEXT NOT NULL,
    "displayPhoneNumber" TEXT,
    "wabaId" TEXT,
    "accessTokenEncrypted" TEXT,
    "verifyTokenHash" TEXT,
    "appSecretHash" TEXT,
    "status" "WhatsAppIntegrationStatus" NOT NULL DEFAULT 'NOT_CONNECTED',
    "connectedAt" TIMESTAMP(3),
    "disconnectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEventLog" (
    "id" TEXT NOT NULL,
    "provider" "WebhookProvider" NOT NULL,
    "eventType" "WebhookEventType" NOT NULL,
    "businessId" TEXT,
    "providerMessageId" TEXT,
    "payload" JSONB NOT NULL,
    "processingStatus" "WebhookProcessingStatus" NOT NULL DEFAULT 'RECEIVED',
    "errorMessage" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEventLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Message_businessId_provider_providerMessageId_idx" ON "Message"("businessId", "provider", "providerMessageId");

-- Meta may retry the same message concurrently. This partial unique index is the final idempotency boundary.
CREATE UNIQUE INDEX "Message_businessId_provider_providerMessageId_key"
ON "Message"("businessId", "provider", "providerMessageId")
WHERE "providerMessageId" IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppIntegration_provider_phoneNumberId_key" ON "WhatsAppIntegration"("provider", "phoneNumberId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppIntegration_businessId_provider_key" ON "WhatsAppIntegration"("businessId", "provider");

-- CreateIndex
CREATE INDEX "WhatsAppIntegration_businessId_status_idx" ON "WhatsAppIntegration"("businessId", "status");

-- CreateIndex
CREATE INDEX "WebhookEventLog_provider_providerMessageId_idx" ON "WebhookEventLog"("provider", "providerMessageId");

-- CreateIndex
CREATE INDEX "WebhookEventLog_businessId_receivedAt_idx" ON "WebhookEventLog"("businessId", "receivedAt");

-- CreateIndex
CREATE INDEX "WebhookEventLog_processingStatus_receivedAt_idx" ON "WebhookEventLog"("processingStatus", "receivedAt");

-- AddForeignKey
ALTER TABLE "WhatsAppIntegration" ADD CONSTRAINT "WhatsAppIntegration_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEventLog" ADD CONSTRAINT "WebhookEventLog_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE SET NULL ON UPDATE CASCADE;

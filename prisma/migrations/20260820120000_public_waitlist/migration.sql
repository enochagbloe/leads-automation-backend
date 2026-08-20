CREATE TYPE "WaitlistStatus" AS ENUM ('PENDING', 'CONFIRMED', 'UNSUBSCRIBED');

CREATE TABLE "WaitlistEntry" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "businessName" TEXT,
    "businessType" TEXT,
    "whatsapp" TEXT,
    "problem" TEXT,
    "source" TEXT,
    "status" "WaitlistStatus" NOT NULL DEFAULT 'PENDING',
    "marketingConsent" BOOLEAN NOT NULL DEFAULT false,
    "confirmationTokenHash" TEXT,
    "confirmationExpiresAt" TIMESTAMP(3),
    "confirmationRequestedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WaitlistEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WaitlistEntry_email_key" ON "WaitlistEntry"("email");
CREATE UNIQUE INDEX "WaitlistEntry_confirmationTokenHash_key" ON "WaitlistEntry"("confirmationTokenHash");
CREATE INDEX "WaitlistEntry_status_createdAt_idx" ON "WaitlistEntry"("status", "createdAt");
CREATE INDEX "WaitlistEntry_marketingConsent_status_idx" ON "WaitlistEntry"("marketingConsent", "status");

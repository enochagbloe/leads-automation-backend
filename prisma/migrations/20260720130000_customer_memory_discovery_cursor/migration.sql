CREATE TABLE "CustomerMemoryDiscoveryCursor" (
  "businessId" TEXT NOT NULL,
  "lastMessageCreatedAt" TIMESTAMP(3) NOT NULL,
  "lastMessageId" TEXT NOT NULL DEFAULT '',
  "lastScannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastProcessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerMemoryDiscoveryCursor_pkey" PRIMARY KEY ("businessId")
);

CREATE INDEX "CustomerMemoryDiscoveryCursor_lastScannedAt_businessId_idx"
  ON "CustomerMemoryDiscoveryCursor"("lastScannedAt", "businessId");

CREATE INDEX "CustomerMemoryDiscoveryCursor_lastProcessedAt_businessId_idx"
  ON "CustomerMemoryDiscoveryCursor"("lastProcessedAt", "businessId");

ALTER TABLE "CustomerMemoryDiscoveryCursor"
  ADD CONSTRAINT "CustomerMemoryDiscoveryCursor_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

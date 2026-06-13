ALTER TABLE "Business"
  ADD COLUMN "description" TEXT,
  ADD COLUMN "country" TEXT,
  ADD COLUMN "city" TEXT,
  ADD COLUMN "address" TEXT,
  ADD COLUMN "serviceArea" TEXT,
  ADD COLUMN "handoffEmail" TEXT,
  ADD COLUMN "handoffPhone" TEXT;

CREATE TABLE "Service" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "price" DECIMAL(12,2),
  "pricingNote" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BusinessAvailability" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "dayOfWeek" INTEGER NOT NULL,
  "openTime" TEXT NOT NULL,
  "closeTime" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BusinessAvailability_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BusinessPolicy" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "BusinessPolicy_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Service_businessId_isActive_idx" ON "Service"("businessId", "isActive");
CREATE INDEX "Service_businessId_deletedAt_idx" ON "Service"("businessId", "deletedAt");
CREATE UNIQUE INDEX "BusinessAvailability_businessId_dayOfWeek_key" ON "BusinessAvailability"("businessId", "dayOfWeek");
CREATE INDEX "BusinessAvailability_businessId_isActive_idx" ON "BusinessAvailability"("businessId", "isActive");
CREATE INDEX "BusinessPolicy_businessId_isActive_idx" ON "BusinessPolicy"("businessId", "isActive");
CREATE INDEX "BusinessPolicy_businessId_deletedAt_idx" ON "BusinessPolicy"("businessId", "deletedAt");

ALTER TABLE "Service" ADD CONSTRAINT "Service_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BusinessAvailability" ADD CONSTRAINT "BusinessAvailability_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BusinessPolicy" ADD CONSTRAINT "BusinessPolicy_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

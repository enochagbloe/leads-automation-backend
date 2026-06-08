CREATE TYPE "LeadSource" AS ENUM ('MANUAL', 'WHATSAPP', 'WEBSITE', 'REFERRAL', 'INSTAGRAM', 'FACEBOOK', 'OTHER');
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'CONTACTED', 'INTERESTED', 'QUALIFIED', 'APPOINTMENT_SCHEDULED', 'WON', 'LOST');
CREATE TYPE "LeadActivityAction" AS ENUM ('LEAD_CREATED', 'LEAD_UPDATED', 'LEAD_ASSIGNED', 'LEAD_STATUS_CHANGED', 'LEAD_NOTE_UPDATED', 'LEAD_DELETED');

ALTER TYPE "AuditAction" ADD VALUE 'LEAD_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'LEAD_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'LEAD_ASSIGNED';
ALTER TYPE "AuditAction" ADD VALUE 'LEAD_STATUS_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'LEAD_DELETED';

CREATE TABLE "Lead" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "fullName" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "email" TEXT,
  "source" "LeadSource" NOT NULL,
  "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
  "assignedStaffId" TEXT,
  "notes" TEXT,
  "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "customFields" JSONB,
  "lastContactedAt" TIMESTAMP(3),
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LeadActivity" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "leadId" TEXT NOT NULL,
  "actorUserId" TEXT,
  "action" "LeadActivityAction" NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LeadActivity_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Lead_businessId_idx" ON "Lead"("businessId");
CREATE INDEX "Lead_businessId_phone_idx" ON "Lead"("businessId", "phone");
CREATE UNIQUE INDEX "Lead_active_businessId_phone_key" ON "Lead"("businessId", "phone") WHERE "deletedAt" IS NULL;
CREATE INDEX "Lead_businessId_status_idx" ON "Lead"("businessId", "status");
CREATE INDEX "Lead_businessId_source_idx" ON "Lead"("businessId", "source");
CREATE INDEX "Lead_businessId_assignedStaffId_idx" ON "Lead"("businessId", "assignedStaffId");
CREATE INDEX "Lead_businessId_createdAt_idx" ON "Lead"("businessId", "createdAt");
CREATE INDEX "Lead_businessId_deletedAt_idx" ON "Lead"("businessId", "deletedAt");
CREATE INDEX "LeadActivity_businessId_leadId_createdAt_idx" ON "LeadActivity"("businessId", "leadId", "createdAt");
CREATE INDEX "LeadActivity_actorUserId_createdAt_idx" ON "LeadActivity"("actorUserId", "createdAt");

ALTER TABLE "Lead" ADD CONSTRAINT "Lead_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_assignedStaffId_fkey" FOREIGN KEY ("assignedStaffId") REFERENCES "BusinessMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LeadActivity" ADD CONSTRAINT "LeadActivity_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeadActivity" ADD CONSTRAINT "LeadActivity_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeadActivity" ADD CONSTRAINT "LeadActivity_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

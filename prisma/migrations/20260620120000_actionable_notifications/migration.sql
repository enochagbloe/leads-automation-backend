CREATE TYPE "BusinessNotificationEntityType" AS ENUM (
  'APPOINTMENT',
  'CONVERSATION',
  'LEAD',
  'BUSINESS'
);

ALTER TYPE "BusinessNotificationType" ADD VALUE 'INFO' BEFORE 'APPOINTMENT_NEEDS_CONFIRMATION';
ALTER TYPE "BusinessNotificationType" ADD VALUE 'APPOINTMENT_NEEDS_REVIEW' AFTER 'APPOINTMENT_OUTCOME_REQUIRED';
ALTER TYPE "BusinessNotificationType" ADD VALUE 'APPOINTMENT_CONFIRMED' AFTER 'APPOINTMENT_ASSIGNED';
ALTER TYPE "BusinessNotificationType" ADD VALUE 'AI_HUMAN_REVIEW_REQUIRED' AFTER 'APPOINTMENT_AUTO_CONFIRMED';
ALTER TYPE "BusinessNotificationType" ADD VALUE 'CONVERSATION_HANDOFF_REQUIRED' AFTER 'AI_HUMAN_REVIEW_REQUIRED';

ALTER TYPE "BusinessNotificationPriority" ADD VALUE 'URGENT' AFTER 'HIGH';

ALTER TYPE "BusinessNotificationStatus" ADD VALUE 'ACTIONED' AFTER 'READ';
ALTER TYPE "BusinessNotificationStatus" ADD VALUE 'DISMISSED' AFTER 'ARCHIVED';

ALTER TYPE "AuditAction" ADD VALUE 'NOTIFICATION_CREATED' AFTER 'APPOINTMENT_RESCHEDULE_BLOCKED_PAST';
ALTER TYPE "AuditAction" ADD VALUE 'NOTIFICATION_READ' AFTER 'NOTIFICATION_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'NOTIFICATION_DISMISSED' AFTER 'NOTIFICATION_READ';
ALTER TYPE "AuditAction" ADD VALUE 'NOTIFICATION_ACTIONED' AFTER 'NOTIFICATION_DISMISSED';

ALTER TABLE "BusinessNotification" ADD COLUMN "businessAccountId" TEXT;
ALTER TABLE "BusinessNotification" ADD COLUMN "entityType" "BusinessNotificationEntityType";
ALTER TABLE "BusinessNotification" ADD COLUMN "entityId" TEXT;
ALTER TABLE "BusinessNotification" ADD COLUMN "actions" JSONB;
ALTER TABLE "BusinessNotification" ADD COLUMN "actionedAt" TIMESTAMP(3);
ALTER TABLE "BusinessNotification" ADD COLUMN "dismissedAt" TIMESTAMP(3);
ALTER TABLE "BusinessNotification" ADD COLUMN "expiresAt" TIMESTAMP(3);

UPDATE "BusinessNotification" n
SET "businessAccountId" = b."businessAccountId"
FROM "Business" b
WHERE n."businessId" = b."id";

UPDATE "BusinessNotification"
SET
  "entityType" = 'APPOINTMENT',
  "entityId" = "metadata"->>'appointmentId'
WHERE "metadata" ? 'appointmentId';

ALTER TABLE "BusinessNotification" ADD CONSTRAINT "BusinessNotification_businessAccountId_fkey"
  FOREIGN KEY ("businessAccountId") REFERENCES "BusinessAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "BusinessNotification_businessId_entityType_entityId_idx" ON "BusinessNotification"("businessId", "entityType", "entityId");
CREATE INDEX "BusinessNotification_businessAccountId_createdAt_idx" ON "BusinessNotification"("businessAccountId", "createdAt");

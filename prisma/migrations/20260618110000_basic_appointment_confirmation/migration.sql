CREATE TYPE "AppointmentConfirmationMode" AS ENUM (
  'MANUAL_CONFIRMATION_REQUIRED',
  'AUTO_CONFIRM_WHEN_STAFF_ASSIGNED',
  'AUTO_CONFIRM_SAFE_BOOKINGS'
);

CREATE TYPE "BusinessNotificationType" AS ENUM (
  'APPOINTMENT_NEEDS_CONFIRMATION'
);

CREATE TYPE "BusinessNotificationPriority" AS ENUM (
  'LOW',
  'NORMAL',
  'HIGH'
);

CREATE TYPE "BusinessNotificationStatus" AS ENUM (
  'UNREAD',
  'READ',
  'ARCHIVED'
);

ALTER TYPE "AppointmentHumanConfirmationReason" ADD VALUE 'BUSINESS_CONFIRMATION_REQUIRED' BEFORE 'LOCATION_REQUIRED';
ALTER TYPE "AppointmentActivityType" ADD VALUE 'APPOINTMENT_CONFIRMED' AFTER 'APPOINTMENT_CANCELLED';
ALTER TYPE "AppointmentActivityType" ADD VALUE 'APPOINTMENT_CONFIRMATION_REQUIRED' AFTER 'APPOINTMENT_ASSIGNED';

ALTER TYPE "AuditAction" ADD VALUE 'APPOINTMENT_CONFIRMATION_REQUIRED' AFTER 'APPOINTMENT_CANCELLED';
ALTER TYPE "AuditAction" ADD VALUE 'APPOINTMENT_CONFIRMED' AFTER 'APPOINTMENT_CONFIRMATION_REQUIRED';
ALTER TYPE "AuditAction" ADD VALUE 'APPOINTMENT_NOTIFICATION_CREATED' AFTER 'APPOINTMENT_ASSIGNED';

ALTER TABLE "Business"
  ADD COLUMN "appointmentConfirmationMode" "AppointmentConfirmationMode" NOT NULL DEFAULT 'MANUAL_CONFIRMATION_REQUIRED';

ALTER TABLE "Appointment" ADD COLUMN "confirmedById" TEXT;
ALTER TABLE "Appointment" ADD COLUMN "confirmedAt" TIMESTAMP(3);

ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_confirmedById_fkey"
  FOREIGN KEY ("confirmedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "BusinessNotification" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "recipientMembershipId" TEXT NOT NULL,
  "recipientUserId" TEXT NOT NULL,
  "createdById" TEXT,
  "type" "BusinessNotificationType" NOT NULL,
  "priority" "BusinessNotificationPriority" NOT NULL DEFAULT 'NORMAL',
  "status" "BusinessNotificationStatus" NOT NULL DEFAULT 'UNREAD',
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "metadata" JSONB,
  "readAt" TIMESTAMP(3),
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BusinessNotification_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "BusinessNotification" ADD CONSTRAINT "BusinessNotification_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BusinessNotification" ADD CONSTRAINT "BusinessNotification_recipientMembershipId_fkey"
  FOREIGN KEY ("recipientMembershipId") REFERENCES "BusinessMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BusinessNotification" ADD CONSTRAINT "BusinessNotification_recipientUserId_fkey"
  FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BusinessNotification" ADD CONSTRAINT "BusinessNotification_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "BusinessNotification_businessId_status_createdAt_idx" ON "BusinessNotification"("businessId", "status", "createdAt");
CREATE INDEX "BusinessNotification_recipientMembershipId_status_createdAt_idx" ON "BusinessNotification"("recipientMembershipId", "status", "createdAt");
CREATE INDEX "BusinessNotification_recipientUserId_status_createdAt_idx" ON "BusinessNotification"("recipientUserId", "status", "createdAt");
CREATE INDEX "BusinessNotification_businessId_type_createdAt_idx" ON "BusinessNotification"("businessId", "type", "createdAt");

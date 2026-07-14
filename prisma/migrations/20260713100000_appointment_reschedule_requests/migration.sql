CREATE TYPE "AppointmentRescheduleRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED', 'CANCELLED');

CREATE TYPE "AppointmentRescheduleRequestedBy" AS ENUM ('CUSTOMER', 'STAFF', 'AI');

ALTER TYPE "AppointmentActivityType" ADD VALUE IF NOT EXISTS 'APPOINTMENT_RESCHEDULE_REQUESTED';
ALTER TYPE "AppointmentActivityType" ADD VALUE IF NOT EXISTS 'APPOINTMENT_RESCHEDULE_REQUEST_APPROVED';
ALTER TYPE "AppointmentActivityType" ADD VALUE IF NOT EXISTS 'APPOINTMENT_RESCHEDULE_REQUEST_DECLINED';

ALTER TYPE "BusinessNotificationType" ADD VALUE IF NOT EXISTS 'APPOINTMENT_RESCHEDULE_REQUESTED';

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'APPOINTMENT_RESCHEDULE_REQUESTED_BY_CUSTOMER';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'APPOINTMENT_RESCHEDULE_REQUEST_ACKNOWLEDGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'APPOINTMENT_RESCHEDULE_APPROVED_BY_TEAM';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'APPOINTMENT_RESCHEDULE_DECLINED_BY_TEAM';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'APPOINTMENT_CUSTOMER_RESCHEDULE_MESSAGE_SENT';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'APPOINTMENT_CUSTOMER_RESCHEDULE_MESSAGE_FAILED';

CREATE TABLE "AppointmentRescheduleRequest" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "appointmentId" TEXT NOT NULL,
  "conversationId" TEXT,
  "leadId" TEXT,
  "requestedBy" "AppointmentRescheduleRequestedBy" NOT NULL DEFAULT 'CUSTOMER',
  "requestedStartTime" TIMESTAMP(3),
  "requestedEndTime" TIMESTAMP(3),
  "requestedTimezone" TEXT,
  "requestedDateText" TEXT,
  "reason" TEXT,
  "status" "AppointmentRescheduleRequestStatus" NOT NULL DEFAULT 'PENDING',
  "previousAppointmentStatus" "AppointmentStatus",
  "approvedByMembershipId" TEXT,
  "declinedByMembershipId" TEXT,
  "declineReason" TEXT,
  "alternativeTimes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "customerAcknowledgementSentAt" TIMESTAMP(3),
  "customerAcknowledgementMessageId" TEXT,
  "customerApprovedMessageSentAt" TIMESTAMP(3),
  "customerApprovedMessageId" TEXT,
  "customerDeclinedMessageSentAt" TIMESTAMP(3),
  "customerDeclinedMessageId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "approvedAt" TIMESTAMP(3),
  "declinedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),

  CONSTRAINT "AppointmentRescheduleRequest_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AppointmentRescheduleRequest"
  ADD CONSTRAINT "AppointmentRescheduleRequest_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AppointmentRescheduleRequest"
  ADD CONSTRAINT "AppointmentRescheduleRequest_appointmentId_fkey"
  FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AppointmentRescheduleRequest"
  ADD CONSTRAINT "AppointmentRescheduleRequest_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AppointmentRescheduleRequest"
  ADD CONSTRAINT "AppointmentRescheduleRequest_leadId_fkey"
  FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AppointmentRescheduleRequest"
  ADD CONSTRAINT "AppointmentRescheduleRequest_approvedByMembershipId_fkey"
  FOREIGN KEY ("approvedByMembershipId") REFERENCES "BusinessMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AppointmentRescheduleRequest"
  ADD CONSTRAINT "AppointmentRescheduleRequest_declinedByMembershipId_fkey"
  FOREIGN KEY ("declinedByMembershipId") REFERENCES "BusinessMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "AppointmentRescheduleRequest_businessId_appointmentId_status_idx"
  ON "AppointmentRescheduleRequest"("businessId", "appointmentId", "status");

CREATE INDEX "AppointmentRescheduleRequest_businessId_conversationId_idx"
  ON "AppointmentRescheduleRequest"("businessId", "conversationId");

CREATE INDEX "AppointmentRescheduleRequest_businessId_leadId_idx"
  ON "AppointmentRescheduleRequest"("businessId", "leadId");

CREATE INDEX "AppointmentRescheduleRequest_businessId_status_createdAt_idx"
  ON "AppointmentRescheduleRequest"("businessId", "status", "createdAt");

-- Create appointment foundation enums.
CREATE TYPE "AppointmentStatus" AS ENUM (
  'PENDING_CONFIRMATION',
  'CONFIRMED',
  'NEEDS_HUMAN_CONFIRMATION',
  'RESCHEDULE_REQUESTED',
  'RESCHEDULED',
  'CANCELLED',
  'COMPLETED',
  'NO_SHOW'
);

CREATE TYPE "AppointmentSource" AS ENUM (
  'MANUAL',
  'CONVERSATION',
  'AI_ASSISTED',
  'AI_CREATED',
  'CUSTOMER_REQUESTED'
);

CREATE TYPE "AppointmentLocationType" AS ENUM (
  'BUSINESS_LOCATION',
  'CUSTOMER_LOCATION',
  'ONLINE',
  'PHONE_CALL',
  'TO_BE_CONFIRMED'
);

CREATE TYPE "AppointmentLocationStatus" AS ENUM (
  'CONFIRMED',
  'NEEDS_CONFIRMATION',
  'NOT_REQUIRED'
);

CREATE TYPE "AppointmentHumanConfirmationReason" AS ENUM (
  'LOCATION_REQUIRED',
  'PAYMENT_REQUIRED',
  'STAFF_REQUIRED',
  'SPECIAL_REQUEST',
  'POLICY_EXCEPTION',
  'AVAILABILITY_CONFLICT',
  'OTHER'
);

CREATE TYPE "AppointmentActivityType" AS ENUM (
  'CREATED',
  'UPDATED',
  'RESCHEDULED',
  'CANCELLED',
  'COMPLETED',
  'NO_SHOW',
  'STAFF_ASSIGNED',
  'HUMAN_CONFIRMATION_REQUIRED',
  'STATUS_CHANGED'
);

ALTER TYPE "LeadActivityAction" ADD VALUE 'APPOINTMENT_CREATED';
ALTER TYPE "LeadActivityAction" ADD VALUE 'APPOINTMENT_UPDATED';
ALTER TYPE "LeadActivityAction" ADD VALUE 'APPOINTMENT_RESCHEDULED';
ALTER TYPE "LeadActivityAction" ADD VALUE 'APPOINTMENT_CANCELLED';
ALTER TYPE "LeadActivityAction" ADD VALUE 'APPOINTMENT_COMPLETED';
ALTER TYPE "LeadActivityAction" ADD VALUE 'APPOINTMENT_NO_SHOW';
ALTER TYPE "LeadActivityAction" ADD VALUE 'APPOINTMENT_ASSIGNED';

ALTER TYPE "AuditAction" ADD VALUE 'APPOINTMENT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'APPOINTMENT_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'APPOINTMENT_RESCHEDULED';
ALTER TYPE "AuditAction" ADD VALUE 'APPOINTMENT_CANCELLED';
ALTER TYPE "AuditAction" ADD VALUE 'APPOINTMENT_COMPLETED';
ALTER TYPE "AuditAction" ADD VALUE 'APPOINTMENT_NO_SHOW';
ALTER TYPE "AuditAction" ADD VALUE 'APPOINTMENT_ASSIGNED';

-- Create appointment records.
CREATE TABLE "Appointment" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "businessAccountId" TEXT,
  "leadId" TEXT,
  "conversationId" TEXT,
  "serviceId" TEXT,
  "assignedStaffId" TEXT,
  "customerName" TEXT,
  "customerPhone" TEXT,
  "customerEmail" TEXT,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "notes" TEXT,
  "appointmentDate" TIMESTAMP(3) NOT NULL,
  "startTime" TIMESTAMP(3) NOT NULL,
  "endTime" TIMESTAMP(3) NOT NULL,
  "timezone" TEXT NOT NULL,
  "status" "AppointmentStatus" NOT NULL DEFAULT 'CONFIRMED',
  "source" "AppointmentSource" NOT NULL DEFAULT 'MANUAL',
  "locationType" "AppointmentLocationType" NOT NULL DEFAULT 'TO_BE_CONFIRMED',
  "location" TEXT,
  "locationStatus" "AppointmentLocationStatus" NOT NULL DEFAULT 'NEEDS_CONFIRMATION',
  "humanConfirmationRequired" BOOLEAN NOT NULL DEFAULT false,
  "humanConfirmationReason" "AppointmentHumanConfirmationReason",
  "cancellationReason" TEXT,
  "rescheduleReason" TEXT,
  "createdById" TEXT,
  "updatedById" TEXT,
  "cancelledById" TEXT,
  "completedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "cancelledAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),

  CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AppointmentActivity" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "appointmentId" TEXT NOT NULL,
  "actorUserId" TEXT,
  "actorMembershipId" TEXT,
  "type" "AppointmentActivityType" NOT NULL,
  "message" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AppointmentActivity_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_businessAccountId_fkey" FOREIGN KEY ("businessAccountId") REFERENCES "BusinessAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_assignedStaffId_fkey" FOREIGN KEY ("assignedStaffId") REFERENCES "BusinessMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AppointmentActivity" ADD CONSTRAINT "AppointmentActivity_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AppointmentActivity" ADD CONSTRAINT "AppointmentActivity_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AppointmentActivity" ADD CONSTRAINT "AppointmentActivity_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AppointmentActivity" ADD CONSTRAINT "AppointmentActivity_actorMembershipId_fkey" FOREIGN KEY ("actorMembershipId") REFERENCES "BusinessMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Appointment_businessId_idx" ON "Appointment"("businessId");
CREATE INDEX "Appointment_businessAccountId_idx" ON "Appointment"("businessAccountId");
CREATE INDEX "Appointment_businessId_leadId_idx" ON "Appointment"("businessId", "leadId");
CREATE INDEX "Appointment_businessId_conversationId_idx" ON "Appointment"("businessId", "conversationId");
CREATE INDEX "Appointment_businessId_serviceId_idx" ON "Appointment"("businessId", "serviceId");
CREATE INDEX "Appointment_businessId_assignedStaffId_idx" ON "Appointment"("businessId", "assignedStaffId");
CREATE INDEX "Appointment_businessId_status_idx" ON "Appointment"("businessId", "status");
CREATE INDEX "Appointment_businessId_source_idx" ON "Appointment"("businessId", "source");
CREATE INDEX "Appointment_businessId_appointmentDate_idx" ON "Appointment"("businessId", "appointmentDate");
CREATE INDEX "Appointment_businessId_startTime_idx" ON "Appointment"("businessId", "startTime");
CREATE INDEX "Appointment_businessId_startTime_endTime_idx" ON "Appointment"("businessId", "startTime", "endTime");

CREATE INDEX "AppointmentActivity_businessId_appointmentId_createdAt_idx" ON "AppointmentActivity"("businessId", "appointmentId", "createdAt");
CREATE INDEX "AppointmentActivity_actorUserId_createdAt_idx" ON "AppointmentActivity"("actorUserId", "createdAt");
CREATE INDEX "AppointmentActivity_actorMembershipId_createdAt_idx" ON "AppointmentActivity"("actorMembershipId", "createdAt");

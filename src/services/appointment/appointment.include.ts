import { AppointmentRescheduleRequestStatus, Prisma } from "@prisma/client";

export const appointmentInclude = {
  service: {
    select: {
      id: true,
      name: true,
      durationMinutes: true,
      bufferMinutes: true,
      isBookable: true,
      autoConfirmEligible: true,
      requiresManualApproval: true,
      requiresPayment: true,
      paymentRequiredBeforeBooking: true,
      requiresDepositBeforeConfirmation: true,
      requiresLocationBeforeConfirmation: true,
      requiresStaffAssignment: true,
      allowedLocationTypes: true,
      defaultLocationType: true,
      requiresStaffAssignmentBeforeConfirmation: true,
      requiresManagerApproval: true,
      capacityMode: true,
      requiredStaffRole: true,
      requiredSkillTags: true,
      allowAiToChooseLocationType: true,
      isActive: true,
      isArchived: true,
      readinessStatus: true,
    },
  },
  lead: { select: { id: true, fullName: true, phone: true, email: true, status: true } },
  conversation: { select: { id: true, displayId: true, channel: true, status: true, subject: true } },
  assignedStaff: {
    select: {
      id: true,
      role: true,
      status: true,
      user: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
  },
  createdBy: { select: { id: true, firstName: true, lastName: true } },
  updatedBy: { select: { id: true, firstName: true, lastName: true } },
  confirmedBy: { select: { id: true, firstName: true, lastName: true } },
  lastRescheduledBy: {
    select: {
      id: true,
      role: true,
      user: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
  },
  outcomeConfirmedBy: {
    select: {
      id: true,
      role: true,
      user: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
  },
  rescheduleRequests: {
    where: { status: AppointmentRescheduleRequestStatus.PENDING },
    orderBy: { createdAt: "desc" },
    take: 1,
  },
} satisfies Prisma.AppointmentInclude;

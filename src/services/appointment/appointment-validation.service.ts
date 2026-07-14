import { Prisma, PlanCode, AppointmentConfirmationMode, MembershipStatus, BusinessRole, AppointmentLocationType, AppointmentStatus, AppointmentLocationStatus, AppointmentHumanConfirmationReason } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError } from "../../utils/errors";
import { CreateAppointmentInput } from "../../validation/appointment.schemas";
import { ACTIVE_SUBSCRIPTION_STATUSES } from "../subscription.service";
import { AppointmentActor } from "./appointment.types";

export async function validateBusiness(actor: AppointmentActor, tx: Prisma.TransactionClient = prisma) {
  const business = await tx.business.findFirst({
    where: { id: actor.businessId, businessAccountId: actor.businessAccountId, deletedAt: null },
    select: {
      id: true,
      businessAccountId: true,
      timezone: true,
      defaultCurrency: true,
      appointmentConfirmationMode: true,
      aiAutoConfirmAppointmentsEnabled: true,
    },
  });
  if (!business) throw new AppError(404, "Business not found", "BUSINESS_NOT_FOUND");
  return business;
}

export async function activeSubscription(actor: Pick<AppointmentActor, "businessAccountId">, tx: Prisma.TransactionClient = prisma) {
  const subscription = await tx.subscription.findFirst({
    where: { businessAccountId: actor.businessAccountId, status: { in: ACTIVE_SUBSCRIPTION_STATUSES } },
    orderBy: { createdAt: "desc" },
    include: { plan: true },
  });
  if (!subscription) throw new AppError(403, "No active subscription", "SUBSCRIPTION_REQUIRED");
  return subscription;
}

export function assertAppointmentConfirmationModeAllowed(planCode: PlanCode, mode: AppointmentConfirmationMode) {
  if (mode === AppointmentConfirmationMode.MANUAL_CONFIRMATION_REQUIRED) return;
  if (mode === AppointmentConfirmationMode.AUTO_CONFIRM_WHEN_STAFF_ASSIGNED) {
    if (planCode === PlanCode.BASIC) {
      throw new AppError(403, "Upgrade to Plus to enable staff-based automatic appointment confirmation.", "PLAN_UPGRADE_REQUIRED", {
        currentPlan: planCode,
        recommendedPlan: PlanCode.PLUS,
        featureKey: "appointmentConfirmationMode",
      });
    }
    return;
  }
  if (mode === AppointmentConfirmationMode.AUTO_CONFIRM_SAFE_BOOKINGS && planCode !== PlanCode.PREMIUM) {
    throw new AppError(403, "Upgrade to Premium to enable safe automatic appointment confirmation.", "PLAN_UPGRADE_REQUIRED", {
      currentPlan: planCode,
      recommendedPlan: PlanCode.PREMIUM,
      featureKey: "appointmentConfirmationMode",
    });
  }
}

export async function validateAssignee(businessId: string, assignedStaffId: string | null | undefined, tx: Prisma.TransactionClient = prisma) {
  if (!assignedStaffId) return null;
  const member = await tx.businessMember.findFirst({
    where: {
      id: assignedStaffId,
      businessId,
      status: MembershipStatus.ACTIVE,
      role: { in: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER, BusinessRole.STAFF] },
    },
    include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
  });
  if (!member) throw new AppError(404, "This team member cannot receive assigned work.", "INVALID_ASSIGNMENT_TARGET");
  return member;
}

export async function validateService(businessId: string, serviceId: string | null | undefined, durationMinutes?: number, tx: Prisma.TransactionClient = prisma) {
  if (!serviceId) {
    if (!durationMinutes) throw new AppError(422, "durationMinutes is required when no service is selected.", "APPOINTMENT_SERVICE_DURATION_REQUIRED");
    return { service: null, durationMinutes };
  }
  const service = await tx.service.findFirst({ where: { id: serviceId, businessId } });
  if (!service) throw new AppError(404, "Service not found.", "SERVICE_NOT_FOUND");
  if (!service.isActive || service.isArchived) throw new AppError(404, "Service not found.", "SERVICE_NOT_FOUND");
  if (!service.isBookable) {
    throw new AppError(422, "This service is not bookable.", "APPOINTMENT_SERVICE_NOT_BOOKABLE");
  }
  const resolvedDuration = service.durationMinutes ?? durationMinutes;
  if (!resolvedDuration) {
    throw new AppError(422, "This service needs a duration before appointments can be booked.", "APPOINTMENT_SERVICE_DURATION_REQUIRED");
  }
  return { service, durationMinutes: resolvedDuration + service.bufferMinutes };
}

export async function resolveLinkedRecords(actor: AppointmentActor, input: Pick<CreateAppointmentInput, "leadId" | "conversationId">, tx: Prisma.TransactionClient = prisma) {
  const conversation = input.conversationId
    ? await tx.conversation.findFirst({
      where: { id: input.conversationId, businessId: actor.businessId, deletedAt: null },
      select: { id: true, leadId: true, displayId: true, subject: true },
    })
    : null;
  if (input.conversationId && !conversation) throw new AppError(404, "Conversation not found.", "CONVERSATION_NOT_FOUND");

  const leadId = input.leadId ?? conversation?.leadId ?? null;
  const lead = leadId
    ? await tx.lead.findFirst({
      where: { id: leadId, businessId: actor.businessId, deletedAt: null },
      select: { id: true, fullName: true, phone: true, email: true, status: true, assignedStaffId: true },
    })
    : null;
  if (leadId && !lead) throw new AppError(404, "Lead not found.", "LEAD_NOT_FOUND");
  if (conversation && lead && conversation.leadId !== lead.id) {
    throw new AppError(422, "Conversation and lead do not match.", "VALIDATION_ERROR");
  }
  return { lead, conversation, leadId };
}

export function statusForLocation(locationType: AppointmentLocationType, location?: string | null) {
  if (locationType === AppointmentLocationType.PHONE_CALL || locationType === AppointmentLocationType.ONLINE) {
    return {
      status: AppointmentStatus.CONFIRMED,
      locationStatus: AppointmentLocationStatus.NOT_REQUIRED,
      humanConfirmationRequired: false,
      humanConfirmationReason: null,
    };
  }
  if (locationType === AppointmentLocationType.TO_BE_CONFIRMED || !location?.trim()) {
    return {
      status: AppointmentStatus.NEEDS_HUMAN_CONFIRMATION,
      locationStatus: AppointmentLocationStatus.NEEDS_CONFIRMATION,
      humanConfirmationRequired: true,
      humanConfirmationReason: AppointmentHumanConfirmationReason.LOCATION_REQUIRED,
    };
  }
  return {
    status: AppointmentStatus.CONFIRMED,
    locationStatus: AppointmentLocationStatus.CONFIRMED,
    humanConfirmationRequired: false,
    humanConfirmationReason: null,
  };
}

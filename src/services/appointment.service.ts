import crypto from "node:crypto";
import {
  AppointmentActivityType,
  AppointmentHumanConfirmationReason,
  AppointmentLocationStatus,
  AppointmentLocationType,
  AppointmentSource,
  AppointmentStatus,
  AuditAction,
  BusinessRole,
  DayOfWeek,
  LeadActivityAction,
  LeadStatus,
  MembershipStatus,
  PlanCode,
  Prisma,
  SubscriptionStatus,
} from "@prisma/client";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import {
  AppointmentCalendarQuery,
  AppointmentListQuery,
  CheckAppointmentAvailabilityInput,
  CreateAppointmentInput,
  RescheduleAppointmentInput,
} from "../validation/appointment.schemas";
import { AuditInput, auditService } from "./audit.service";
import { invalidateBusinessKnowledgePreview } from "./business-knowledge-cache.service";
import { invalidateBusinessSetupStatus } from "./business-setup.service";
import { cacheService } from "./cache.service";
import { invalidateConversationCache } from "./conversation.service";
import { createSystemMessage } from "./message.service";
import { realtimeService, RealtimeEventType } from "./realtime.service";

export type AppointmentActor = {
  userId: string;
  businessAccountId: string;
  businessId: string;
  membershipId: string;
  role: BusinessRole;
};

const ACTIVE_APPOINTMENT_STATUSES = [
  AppointmentStatus.PENDING_BUSINESS_CONFIRMATION,
  AppointmentStatus.CONFIRMED,
  AppointmentStatus.NEEDS_HUMAN_CONFIRMATION,
  AppointmentStatus.RESCHEDULE_REQUESTED,
  AppointmentStatus.RESCHEDULED,
];
const TERMINAL_APPOINTMENT_STATUSES = new Set<AppointmentStatus>([
  AppointmentStatus.CANCELLED,
  AppointmentStatus.COMPLETED,
  AppointmentStatus.NO_SHOW,
]);
const ACTIVE_SUBSCRIPTION_STATUSES = [SubscriptionStatus.TRIALING, SubscriptionStatus.ACTIVE];
const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 60_000 } as const;

const appointmentInclude = {
  service: {
    select: {
      id: true,
      name: true,
      durationMinutes: true,
      bufferMinutes: true,
      isBookable: true,
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
} satisfies Prisma.AppointmentInclude;

function isManager(actor: AppointmentActor) {
  return actor.role === BusinessRole.BUSINESS_OWNER || actor.role === BusinessRole.MANAGER;
}

function requireManager(actor: AppointmentActor) {
  if (!isManager(actor)) {
    throw new AppError(403, "You do not have permission to manage this appointment.", "FORBIDDEN");
  }
}

function requireReason(reason: string | null | undefined, action: "rescheduling" | "cancelling") {
  if (!reason?.trim()) {
    throw new AppError(422, `Please provide a reason before ${action} this appointment.`, "APPOINTMENT_REASON_REQUIRED");
  }
  return reason.trim();
}

function validTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function parseDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return { year: year!, month: month!, day: day! };
}

function parseTime(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return { hour: hour!, minute: minute!, totalMinutes: hour! * 60 + minute! };
}

function appointmentDateUtc(date: string) {
  const { year, month, day } = parseDate(date);
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
}

function offsetMs(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  const asUtc = Date.UTC(values.year!, values.month! - 1, values.day!, values.hour!, values.minute!, values.second!, 0);
  return asUtc - date.getTime();
}

function zonedDateTimeToUtc(date: string, time: string, timezone: string) {
  if (!validTimezone(timezone)) throw new AppError(422, "Invalid timezone.", "INVALID_TIMEZONE");
  const { year, month, day } = parseDate(date);
  const { hour, minute } = parseTime(time);
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let result = new Date(localAsUtc - offsetMs(new Date(localAsUtc), timezone));
  result = new Date(localAsUtc - offsetMs(result, timezone));
  return result;
}

function dayOfWeekFor(date: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: timezone }).format(date).toUpperCase() as DayOfWeek;
}

function rangeFromDates(dateFrom?: string, dateTo?: string) {
  if (!dateFrom && !dateTo) return undefined;
  return {
    ...(dateFrom ? { gte: appointmentDateUtc(dateFrom) } : {}),
    ...(dateTo ? { lt: new Date(appointmentDateUtc(dateTo).getTime() + 24 * 60 * 60 * 1000) } : {}),
  };
}

function listKey(actor: AppointmentActor, query: AppointmentListQuery) {
  const scope = actor.role === BusinessRole.STAFF ? actor.membershipId : "all";
  const hash = crypto.createHash("sha256").update(JSON.stringify({ query, scope })).digest("hex");
  return `business:${actor.businessId}:appointments:list:${hash}`;
}

function calendarKey(actor: AppointmentActor, query: AppointmentCalendarQuery) {
  const scope = actor.role === BusinessRole.STAFF ? actor.membershipId : "all";
  const hash = crypto.createHash("sha256").update(JSON.stringify({ query, scope })).digest("hex");
  return `business:${actor.businessId}:appointments:calendar:${hash}`;
}

function detailKey(actor: AppointmentActor, appointmentId: string) {
  const scope = actor.role === BusinessRole.STAFF ? actor.membershipId : "all";
  return `business:${actor.businessId}:appointments:detail:${appointmentId}:${scope}`;
}

async function invalidateAppointmentCaches(businessId: string, appointmentId?: string) {
  await Promise.all([
    cacheService.delByPattern(`business:${businessId}:appointments:list:*`),
    cacheService.delByPattern(`business:${businessId}:appointments:calendar:*`),
    cacheService.delByPattern(`business:${businessId}:appointments:summary*`),
    ...(appointmentId ? [cacheService.delByPattern(`business:${businessId}:appointments:detail:${appointmentId}:*`)] : []),
    invalidateBusinessSetupStatus(businessId),
    invalidateBusinessKnowledgePreview(businessId, "APPOINTMENTS"),
  ]);
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function accessWhere(actor: AppointmentActor): Prisma.AppointmentWhereInput {
  return {
    businessId: actor.businessId,
    ...(actor.role === BusinessRole.STAFF ? { assignedStaffId: actor.membershipId } : {}),
  };
}

async function validateBusiness(actor: AppointmentActor, tx: Prisma.TransactionClient = prisma) {
  const business = await tx.business.findFirst({
    where: { id: actor.businessId, businessAccountId: actor.businessAccountId, deletedAt: null },
    select: { id: true, businessAccountId: true, timezone: true, defaultCurrency: true },
  });
  if (!business) throw new AppError(404, "Business not found", "BUSINESS_NOT_FOUND");
  return business;
}

async function validateAssignee(businessId: string, assignedStaffId: string | null | undefined, tx: Prisma.TransactionClient = prisma) {
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
  if (!member) throw new AppError(404, "Assigned staff member not found.", "STAFF_MEMBER_NOT_FOUND");
  return member;
}

async function validateService(businessId: string, serviceId: string | null | undefined, durationMinutes?: number, tx: Prisma.TransactionClient = prisma) {
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

async function resolveLinkedRecords(actor: AppointmentActor, input: Pick<CreateAppointmentInput, "leadId" | "conversationId">, tx: Prisma.TransactionClient = prisma) {
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

function statusForLocation(locationType: AppointmentLocationType, location?: string | null) {
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

async function checkSlot(input: CheckAppointmentAvailabilityInput & { businessId: string }) {
  const { service, durationMinutes } = await validateService(input.businessId, input.serviceId, input.durationMinutes);
  const assignee = await validateAssignee(input.businessId, input.assignedStaffId);
  const startTime = zonedDateTimeToUtc(input.date, input.time, input.timezone);
  const endTime = new Date(startTime.getTime() + durationMinutes * 60_000);
  const { totalMinutes: startMinutes } = parseTime(input.time);
  const endMinutes = startMinutes + durationMinutes;
  const day = dayOfWeekFor(startTime, input.timezone);
  const rule = await prisma.businessAvailability.findFirst({
    where: { businessId: input.businessId, dayOfWeek: day, isActive: true },
  });
  if (!rule || !rule.isOpen || !rule.openTime || !rule.closeTime) {
    return { available: false, reason: "BUSINESS_CLOSED", message: "The business is closed at this time.", suggestedSlots: [] as unknown[], startTime, endTime, durationMinutes, warnings: [] as string[] };
  }
  const openMinutes = parseTime(rule.openTime).totalMinutes;
  const closeMinutes = parseTime(rule.closeTime).totalMinutes;
  if (startMinutes < openMinutes || endMinutes > closeMinutes) {
    return { available: false, reason: "APPOINTMENT_OUTSIDE_BUSINESS_HOURS", message: "The appointment is outside business hours.", suggestedSlots: [] as unknown[], startTime, endTime, durationMinutes, warnings: [] as string[] };
  }
  if (rule.breakStartTime && rule.breakEndTime) {
    const breakStart = parseTime(rule.breakStartTime).totalMinutes;
    const breakEnd = parseTime(rule.breakEndTime).totalMinutes;
    if (startMinutes < breakEnd && endMinutes > breakStart) {
      return { available: false, reason: "APPOINTMENT_OVERLAPS_BREAK_TIME", message: "The appointment overlaps a break time.", suggestedSlots: [] as unknown[], startTime, endTime, durationMinutes, warnings: [] as string[] };
    }
  }
  if (assignee) {
    const conflict = await prisma.appointment.findFirst({
      where: {
        businessId: input.businessId,
        assignedStaffId: assignee.id,
        status: { in: ACTIVE_APPOINTMENT_STATUSES },
        startTime: { lt: endTime },
        endTime: { gt: startTime },
        ...(input.excludeAppointmentId ? { id: { not: input.excludeAppointmentId } } : {}),
      },
      select: { id: true, title: true, startTime: true, endTime: true },
    });
    if (conflict) {
      return { available: false, reason: "APPOINTMENT_SLOT_UNAVAILABLE", message: "This staff member already has an appointment at that time.", suggestedSlots: [] as unknown[], startTime, endTime, durationMinutes, warnings: [] as string[], conflict };
    }
  }
  return {
    available: true,
    reason: null,
    message: null,
    startTime,
    endTime,
    durationMinutes,
    warnings: service ? [] as string[] : ["No service selected; using manual duration."],
  };
}

function appointmentLimitError(plan: { code: PlanCode; name: string; maxAppointmentsPerMonth: number | null }, current: number) {
  const recommendedPlan = plan.code === PlanCode.BASIC ? PlanCode.PLUS : plan.code === PlanCode.PLUS ? PlanCode.PREMIUM : null;
  return new AppError(
    403,
    `Your current plan allows up to ${plan.maxAppointmentsPerMonth} appointments per month. Upgrade to create more appointments.`,
    "APPOINTMENT_LIMIT_REACHED",
    { currentPlan: plan.code, recommendedPlan, limit: plan.maxAppointmentsPerMonth, current },
  );
}

async function incrementAppointmentUsage(tx: Prisma.TransactionClient, actor: AppointmentActor) {
  const subscription = await tx.subscription.findFirst({
    where: { businessAccountId: actor.businessAccountId, status: { in: ACTIVE_SUBSCRIPTION_STATUSES } },
    orderBy: { createdAt: "desc" },
    include: { plan: true, usageRecords: { orderBy: { periodStart: "desc" }, take: 1 } },
  });
  if (!subscription) throw new AppError(403, "No active subscription", "SUBSCRIPTION_REQUIRED");
  const usage = subscription.usageRecords[0];
  if (!usage) throw new AppError(500, "Current account usage record is unavailable");
  const updated = await tx.accountUsageRecord.updateMany({
    where: {
      id: usage.id,
      ...(subscription.plan.maxAppointmentsPerMonth !== null ? { appointmentsUsed: { lt: subscription.plan.maxAppointmentsPerMonth } } : {}),
    },
    data: { appointmentsUsed: { increment: 1 } },
  });
  if (updated.count !== 1) {
    const current = await tx.accountUsageRecord.findUniqueOrThrow({ where: { id: usage.id } });
    throw appointmentLimitError(subscription.plan, current.appointmentsUsed);
  }
  await tx.businessUsageRecord.upsert({
    where: { businessId_periodStart: { businessId: actor.businessId, periodStart: usage.periodStart } },
    create: {
      businessId: actor.businessId,
      appointmentsUsed: 1,
      periodStart: usage.periodStart,
      periodEnd: usage.periodEnd,
    },
    update: { appointmentsUsed: { increment: 1 } },
  });
}

function appointmentMessage(action: AppointmentActivityType, appointment: { title: string; startTime: Date; timezone: string }, detail?: string | null) {
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: appointment.timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(appointment.startTime);
  if (action === AppointmentActivityType.APPOINTMENT_CREATED) return `Appointment created: ${appointment.title} on ${when}.`;
  if (action === AppointmentActivityType.APPOINTMENT_RESCHEDULED) return `Appointment rescheduled to ${when}.`;
  if (action === AppointmentActivityType.APPOINTMENT_CANCELLED) return `Appointment cancelled${detail ? `: ${detail}` : "."}`;
  if (action === AppointmentActivityType.APPOINTMENT_COMPLETED) return "Appointment marked completed.";
  if (action === AppointmentActivityType.APPOINTMENT_NO_SHOW) return "Appointment marked no-show.";
  return `Appointment updated: ${appointment.title}.`;
}

async function logAppointmentActivity(
  tx: Prisma.TransactionClient,
  actor: AppointmentActor,
  appointmentId: string,
  type: AppointmentActivityType,
  message: string,
  metadata?: Record<string, unknown>,
) {
  await tx.appointmentActivity.create({
    data: {
      businessId: actor.businessId,
      appointmentId,
      actorUserId: actor.userId,
      actorMembershipId: actor.membershipId,
      type,
      message,
      metadata: metadata ? json(metadata) : undefined,
    },
  });
}

async function logLeadAppointmentActivity(
  tx: Prisma.TransactionClient,
  actor: AppointmentActor,
  leadId: string | null,
  action: LeadActivityAction,
  metadata: Record<string, unknown>,
) {
  if (!leadId) return;
  await tx.leadActivity.create({
    data: { businessId: actor.businessId, leadId, actorUserId: actor.userId, action, metadata: json(metadata) },
  });
}

async function publishAndInvalidate(
  actor: AppointmentActor,
  type: RealtimeEventType,
  appointment: { id: string; leadId: string | null; conversationId: string | null; assignedStaffId: string | null; status: AppointmentStatus; startTime: Date; endTime: Date; updatedAt: Date },
) {
  await Promise.all([
    invalidateAppointmentCaches(actor.businessId, appointment.id),
    appointment.conversationId ? invalidateConversationCache(actor.businessId, appointment.conversationId) : Promise.resolve(),
    appointment.leadId ? Promise.all([
      cacheService.delByPattern(`business:${actor.businessId}:leads:list:*`),
      cacheService.delByPattern(`business:${actor.businessId}:leads:detail:${appointment.leadId}*`),
      cacheService.delByPattern(`business:${actor.businessId}:leads:counts:*`),
    ]) : Promise.resolve(),
  ]);
  realtimeService.publish({
    type,
    businessId: actor.businessId,
    conversationId: appointment.conversationId ?? undefined,
    leadId: appointment.leadId ?? undefined,
    assignedStaffId: appointment.assignedStaffId,
    staffMembershipIds: [appointment.assignedStaffId],
    payload: {
      businessId: actor.businessId,
      appointmentId: appointment.id,
      conversationId: appointment.conversationId,
      leadId: appointment.leadId,
      status: appointment.status,
      startTime: appointment.startTime.toISOString(),
      endTime: appointment.endTime.toISOString(),
      updatedAt: appointment.updatedAt.toISOString(),
    },
  });
  realtimeService.publish({
    type: "business.appointments.calendar.updated",
    businessId: actor.businessId,
    assignedStaffId: appointment.assignedStaffId,
    staffMembershipIds: [appointment.assignedStaffId],
    payload: { businessId: actor.businessId, appointmentId: appointment.id, updatedAt: appointment.updatedAt.toISOString() },
  });
}

async function audit(
  actor: AppointmentActor,
  action: AuditAction,
  appointmentId: string,
  context: Omit<AuditInput, "action">,
  metadata?: Record<string, unknown>,
) {
  await auditService.log({
    ...context,
    action,
    businessId: actor.businessId,
    userId: actor.userId,
    metadata: json({ businessId: actor.businessId, appointmentId, actorUserId: actor.userId, actorMembershipId: actor.membershipId, ...metadata }),
  });
}

async function loadAppointment(actor: AppointmentActor, appointmentId: string) {
  const appointment = await prisma.appointment.findFirst({
    where: { id: appointmentId, ...accessWhere(actor) },
    include: appointmentInclude,
  });
  if (!appointment) throw new AppError(404, "Appointment not found.", "APPOINTMENT_NOT_FOUND");
  return appointment;
}

async function createAppointmentFromValidatedInput(actor: AppointmentActor, input: CreateAppointmentInput, context: Omit<AuditInput, "action">) {
  requireManager(actor);
  await validateBusiness(actor);
  const linked = await resolveLinkedRecords(actor, input);
  const assignedStaffId = input.assignedStaffId ?? linked.lead?.assignedStaffId ?? null;
  await validateAssignee(actor.businessId, assignedStaffId);
  const availability = await checkSlot({
    businessId: actor.businessId,
    serviceId: input.serviceId ?? undefined,
    date: input.date,
    time: input.time,
    timezone: input.timezone,
    assignedStaffId,
    durationMinutes: input.durationMinutes,
  });
  if (!availability.available) {
    throw new AppError(422, availability.message ?? "Appointment slot is unavailable.", availability.reason ?? "APPOINTMENT_SLOT_UNAVAILABLE", { availability });
  }
  const location = statusForLocation(input.locationType, input.location ?? null);
  const customerName = input.customerName ?? linked.lead?.fullName ?? null;
  const customerPhone = input.customerPhone ?? linked.lead?.phone ?? null;
  const customerEmail = input.customerEmail ?? linked.lead?.email ?? null;

  const appointment = await prisma.$transaction(async (tx) => {
    await validateBusiness(actor, tx);
    await incrementAppointmentUsage(tx, actor);
    const created = await tx.appointment.create({
      data: {
        businessId: actor.businessId,
        businessAccountId: actor.businessAccountId,
        leadId: linked.leadId,
        conversationId: linked.conversation?.id ?? null,
        serviceId: input.serviceId ?? null,
        assignedStaffId,
        customerName,
        customerPhone,
        customerEmail,
        title: input.title,
        description: input.description,
        notes: input.notes,
        appointmentDate: appointmentDateUtc(input.date),
        startTime: availability.startTime,
        endTime: availability.endTime,
        timezone: input.timezone,
        status: location.status,
        source: input.source,
        locationType: input.locationType,
        location: input.location,
        locationStatus: location.locationStatus,
        humanConfirmationRequired: location.humanConfirmationRequired,
        humanConfirmationReason: location.humanConfirmationReason,
        createdById: actor.userId,
      },
      include: appointmentInclude,
    });
    await logAppointmentActivity(tx, actor, created.id, AppointmentActivityType.APPOINTMENT_CREATED, appointmentMessage(AppointmentActivityType.APPOINTMENT_CREATED, created), {
      source: created.source,
      leadId: created.leadId,
      conversationId: created.conversationId,
      assignedStaffId: created.assignedStaffId,
    });
    if (created.humanConfirmationRequired) {
      await logAppointmentActivity(tx, actor, created.id, AppointmentActivityType.HUMAN_CONFIRMATION_REQUIRED, "Human confirmation is required before this appointment is fully confirmed.", {
        reason: created.humanConfirmationReason,
      });
    }
    await logLeadAppointmentActivity(tx, actor, created.leadId, LeadActivityAction.APPOINTMENT_CREATED, {
      appointmentId: created.id,
      conversationId: created.conversationId,
      status: created.status,
      startTime: created.startTime,
      endTime: created.endTime,
    });
    if (created.leadId && linked.lead && linked.lead.status !== LeadStatus.WON && linked.lead.status !== LeadStatus.LOST) {
      await tx.lead.update({ where: { id: created.leadId }, data: { status: LeadStatus.APPOINTMENT_SCHEDULED } });
    }
    if (created.conversationId && created.leadId) {
      await createSystemMessage({
        businessId: actor.businessId,
        leadId: created.leadId,
        conversationId: created.conversationId,
        content: appointmentMessage(AppointmentActivityType.APPOINTMENT_CREATED, created),
        metadata: json({ appointmentId: created.id, type: "APPOINTMENT_CREATED" }),
      }, tx);
    }
    return created;
  }, TRANSACTION_OPTIONS);

  await Promise.all([
    audit(actor, AuditAction.APPOINTMENT_CREATED, appointment.id, context, {
      leadId: appointment.leadId,
      conversationId: appointment.conversationId,
      assignedStaffId: appointment.assignedStaffId,
      source: appointment.source,
      status: appointment.status,
    }),
    publishAndInvalidate(actor, "business.appointment.created", appointment),
  ]);
  return appointment;
}

async function rescheduleAppointmentFromValidatedInput(actor: AppointmentActor, appointmentId: string, input: RescheduleAppointmentInput, context: Omit<AuditInput, "action">) {
  requireManager(actor);
  const rescheduleReason = requireReason(input.reason, "rescheduling");
  const existing = await loadAppointment(actor, appointmentId);
  if (TERMINAL_APPOINTMENT_STATUSES.has(existing.status)) {
    throw new AppError(422, "This appointment cannot be rescheduled in its current status.", "INVALID_APPOINTMENT_STATUS");
  }
  const existingDurationMinutes = Math.max(1, Math.round((existing.endTime.getTime() - existing.startTime.getTime()) / 60_000));
  const availability = await checkSlot({
    businessId: actor.businessId,
    serviceId: existing.serviceId ?? undefined,
    date: input.date,
    time: input.time,
    timezone: input.timezone,
    assignedStaffId: existing.assignedStaffId,
    durationMinutes: input.durationMinutes ?? existing.service?.durationMinutes ?? existingDurationMinutes,
    excludeAppointmentId: appointmentId,
  });
  if (!availability.available) {
    throw new AppError(422, availability.message ?? "Appointment slot is unavailable.", availability.reason ?? "APPOINTMENT_SLOT_UNAVAILABLE", { availability });
  }
  const updated = await prisma.$transaction(async (tx) => {
    const record = await tx.appointment.update({
      where: { id: appointmentId },
      data: {
        appointmentDate: appointmentDateUtc(input.date),
        startTime: availability.startTime,
        endTime: availability.endTime,
        timezone: input.timezone,
        status: existing.status === AppointmentStatus.NEEDS_HUMAN_CONFIRMATION ? AppointmentStatus.NEEDS_HUMAN_CONFIRMATION : AppointmentStatus.RESCHEDULED,
        rescheduleReason,
        rescheduledAt: new Date(),
        rescheduledById: actor.userId,
        updatedById: actor.userId,
      },
      include: appointmentInclude,
    });
    await logAppointmentActivity(tx, actor, appointmentId, AppointmentActivityType.APPOINTMENT_RESCHEDULED, appointmentMessage(AppointmentActivityType.APPOINTMENT_RESCHEDULED, record), {
      previousStartTime: existing.startTime,
      previousEndTime: existing.endTime,
      newStartTime: record.startTime,
      newEndTime: record.endTime,
      reason: rescheduleReason,
      rescheduledById: actor.userId,
      rescheduledAt: record.rescheduledAt,
    });
    await logLeadAppointmentActivity(tx, actor, record.leadId, LeadActivityAction.APPOINTMENT_RESCHEDULED, {
      appointmentId,
      conversationId: record.conversationId,
      previousStartTime: existing.startTime,
      newStartTime: record.startTime,
      reason: rescheduleReason,
    });
    if (record.conversationId && record.leadId) {
      await createSystemMessage({
        businessId: actor.businessId,
        leadId: record.leadId,
        conversationId: record.conversationId,
        content: appointmentMessage(AppointmentActivityType.APPOINTMENT_RESCHEDULED, record),
        metadata: json({ appointmentId, type: "APPOINTMENT_RESCHEDULED" }),
      }, tx);
    }
    return record;
  }, TRANSACTION_OPTIONS);
  await Promise.all([
    audit(actor, AuditAction.APPOINTMENT_RESCHEDULED, updated.id, context, {
      changedFields: ["appointmentDate", "startTime", "endTime", "timezone", "status", "rescheduleReason", "rescheduledAt", "rescheduledById"],
      previousValues: { startTime: existing.startTime, endTime: existing.endTime, timezone: existing.timezone, status: existing.status },
      newValues: { startTime: updated.startTime, endTime: updated.endTime, timezone: updated.timezone, status: updated.status, rescheduleReason },
    }),
    publishAndInvalidate(actor, "business.appointment.rescheduled", updated),
  ]);
  return updated;
}

export const appointmentService = {
  async checkAvailability(actor: AppointmentActor, input: CheckAppointmentAvailabilityInput) {
    await validateBusiness(actor);
    if (actor.role === BusinessRole.STAFF && input.assignedStaffId && input.assignedStaffId !== actor.membershipId) {
      throw new AppError(403, "You do not have permission to check another staff member's schedule.", "FORBIDDEN");
    }
    return checkSlot({
      ...input,
      assignedStaffId: actor.role === BusinessRole.STAFF ? actor.membershipId : input.assignedStaffId,
      businessId: actor.businessId,
    });
  },

  createAppointmentFromValidatedInput,
  rescheduleAppointmentFromValidatedInput,

  async list(actor: AppointmentActor, query: AppointmentListQuery) {
    const key = listKey(actor, query);
    const cached = await cacheService.get<unknown>(key);
    if (cached) return cached;
    const dateRange = rangeFromDates(query.dateFrom, query.dateTo);
    const where: Prisma.AppointmentWhereInput = {
      ...accessWhere(actor),
      ...(query.status ? { status: query.status } : {}),
      ...(query.source ? { source: query.source } : {}),
      ...(query.serviceId ? { serviceId: query.serviceId } : {}),
      ...(query.assignedStaffId ? { assignedStaffId: query.assignedStaffId } : {}),
      ...(query.leadId ? { leadId: query.leadId } : {}),
      ...(query.conversationId ? { conversationId: query.conversationId } : {}),
      ...(query.search ? {
        OR: [
          { title: { contains: query.search, mode: "insensitive" } },
          { description: { contains: query.search, mode: "insensitive" } },
          { notes: { contains: query.search, mode: "insensitive" } },
          { customerName: { contains: query.search, mode: "insensitive" } },
          { customerPhone: { contains: query.search } },
          { customerEmail: { contains: query.search, mode: "insensitive" } },
          { lead: { fullName: { contains: query.search, mode: "insensitive" } } },
          { lead: { phone: { contains: query.search } } },
          { lead: { email: { contains: query.search, mode: "insensitive" } } },
          { service: { name: { contains: query.search, mode: "insensitive" } } },
        ],
      } : {}),
      ...(dateRange ? { startTime: dateRange } : {}),
    };
    const [data, total, grouped] = await prisma.$transaction([
      prisma.appointment.findMany({
        where,
        include: appointmentInclude,
        orderBy: [{ startTime: "asc" }, { id: "asc" }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      prisma.appointment.count({ where }),
      prisma.appointment.groupBy({ by: ["status"], where: accessWhere(actor), _count: { status: true }, orderBy: { status: "asc" } }),
    ]);
    const byStatus = Object.fromEntries(Object.values(AppointmentStatus).map((status) => [status, 0])) as Record<AppointmentStatus, number>;
    for (const group of grouped) {
      const count = typeof group._count === "number"
        ? group._count
        : ((group._count ?? {}) as Record<string, number>).status ?? 0;
      byStatus[group.status] = count;
    }
    const result = {
      data,
      summary: { total: Object.values(byStatus).reduce((sum, count) => sum + count, 0), byStatus },
      pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
    };
    await cacheService.set(key, result, 60);
    return result;
  },

  async calendar(actor: AppointmentActor, query: AppointmentCalendarQuery) {
    const key = calendarKey(actor, query);
    const cached = await cacheService.get<unknown>(key);
    if (cached) return cached;
    const where: Prisma.AppointmentWhereInput = {
      ...accessWhere(actor),
      startTime: rangeFromDates(query.dateFrom, query.dateTo),
      ...(query.status ? { status: query.status } : {}),
      ...(query.serviceId ? { serviceId: query.serviceId } : {}),
      ...(query.assignedStaffId ? { assignedStaffId: query.assignedStaffId } : {}),
    };
    const appointments = await prisma.appointment.findMany({
      where,
      select: {
        id: true,
        title: true,
        status: true,
        source: true,
        startTime: true,
        endTime: true,
        timezone: true,
        locationType: true,
        locationStatus: true,
        assignedStaffId: true,
        leadId: true,
        conversationId: true,
        serviceId: true,
        lead: { select: { id: true, fullName: true, phone: true } },
        service: { select: { id: true, name: true, durationMinutes: true } },
        assignedStaff: { select: { id: true, user: { select: { firstName: true, lastName: true } } } },
      },
      orderBy: [{ startTime: "asc" }, { id: "asc" }],
    });
    const result = { view: query.view, dateFrom: query.dateFrom, dateTo: query.dateTo, appointments };
    await cacheService.set(key, result, 60);
    return result;
  },

  async detail(actor: AppointmentActor, appointmentId: string) {
    const key = detailKey(actor, appointmentId);
    const cached = await cacheService.get<unknown>(key);
    if (cached) return cached;
    const appointment = await loadAppointment(actor, appointmentId);
    const activities = await prisma.appointmentActivity.findMany({
      where: { businessId: actor.businessId, appointmentId },
      include: {
        actorUser: { select: { id: true, firstName: true, lastName: true } },
        actorMembership: { select: { id: true, role: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const result = {
      appointment,
      service: appointment.service,
      lead: appointment.lead,
      conversation: appointment.conversation,
      assignedStaff: appointment.assignedStaff,
      activities,
    };
    await cacheService.set(key, result, 120);
    return result;
  },

  async create(actor: AppointmentActor, input: CreateAppointmentInput, context: Omit<AuditInput, "action">) {
    return createAppointmentFromValidatedInput(actor, input, context);
  },

  async reschedule(actor: AppointmentActor, appointmentId: string, input: RescheduleAppointmentInput, context: Omit<AuditInput, "action">) {
    return rescheduleAppointmentFromValidatedInput(actor, appointmentId, input, context);
  },

  async cancel(actor: AppointmentActor, appointmentId: string, reason: string | null | undefined, context: Omit<AuditInput, "action">) {
    requireManager(actor);
    const cancellationReason = requireReason(reason, "cancelling");
    const existing = await loadAppointment(actor, appointmentId);
    if (existing.status === AppointmentStatus.CANCELLED) throw new AppError(422, "Appointment is already cancelled.", "APPOINTMENT_ALREADY_CANCELLED");
    const updated = await prisma.$transaction(async (tx) => {
      const record = await tx.appointment.update({
        where: { id: appointmentId },
        data: { status: AppointmentStatus.CANCELLED, cancellationReason, cancelledAt: new Date(), cancelledById: actor.userId, updatedById: actor.userId },
        include: appointmentInclude,
      });
      await logAppointmentActivity(tx, actor, appointmentId, AppointmentActivityType.APPOINTMENT_CANCELLED, appointmentMessage(AppointmentActivityType.APPOINTMENT_CANCELLED, record, cancellationReason), { reasonProvided: true, previousStatus: existing.status });
      await logLeadAppointmentActivity(tx, actor, record.leadId, LeadActivityAction.APPOINTMENT_CANCELLED, { appointmentId, conversationId: record.conversationId, reasonProvided: true });
      if (record.conversationId && record.leadId) {
        await createSystemMessage({
          businessId: actor.businessId,
          leadId: record.leadId,
          conversationId: record.conversationId,
          content: appointmentMessage(AppointmentActivityType.APPOINTMENT_CANCELLED, record, cancellationReason),
          metadata: json({ appointmentId, type: "APPOINTMENT_CANCELLED" }),
        }, tx);
      }
      return record;
    }, TRANSACTION_OPTIONS);
    await Promise.all([
      audit(actor, AuditAction.APPOINTMENT_CANCELLED, updated.id, context, { previousValues: { status: existing.status }, newValues: { status: updated.status }, reasonProvided: true }),
      publishAndInvalidate(actor, "business.appointment.cancelled", updated),
    ]);
    return updated;
  },

  async complete(actor: AppointmentActor, appointmentId: string, context: Omit<AuditInput, "action">) {
    const existing = await loadAppointment(actor, appointmentId);
    if (!isManager(actor) && existing.assignedStaffId !== actor.membershipId) throw new AppError(403, "You do not have permission to manage this appointment.", "FORBIDDEN");
    if (existing.status === AppointmentStatus.COMPLETED) throw new AppError(422, "Appointment is already completed.", "APPOINTMENT_ALREADY_COMPLETED");
    if (existing.status === AppointmentStatus.CANCELLED) throw new AppError(422, "Cancelled appointments cannot be completed.", "INVALID_APPOINTMENT_STATUS");
    const updated = await prisma.$transaction(async (tx) => {
      const record = await tx.appointment.update({
        where: { id: appointmentId },
        data: { status: AppointmentStatus.COMPLETED, completedAt: new Date(), completedById: actor.userId, updatedById: actor.userId },
        include: appointmentInclude,
      });
      await logAppointmentActivity(tx, actor, appointmentId, AppointmentActivityType.APPOINTMENT_COMPLETED, appointmentMessage(AppointmentActivityType.APPOINTMENT_COMPLETED, record), { previousStatus: existing.status });
      await logLeadAppointmentActivity(tx, actor, record.leadId, LeadActivityAction.APPOINTMENT_COMPLETED, { appointmentId, conversationId: record.conversationId });
      return record;
    }, TRANSACTION_OPTIONS);
    await Promise.all([
      audit(actor, AuditAction.APPOINTMENT_COMPLETED, updated.id, context, { previousValues: { status: existing.status }, newValues: { status: updated.status } }),
      publishAndInvalidate(actor, "business.appointment.completed", updated),
    ]);
    return updated;
  },

  async noShow(actor: AppointmentActor, appointmentId: string, context: Omit<AuditInput, "action">) {
    const existing = await loadAppointment(actor, appointmentId);
    if (!isManager(actor) && existing.assignedStaffId !== actor.membershipId) throw new AppError(403, "You do not have permission to manage this appointment.", "FORBIDDEN");
    if (existing.status === AppointmentStatus.CANCELLED || existing.status === AppointmentStatus.COMPLETED) {
      throw new AppError(422, "This appointment cannot be marked no-show in its current status.", "INVALID_APPOINTMENT_STATUS");
    }
    const updated = await prisma.$transaction(async (tx) => {
      const record = await tx.appointment.update({
        where: { id: appointmentId },
        data: { status: AppointmentStatus.NO_SHOW, updatedById: actor.userId },
        include: appointmentInclude,
      });
      await logAppointmentActivity(tx, actor, appointmentId, AppointmentActivityType.APPOINTMENT_NO_SHOW, appointmentMessage(AppointmentActivityType.APPOINTMENT_NO_SHOW, record), { previousStatus: existing.status });
      await logLeadAppointmentActivity(tx, actor, record.leadId, LeadActivityAction.APPOINTMENT_NO_SHOW, { appointmentId, conversationId: record.conversationId });
      return record;
    }, TRANSACTION_OPTIONS);
    await Promise.all([
      audit(actor, AuditAction.APPOINTMENT_NO_SHOW, updated.id, context, { previousValues: { status: existing.status }, newValues: { status: updated.status } }),
      publishAndInvalidate(actor, "business.appointment.no_show", updated),
    ]);
    return updated;
  },

  async assign(actor: AppointmentActor, appointmentId: string, assignedStaffId: string | null, context: Omit<AuditInput, "action">) {
    requireManager(actor);
    const existing = await loadAppointment(actor, appointmentId);
    await validateAssignee(actor.businessId, assignedStaffId);
    const updated = await prisma.$transaction(async (tx) => {
      const record = await tx.appointment.update({
        where: { id: appointmentId },
        data: { assignedStaffId, updatedById: actor.userId },
        include: appointmentInclude,
      });
      await logAppointmentActivity(tx, actor, appointmentId, AppointmentActivityType.APPOINTMENT_ASSIGNED, "Appointment assignment updated.", {
        previousAssignedStaffId: existing.assignedStaffId,
        newAssignedStaffId: assignedStaffId,
      });
      await logLeadAppointmentActivity(tx, actor, record.leadId, LeadActivityAction.APPOINTMENT_ASSIGNED, {
        appointmentId,
        previousAssignedStaffId: existing.assignedStaffId,
        newAssignedStaffId: assignedStaffId,
      });
      return record;
    }, TRANSACTION_OPTIONS);
    await Promise.all([
      audit(actor, AuditAction.APPOINTMENT_ASSIGNED, updated.id, context, {
        previousValues: { assignedStaffId: existing.assignedStaffId },
        newValues: { assignedStaffId: updated.assignedStaffId },
      }),
      publishAndInvalidate(actor, "business.appointment.assigned", updated),
    ]);
    return updated;
  },

  async getAppointmentContextForAi(businessId: string, conversationId?: string) {
    const upcoming = await prisma.appointment.findMany({
      where: {
        businessId,
        ...(conversationId ? { conversationId } : {}),
        status: { in: ACTIVE_APPOINTMENT_STATUSES },
        startTime: { gte: new Date() },
      },
      include: appointmentInclude,
      orderBy: { startTime: "asc" },
      take: 20,
    });
    return { businessId, conversationId: conversationId ?? null, upcomingAppointments: upcoming };
  },
};

export const appointmentInternalService = {
  checkAppointmentAvailability: appointmentService.checkAvailability,
  createAppointmentFromValidatedInput,
  rescheduleAppointmentFromValidatedInput,
  cancelAppointmentFromValidatedInput: appointmentService.cancel.bind(appointmentService),
  getAppointmentContextForAi: appointmentService.getAppointmentContextForAi,
};

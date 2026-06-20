import crypto from "node:crypto";
import {
  AppointmentActivityType,
  AppointmentConfirmationMode,
  AppointmentHumanConfirmationReason,
  AppointmentLocationStatus,
  AppointmentLocationType,
  AppointmentSource,
  AppointmentStatus,
  AuditAction,
  BusinessNotificationPriority,
  BusinessNotificationStatus,
  BusinessNotificationType,
  BusinessNotificationEntityType,
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
  AppointmentSettingsInput,
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
import { notificationService } from "./notification.service";

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
const OUTCOME_REQUIRED_SOURCE_STATUSES = new Set<AppointmentStatus>(ACTIVE_APPOINTMENT_STATUSES);
const STAFF_CONFLICT_BLOCKING_STATUSES = [
  ...ACTIVE_APPOINTMENT_STATUSES,
  AppointmentStatus.NEEDS_OUTCOME_CONFIRMATION,
];
const TERMINAL_APPOINTMENT_STATUSES = new Set<AppointmentStatus>([
  AppointmentStatus.CANCELLED,
  AppointmentStatus.COMPLETED,
  AppointmentStatus.NO_SHOW,
  AppointmentStatus.MISSED,
]);
const ACTIVE_SUBSCRIPTION_STATUSES = [SubscriptionStatus.TRIALING, SubscriptionStatus.ACTIVE];
const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 60_000 } as const;
const OUTCOME_CONFIRMATION_GRACE_MS = 2 * 60 * 60 * 1000;
const CONFIRMABLE_APPOINTMENT_STATUSES = new Set<AppointmentStatus>([
  AppointmentStatus.PENDING_BUSINESS_CONFIRMATION,
  AppointmentStatus.NEEDS_HUMAN_CONFIRMATION,
  AppointmentStatus.RESCHEDULE_REQUESTED,
]);
const APPOINTMENT_CONFIRMATION_ACTIONS = [
  { label: "Confirm", action: "CONFIRM_APPOINTMENT", variant: "default" },
  { label: "Reschedule", action: "RESCHEDULE_APPOINTMENT", variant: "secondary" },
  { label: "Cancel", action: "CANCEL_APPOINTMENT", variant: "destructive" },
  { label: "View appointment", action: "VIEW_APPOINTMENT", variant: "secondary" },
] as const;
const APPOINTMENT_REVIEW_ACTIONS = [
  { label: "Review", action: "VIEW_APPOINTMENT", variant: "default" },
  { label: "Confirm", action: "CONFIRM_APPOINTMENT", variant: "secondary" },
  { label: "Reschedule", action: "RESCHEDULE_APPOINTMENT", variant: "secondary" },
  { label: "Cancel", action: "CANCEL_APPOINTMENT", variant: "destructive" },
] as const;
const APPOINTMENT_OUTCOME_ACTIONS = [
  { label: "Completed", action: "MARK_COMPLETED", variant: "default" },
  { label: "No-show", action: "MARK_NO_SHOW", variant: "secondary" },
  { label: "Missed", action: "MARK_MISSED", variant: "destructive" },
  { label: "View appointment", action: "VIEW_APPOINTMENT", variant: "secondary" },
] as const;
const APPOINTMENT_ASSIGNED_ACTIONS = [
  { label: "View appointment", action: "VIEW_APPOINTMENT", variant: "default" },
] as const;

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

function dateInTimezone(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function timeInTimezone(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.hour}:${values.minute}`;
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

function appointmentHasEnded(appointment: { endTime: Date }, now = new Date()) {
  return now.getTime() > appointment.endTime.getTime();
}

function appointmentOutcomeDue(appointment: { endTime: Date }, now = new Date()) {
  return now.getTime() > appointment.endTime.getTime() + OUTCOME_CONFIRMATION_GRACE_MS;
}

function appointmentInOutcomeGrace(appointment: { endTime: Date }, now = new Date()) {
  return appointmentHasEnded(appointment, now) && !appointmentOutcomeDue(appointment, now);
}

function availableActions(appointment: { status: AppointmentStatus; endTime: Date; rescheduleCount?: number | null }) {
  if (TERMINAL_APPOINTMENT_STATUSES.has(appointment.status)) return [];
  if (appointment.status === AppointmentStatus.NEEDS_OUTCOME_CONFIRMATION || appointmentInOutcomeGrace(appointment)) {
    return ["COMPLETE", "NO_SHOW", "MISSED"];
  }
  const canReschedule = !appointmentHasEnded(appointment) && (appointment.rescheduleCount ?? 0) < 1;
  if (
    appointment.status === AppointmentStatus.PENDING_BUSINESS_CONFIRMATION
    || appointment.status === AppointmentStatus.NEEDS_HUMAN_CONFIRMATION
    || appointment.status === AppointmentStatus.RESCHEDULE_REQUESTED
  ) {
    return ["CONFIRM", ...(canReschedule ? ["RESCHEDULE"] : []), "CANCEL"];
  }
  if (appointment.status === AppointmentStatus.CONFIRMED || appointment.status === AppointmentStatus.RESCHEDULED) {
    return [...(canReschedule ? ["RESCHEDULE"] : []), "CANCEL"];
  }
  return [];
}

function withAvailableActions<T extends { status: AppointmentStatus; endTime: Date; rescheduleCount?: number | null }>(appointment: T) {
  return { ...appointment, availableActions: availableActions(appointment) };
}

function withAvailableActionsList<T extends { status: AppointmentStatus; endTime: Date; rescheduleCount?: number | null }>(appointments: T[]) {
  return appointments.map((appointment) => withAvailableActions(appointment));
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
    select: { id: true, businessAccountId: true, timezone: true, defaultCurrency: true, appointmentConfirmationMode: true },
  });
  if (!business) throw new AppError(404, "Business not found", "BUSINESS_NOT_FOUND");
  return business;
}

async function activeSubscription(actor: Pick<AppointmentActor, "businessAccountId">, tx: Prisma.TransactionClient = prisma) {
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
  if (!member) throw new AppError(404, "The selected staff member is not available for this business.", "INVALID_ASSIGNED_STAFF");
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

function confirmationForCreation(
  planCode: PlanCode,
  appointmentConfirmationMode: AppointmentConfirmationMode,
  source: AppointmentSource,
  location: ReturnType<typeof statusForLocation>,
  assignedStaffId: string | null,
  availability: { available: boolean; reason: string | null },
) {
  const businessConfirmationSource = source !== AppointmentSource.MANUAL;
  if (
    planCode === PlanCode.BASIC
    && appointmentConfirmationMode === AppointmentConfirmationMode.MANUAL_CONFIRMATION_REQUIRED
    && businessConfirmationSource
  ) {
    return {
      status: AppointmentStatus.PENDING_BUSINESS_CONFIRMATION,
      locationStatus: location.locationStatus,
      humanConfirmationRequired: true,
      humanConfirmationReason: AppointmentHumanConfirmationReason.BUSINESS_CONFIRMATION_REQUIRED,
    };
  }
  if (planCode !== PlanCode.BASIC && appointmentConfirmationMode === AppointmentConfirmationMode.AUTO_CONFIRM_WHEN_STAFF_ASSIGNED) {
    if (!assignedStaffId) {
      return {
        status: AppointmentStatus.PENDING_BUSINESS_CONFIRMATION,
        locationStatus: location.locationStatus,
        humanConfirmationRequired: true,
        humanConfirmationReason: AppointmentHumanConfirmationReason.STAFF_REQUIRED,
      };
    }
    if (!availability.available && availability.reason === "APPOINTMENT_STAFF_UNAVAILABLE") {
      return {
        status: AppointmentStatus.NEEDS_HUMAN_CONFIRMATION,
        locationStatus: location.locationStatus,
        humanConfirmationRequired: true,
        humanConfirmationReason: AppointmentHumanConfirmationReason.AVAILABILITY_CONFLICT,
      };
    }
    if (location.humanConfirmationRequired) return location;
    return {
      status: AppointmentStatus.CONFIRMED,
      locationStatus: location.locationStatus,
      humanConfirmationRequired: false,
      humanConfirmationReason: null,
    };
  }
  if (planCode === PlanCode.PREMIUM && appointmentConfirmationMode === AppointmentConfirmationMode.AUTO_CONFIRM_SAFE_BOOKINGS) {
    if (!availability.available) {
      return {
        status: AppointmentStatus.NEEDS_HUMAN_CONFIRMATION,
        locationStatus: location.locationStatus,
        humanConfirmationRequired: true,
        humanConfirmationReason: AppointmentHumanConfirmationReason.AVAILABILITY_CONFLICT,
      };
    }
    if (location.humanConfirmationRequired) return location;
    return {
      status: AppointmentStatus.CONFIRMED,
      locationStatus: location.locationStatus,
      humanConfirmationRequired: false,
      humanConfirmationReason: null,
    };
  }
  return location;
}

function confirmationNotificationMessage(appointment: {
  title: string;
  startTime: Date;
  timezone: string;
  customerName: string | null;
  service: { name: string } | null;
}) {
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: appointment.timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(appointment.startTime);
  const customer = appointment.customerName ?? "A customer";
  const service = appointment.service?.name ?? appointment.title;
  return `New appointment needs confirmation.\n\n${customer} requested ${service} on ${when}.\nPlease confirm, reschedule, or cancel.`;
}

function outcomeNotificationMessage(appointment: {
  title: string;
  endTime: Date;
  timezone: string;
  customerName: string | null;
}) {
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: appointment.timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(appointment.endTime);
  const customer = appointment.customerName ?? "the customer";
  return `Appointment outcome needed.\n\nYour appointment with ${customer} ended more than 2 hours ago (${when}).\nPlease mark it as completed, no-show, or missed.`;
}

async function notificationRecipients(tx: Prisma.TransactionClient, actor: AppointmentActor, assignedStaffId: string | null) {
  const recipients = await tx.businessMember.findMany({
    where: {
      businessId: actor.businessId,
      status: MembershipStatus.ACTIVE,
      OR: [
        { role: { in: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER] } },
        ...(assignedStaffId ? [{ id: assignedStaffId }] : []),
      ],
    },
    include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
  });
  return Array.from(new Map(recipients.map((recipient) => [recipient.id, recipient])).values());
}

async function createConfirmationNotifications(tx: Prisma.TransactionClient, actor: AppointmentActor, appointment: Prisma.AppointmentGetPayload<{ include: typeof appointmentInclude }>) {
  if (appointment.status !== AppointmentStatus.PENDING_BUSINESS_CONFIRMATION && appointment.status !== AppointmentStatus.NEEDS_HUMAN_CONFIRMATION) return [];
  const uniqueRecipients = await notificationRecipients(tx, actor, appointment.assignedStaffId);
  const message = confirmationNotificationMessage(appointment);
  const isReview = appointment.status === AppointmentStatus.NEEDS_HUMAN_CONFIRMATION;
  const notifications = [];
  for (const recipient of uniqueRecipients) {
    notifications.push(await notificationService.createNotification({
      businessId: actor.businessId,
      businessAccountId: actor.businessAccountId,
      recipientMembershipId: recipient.id,
      createdById: actor.userId,
      type: isReview ? BusinessNotificationType.APPOINTMENT_NEEDS_REVIEW : BusinessNotificationType.APPOINTMENT_NEEDS_CONFIRMATION,
      priority: BusinessNotificationPriority.HIGH,
      title: isReview ? "Appointment needs review" : "Appointment needs confirmation",
      message,
      entityType: BusinessNotificationEntityType.APPOINTMENT,
      entityId: appointment.id,
      actions: isReview ? [...APPOINTMENT_REVIEW_ACTIONS] : [...APPOINTMENT_CONFIRMATION_ACTIONS],
      deferSideEffects: true,
      metadata: {
        appointmentId: appointment.id,
        leadId: appointment.leadId,
        conversationId: appointment.conversationId,
        source: appointment.source,
        status: appointment.status,
      },
    }, tx));
  }
  return notifications;
}

async function createOutcomeRequiredNotifications(tx: Prisma.TransactionClient, actor: AppointmentActor, appointment: Prisma.AppointmentGetPayload<{ include: typeof appointmentInclude }>) {
  if (appointment.status !== AppointmentStatus.NEEDS_OUTCOME_CONFIRMATION) return [];
  const uniqueRecipients = await notificationRecipients(tx, actor, appointment.assignedStaffId);
  const message = outcomeNotificationMessage(appointment);
  const notifications = [];
  for (const recipient of uniqueRecipients) {
    notifications.push(await notificationService.createNotification({
      businessId: actor.businessId,
      businessAccountId: actor.businessAccountId,
      recipientMembershipId: recipient.id,
      createdById: actor.userId,
      type: BusinessNotificationType.APPOINTMENT_OUTCOME_REQUIRED,
      priority: BusinessNotificationPriority.HIGH,
      title: "Appointment outcome needed",
      message,
      entityType: BusinessNotificationEntityType.APPOINTMENT,
      entityId: appointment.id,
      actions: [...APPOINTMENT_OUTCOME_ACTIONS],
      deferSideEffects: true,
      metadata: {
        appointmentId: appointment.id,
        leadId: appointment.leadId,
        conversationId: appointment.conversationId,
        source: appointment.source,
        status: appointment.status,
      },
    }, tx));
  }
  return notifications;
}

async function createStaffAssignmentNotifications(
  tx: Prisma.TransactionClient,
  actor: AppointmentActor,
  appointment: Prisma.AppointmentGetPayload<{ include: typeof appointmentInclude }>,
  type: BusinessNotificationType,
) {
  const uniqueRecipients = await notificationRecipients(tx, actor, appointment.assignedStaffId);
  const staffName = appointment.assignedStaff?.user
    ? `${appointment.assignedStaff.user.firstName} ${appointment.assignedStaff.user.lastName}`.trim()
    : "the assigned staff member";
  const notifications = [];
  for (const recipient of uniqueRecipients) {
    const isAssignedStaff = recipient.id === appointment.assignedStaffId;
    notifications.push(await notificationService.createNotification({
      businessId: actor.businessId,
      businessAccountId: actor.businessAccountId,
      recipientMembershipId: recipient.id,
      createdById: actor.userId,
      type: type === BusinessNotificationType.APPOINTMENT_AUTO_CONFIRMED ? BusinessNotificationType.APPOINTMENT_CONFIRMED : BusinessNotificationType.APPOINTMENT_ASSIGNED,
      priority: type === BusinessNotificationType.APPOINTMENT_AUTO_CONFIRMED ? BusinessNotificationPriority.NORMAL : BusinessNotificationPriority.NORMAL,
      title: type === BusinessNotificationType.APPOINTMENT_AUTO_CONFIRMED ? "Appointment confirmed" : "New appointment assigned",
      message: type === BusinessNotificationType.APPOINTMENT_AUTO_CONFIRMED && !appointment.assignedStaffId
        ? "Appointment confirmed."
        : isAssignedStaff
        ? `You have been assigned to ${appointment.title}${appointment.customerName ? ` with ${appointment.customerName}` : ""}.`
        : `Appointment confirmed and assigned to ${staffName}.`,
      entityType: BusinessNotificationEntityType.APPOINTMENT,
      entityId: appointment.id,
      actions: [...APPOINTMENT_ASSIGNED_ACTIONS],
      deferSideEffects: true,
      metadata: {
        appointmentId: appointment.id,
        leadId: appointment.leadId,
        conversationId: appointment.conversationId,
        assignedStaffId: appointment.assignedStaffId,
        status: appointment.status,
      },
    }, tx));
  }
  return notifications;
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
        status: { in: STAFF_CONFLICT_BLOCKING_STATUSES },
        startTime: { lt: endTime },
        endTime: { gt: startTime },
        ...(input.excludeAppointmentId ? { id: { not: input.excludeAppointmentId } } : {}),
      },
      select: { id: true, title: true, startTime: true, endTime: true },
    });
    if (conflict) {
      return { available: false, reason: "APPOINTMENT_STAFF_UNAVAILABLE", message: "The assigned staff member already has an appointment at this time.", suggestedSlots: [] as unknown[], startTime, endTime, durationMinutes, warnings: [] as string[], conflict };
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
  return subscription;
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
  if (action === AppointmentActivityType.APPOINTMENT_MISSED) return "Appointment marked missed.";
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

async function publishNotificationEvents(
  actor: AppointmentActor,
  appointment: { id: string; leadId: string | null; conversationId: string | null; assignedStaffId: string | null; status: AppointmentStatus; startTime: Date; endTime: Date; updatedAt: Date },
  notifications: Array<{ id: string; recipientMembershipId: string; recipientUserId: string; type: BusinessNotificationType; priority: BusinessNotificationPriority; status: BusinessNotificationStatus; title: string; message: string; entityType?: BusinessNotificationEntityType | null; entityId?: string | null; actions?: Prisma.JsonValue | null; createdAt: Date }>,
) {
  if (appointment.status === AppointmentStatus.PENDING_BUSINESS_CONFIRMATION || appointment.status === AppointmentStatus.NEEDS_OUTCOME_CONFIRMATION) {
    realtimeService.publish({
      type: appointment.status === AppointmentStatus.NEEDS_OUTCOME_CONFIRMATION
        ? "business.appointment.outcome_required"
        : "business.appointment.confirmation_required",
      businessId: actor.businessId,
      conversationId: appointment.conversationId ?? undefined,
      leadId: appointment.leadId ?? undefined,
      assignedStaffId: appointment.assignedStaffId,
      staffMembershipIds: notifications.map((notification) => notification.recipientMembershipId),
      payload: {
        businessId: actor.businessId,
        appointmentId: appointment.id,
        status: appointment.status,
        startTime: appointment.startTime.toISOString(),
        endTime: appointment.endTime.toISOString(),
        updatedAt: appointment.updatedAt.toISOString(),
      },
    });
  }
  for (const notification of notifications) {
    await Promise.all([
      cacheService.delByPattern(`business:${actor.businessId}:notifications:list:${notification.recipientMembershipId}:*`),
      cacheService.delByPattern(`business:${actor.businessId}:notifications:counts:${notification.recipientMembershipId}`),
    ]);
    realtimeService.publish({
      type: "business.notification.created",
      businessId: actor.businessId,
      staffMembershipIds: [notification.recipientMembershipId],
      payload: {
        notificationId: notification.id,
        type: notification.type,
        priority: notification.priority,
        status: notification.status,
        title: notification.title,
        message: notification.message,
        entityType: notification.entityType ?? null,
        entityId: notification.entityId ?? null,
        actions: notification.actions ?? [],
        appointmentId: appointment.id,
        createdAt: notification.createdAt.toISOString(),
      },
    });
    await auditService.log({
      action: AuditAction.NOTIFICATION_CREATED,
      businessId: actor.businessId,
      userId: actor.userId,
      metadata: json({
        notificationId: notification.id,
        businessId: actor.businessId,
        recipientMembershipId: notification.recipientMembershipId,
        type: notification.type,
        entityType: notification.entityType ?? null,
        entityId: notification.entityId ?? null,
      }),
    });
  }
}

async function markDueAppointmentsForOutcome(actor: AppointmentActor, appointmentIds?: string[]) {
  const threshold = new Date(Date.now() - OUTCOME_CONFIRMATION_GRACE_MS);
  const dueAppointments = await prisma.appointment.findMany({
    where: {
      ...accessWhere(actor),
      ...(appointmentIds ? { id: { in: appointmentIds } } : {}),
      status: { in: ACTIVE_APPOINTMENT_STATUSES },
      endTime: { lt: threshold },
      outcomeConfirmedAt: null,
    },
    include: appointmentInclude,
    take: 50,
  });
  for (const appointment of dueAppointments) {
    if (!OUTCOME_REQUIRED_SOURCE_STATUSES.has(appointment.status)) continue;
    let notifications: Array<{ id: string; recipientMembershipId: string; recipientUserId: string; type: BusinessNotificationType; priority: BusinessNotificationPriority; status: BusinessNotificationStatus; title: string; message: string; createdAt: Date }> = [];
    const updated = await prisma.$transaction(async (tx) => {
      const record = await tx.appointment.update({
        where: { id: appointment.id },
        data: {
          status: AppointmentStatus.NEEDS_OUTCOME_CONFIRMATION,
          outcomeRequiredAt: new Date(appointment.endTime.getTime() + OUTCOME_CONFIRMATION_GRACE_MS),
          updatedById: actor.userId,
        },
        include: appointmentInclude,
      });
      await logAppointmentActivity(tx, actor, appointment.id, AppointmentActivityType.APPOINTMENT_OUTCOME_REQUIRED, "Appointment outcome confirmation is required.", {
        previousStatus: appointment.status,
        newStatus: record.status,
        endTime: appointment.endTime,
        outcomeRequiredAt: record.outcomeRequiredAt,
      });
      await logLeadAppointmentActivity(tx, actor, record.leadId, LeadActivityAction.APPOINTMENT_UPDATED, {
        appointmentId: appointment.id,
        previousStatus: appointment.status,
        newStatus: record.status,
        outcomeRequiredAt: record.outcomeRequiredAt,
      });
      notifications = await createOutcomeRequiredNotifications(tx, actor, record);
      for (const notification of notifications) {
        await tx.auditLog.create({
          data: {
            action: AuditAction.APPOINTMENT_NOTIFICATION_CREATED,
            businessId: actor.businessId,
            userId: actor.userId,
            metadata: json({
              appointmentId: record.id,
              notificationId: notification.id,
              recipientMembershipId: notification.recipientMembershipId,
              type: notification.type,
              priority: notification.priority,
            }),
          },
        });
      }
      return record;
    }, TRANSACTION_OPTIONS);
    await Promise.all([
      audit(actor, AuditAction.APPOINTMENT_OUTCOME_REQUIRED, updated.id, { ipAddress: undefined, userAgent: undefined }, {
        oldStatus: appointment.status,
        newStatus: updated.status,
        outcomeRequiredAt: updated.outcomeRequiredAt,
      }),
      publishAndInvalidate(actor, "business.appointment.outcome_required", updated),
    ]);
    await publishNotificationEvents(actor, updated, notifications);
  }
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
  return withAvailableActions(appointment);
}

async function createAppointmentFromValidatedInput(actor: AppointmentActor, input: CreateAppointmentInput, context: Omit<AuditInput, "action">) {
  requireManager(actor);
  const business = await validateBusiness(actor);
  const subscription = await activeSubscription(actor);
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
  const canDeferStaffConflict = (
    (
      (subscription.plan.code !== PlanCode.BASIC && business.appointmentConfirmationMode === AppointmentConfirmationMode.AUTO_CONFIRM_WHEN_STAFF_ASSIGNED)
      || (subscription.plan.code === PlanCode.PREMIUM && business.appointmentConfirmationMode === AppointmentConfirmationMode.AUTO_CONFIRM_SAFE_BOOKINGS)
    )
    && input.source !== AppointmentSource.MANUAL
    && availability.reason === "APPOINTMENT_STAFF_UNAVAILABLE"
    && Boolean(assignedStaffId)
  );
  if (!availability.available && !canDeferStaffConflict) {
    throw new AppError(422, availability.message ?? "Appointment slot is unavailable.", availability.reason ?? "APPOINTMENT_SLOT_UNAVAILABLE", { availability });
  }
  const location = statusForLocation(input.locationType, input.location ?? null);
  const customerName = input.customerName ?? linked.lead?.fullName ?? null;
  const customerPhone = input.customerPhone ?? linked.lead?.phone ?? null;
  const customerEmail = input.customerEmail ?? linked.lead?.email ?? null;

  let confirmationNotifications: Array<{ id: string; recipientMembershipId: string; recipientUserId: string; type: BusinessNotificationType; priority: BusinessNotificationPriority; status: BusinessNotificationStatus; title: string; message: string; createdAt: Date }> = [];
  let assignmentNotifications: Array<{ id: string; recipientMembershipId: string; recipientUserId: string; type: BusinessNotificationType; priority: BusinessNotificationPriority; status: BusinessNotificationStatus; title: string; message: string; createdAt: Date }> = [];
  const appointment = await prisma.$transaction(async (tx) => {
    await validateBusiness(actor, tx);
    await incrementAppointmentUsage(tx, actor);
    const confirmation = confirmationForCreation(subscription.plan.code, business.appointmentConfirmationMode, input.source, location, assignedStaffId, availability);
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
        status: confirmation.status,
        source: input.source,
        locationType: input.locationType,
        location: input.location,
        locationStatus: confirmation.locationStatus,
        humanConfirmationRequired: confirmation.humanConfirmationRequired,
        humanConfirmationReason: confirmation.humanConfirmationReason,
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
    if (created.status === AppointmentStatus.PENDING_BUSINESS_CONFIRMATION) {
      await logAppointmentActivity(tx, actor, created.id, AppointmentActivityType.APPOINTMENT_CONFIRMATION_REQUIRED, "Business confirmation is required before this appointment is confirmed.", {
        reason: AppointmentHumanConfirmationReason.BUSINESS_CONFIRMATION_REQUIRED,
        source: created.source,
      });
    }
    if (created.status === AppointmentStatus.PENDING_BUSINESS_CONFIRMATION || created.status === AppointmentStatus.NEEDS_HUMAN_CONFIRMATION) {
      confirmationNotifications = await createConfirmationNotifications(tx, actor, created);
      for (const notification of confirmationNotifications) {
        await tx.auditLog.create({
          data: {
            action: AuditAction.APPOINTMENT_NOTIFICATION_CREATED,
            businessId: actor.businessId,
            userId: actor.userId,
            metadata: json({
              appointmentId: created.id,
              notificationId: notification.id,
              recipientMembershipId: notification.recipientMembershipId,
              source: created.source,
              priority: notification.priority,
            }),
          },
        });
      }
    }
    if (created.humanConfirmationReason === AppointmentHumanConfirmationReason.AVAILABILITY_CONFLICT) {
      await logAppointmentActivity(tx, actor, created.id, AppointmentActivityType.APPOINTMENT_STAFF_CONFLICT_DETECTED, "Assigned staff conflict detected.", {
        assignedStaffId: created.assignedStaffId,
        startTime: created.startTime,
        endTime: created.endTime,
        source: created.source,
      });
      await tx.auditLog.create({
        data: {
          action: AuditAction.APPOINTMENT_STAFF_CONFLICT_DETECTED,
          businessId: actor.businessId,
          userId: actor.userId,
          metadata: json({
            appointmentId: created.id,
            assignedStaffId: created.assignedStaffId,
            confirmationMode: business.appointmentConfirmationMode,
            oldStatus: null,
            newStatus: created.status,
          }),
        },
      });
    }
    if (created.status === AppointmentStatus.NEEDS_HUMAN_CONFIRMATION && business.appointmentConfirmationMode === AppointmentConfirmationMode.AUTO_CONFIRM_SAFE_BOOKINGS) {
      await logAppointmentActivity(tx, actor, created.id, AppointmentActivityType.APPOINTMENT_SAFE_CONFIRMATION_REJECTED, "Safe auto-confirmation rejected; human confirmation is required.", {
        confirmationMode: business.appointmentConfirmationMode,
        reason: created.humanConfirmationReason,
        source: created.source,
      });
      await logAppointmentActivity(tx, actor, created.id, AppointmentActivityType.APPOINTMENT_HUMAN_CONFIRMATION_REQUIRED, "Appointment needs human confirmation.", {
        confirmationMode: business.appointmentConfirmationMode,
        reason: created.humanConfirmationReason,
      });
      await tx.auditLog.create({
        data: {
          action: AuditAction.APPOINTMENT_SAFE_CONFIRMATION_REJECTED,
          businessId: actor.businessId,
          userId: actor.userId,
          metadata: json({
            appointmentId: created.id,
            businessId: actor.businessId,
            oldStatus: null,
            newStatus: created.status,
            confirmationMode: business.appointmentConfirmationMode,
            reason: created.humanConfirmationReason,
          }),
        },
      });
    }
    if (created.status === AppointmentStatus.CONFIRMED && subscription.plan.code !== PlanCode.BASIC && business.appointmentConfirmationMode === AppointmentConfirmationMode.AUTO_CONFIRM_WHEN_STAFF_ASSIGNED && created.assignedStaffId) {
      await logAppointmentActivity(tx, actor, created.id, AppointmentActivityType.APPOINTMENT_AUTO_CONFIRMED_STAFF_ASSIGNED, "Appointment auto-confirmed because an available staff member was assigned.", {
        assignedStaffId: created.assignedStaffId,
        confirmationMode: business.appointmentConfirmationMode,
        source: created.source,
      });
      assignmentNotifications = await createStaffAssignmentNotifications(tx, actor, created, BusinessNotificationType.APPOINTMENT_AUTO_CONFIRMED);
    }
    if (created.status === AppointmentStatus.CONFIRMED && subscription.plan.code === PlanCode.PREMIUM && business.appointmentConfirmationMode === AppointmentConfirmationMode.AUTO_CONFIRM_SAFE_BOOKINGS) {
      await logAppointmentActivity(tx, actor, created.id, AppointmentActivityType.APPOINTMENT_AUTO_CONFIRMED_SAFE_BOOKING, "Appointment auto-confirmed as a safe booking.", {
        confirmationMode: business.appointmentConfirmationMode,
        assignedStaffId: created.assignedStaffId,
        source: created.source,
      });
      assignmentNotifications = await createStaffAssignmentNotifications(tx, actor, created, BusinessNotificationType.APPOINTMENT_AUTO_CONFIRMED);
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
    ...(appointment.status === AppointmentStatus.PENDING_BUSINESS_CONFIRMATION ? [
      audit(actor, AuditAction.APPOINTMENT_CONFIRMATION_REQUIRED, appointment.id, context, {
        oldStatus: null,
        newStatus: appointment.status,
        source: appointment.source,
        reason: AppointmentHumanConfirmationReason.BUSINESS_CONFIRMATION_REQUIRED,
      }),
    ] : []),
    ...(assignmentNotifications.length > 0 ? [
      audit(
        actor,
        business.appointmentConfirmationMode === AppointmentConfirmationMode.AUTO_CONFIRM_SAFE_BOOKINGS
          ? AuditAction.APPOINTMENT_AUTO_CONFIRMED_SAFE_BOOKING
          : AuditAction.APPOINTMENT_AUTO_CONFIRMED_STAFF_ASSIGNED,
        appointment.id,
        context,
        {
        appointmentId: appointment.id,
        assignedStaffId: appointment.assignedStaffId,
        oldStatus: null,
        newStatus: appointment.status,
        confirmationMode: business.appointmentConfirmationMode,
        },
      ),
    ] : []),
    ...(appointment.status === AppointmentStatus.NEEDS_HUMAN_CONFIRMATION && business.appointmentConfirmationMode === AppointmentConfirmationMode.AUTO_CONFIRM_SAFE_BOOKINGS ? [
      audit(actor, AuditAction.APPOINTMENT_HUMAN_CONFIRMATION_REQUIRED, appointment.id, context, {
        appointmentId: appointment.id,
        oldStatus: null,
        newStatus: appointment.status,
        confirmationMode: business.appointmentConfirmationMode,
        reason: appointment.humanConfirmationReason,
      }),
      publishAndInvalidate(actor, "business.appointment.needs_confirmation", appointment),
    ] : []),
    publishAndInvalidate(actor, "business.appointment.created", appointment),
    ...(assignmentNotifications.length > 0 ? [publishAndInvalidate(actor, "business.appointment.confirmed", appointment)] : []),
  ]);
  await publishNotificationEvents(actor, appointment, confirmationNotifications);
  await publishNotificationEvents(actor, appointment, assignmentNotifications);
  return withAvailableActions(appointment);
}

async function rescheduleAppointmentFromValidatedInput(actor: AppointmentActor, appointmentId: string, input: RescheduleAppointmentInput, context: Omit<AuditInput, "action">) {
  requireManager(actor);
  const rescheduleReason = requireReason(input.reason, "rescheduling");
  const existing = await loadAppointment(actor, appointmentId);
  if (TERMINAL_APPOINTMENT_STATUSES.has(existing.status)) {
    throw new AppError(422, "This appointment cannot be rescheduled in its current status.", "INVALID_APPOINTMENT_STATUS");
  }
  if (appointmentHasEnded(existing)) {
    await prisma.appointmentActivity.create({
      data: {
        businessId: actor.businessId,
        appointmentId,
        actorUserId: actor.userId,
        actorMembershipId: actor.membershipId,
        type: AppointmentActivityType.APPOINTMENT_RESCHEDULE_BLOCKED_PAST,
        message: "Past appointment reschedule was blocked.",
        metadata: json({ status: existing.status, endTime: existing.endTime }),
      },
    });
    await audit(actor, AuditAction.APPOINTMENT_RESCHEDULE_BLOCKED_PAST, appointmentId, context, {
      status: existing.status,
      endTime: existing.endTime,
    });
    throw new AppError(422, "Past appointments cannot be rescheduled. Please record the appointment outcome or create a new appointment.", "APPOINTMENT_CANNOT_RESCHEDULE_PAST");
  }
  if ((existing.rescheduleCount ?? 0) >= 1) {
    await prisma.appointmentActivity.create({
      data: {
        businessId: actor.businessId,
        appointmentId,
        actorUserId: actor.userId,
        actorMembershipId: actor.membershipId,
        type: AppointmentActivityType.APPOINTMENT_RESCHEDULE_LIMIT_REACHED,
        message: "Appointment reschedule limit reached.",
        metadata: json({ rescheduleCount: existing.rescheduleCount }),
      },
    });
    await Promise.all([
      audit(actor, AuditAction.APPOINTMENT_RESCHEDULE_LIMIT_REACHED, appointmentId, context, {
        rescheduleCount: existing.rescheduleCount,
      }),
      publishAndInvalidate(actor, "business.appointment.reschedule_limit_reached", existing),
    ]);
    throw new AppError(422, "This appointment has already been rescheduled once. Please create a new appointment request instead.", "APPOINTMENT_RESCHEDULE_LIMIT_REACHED");
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
        rescheduleCount: { increment: 1 },
        rescheduledAt: new Date(),
        rescheduledById: actor.userId,
        lastRescheduledAt: new Date(),
        lastRescheduledById: actor.membershipId,
        outcomeRequiredAt: null,
        updatedById: actor.userId,
      },
      include: appointmentInclude,
    });
    await logAppointmentActivity(tx, actor, appointmentId, AppointmentActivityType.APPOINTMENT_RESCHEDULED, appointmentMessage(AppointmentActivityType.APPOINTMENT_RESCHEDULED, record), {
      oldDate: existing.appointmentDate,
      oldStartTime: existing.startTime,
      oldEndTime: existing.endTime,
      newDate: record.appointmentDate,
      newStartTime: record.startTime,
      newEndTime: record.endTime,
      rescheduleCount: record.rescheduleCount,
      reasonProvided: true,
      rescheduledById: actor.userId,
      lastRescheduledById: actor.membershipId,
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
      changedFields: ["appointmentDate", "startTime", "endTime", "timezone", "status", "rescheduleReason", "rescheduleCount", "rescheduledAt", "rescheduledById", "lastRescheduledAt", "lastRescheduledById"],
      previousValues: { startTime: existing.startTime, endTime: existing.endTime, timezone: existing.timezone, status: existing.status },
      newValues: { startTime: updated.startTime, endTime: updated.endTime, timezone: updated.timezone, status: updated.status, rescheduleReason, rescheduleCount: updated.rescheduleCount },
    }),
    publishAndInvalidate(actor, "business.appointment.rescheduled", updated),
  ]);
  return withAvailableActions(updated);
}

export const appointmentService = {
  async updateSettings(actor: AppointmentActor, input: AppointmentSettingsInput, context: Omit<AuditInput, "action">) {
    requireManager(actor);
    const subscription = await activeSubscription(actor);
    assertAppointmentConfirmationModeAllowed(subscription.plan.code, input.appointmentConfirmationMode);
    const existing = await validateBusiness(actor);
    const updated = await prisma.business.update({
      where: { id: actor.businessId },
      data: { appointmentConfirmationMode: input.appointmentConfirmationMode },
      select: { id: true, appointmentConfirmationMode: true, updatedAt: true },
    });
    await Promise.all([
      invalidateAppointmentCaches(actor.businessId),
      auditService.log({
        ...context,
        action: AuditAction.APPOINTMENT_CONFIRMATION_MODE_UPDATED,
        businessId: actor.businessId,
        userId: actor.userId,
        metadata: json({
          businessId: actor.businessId,
          oldValue: existing.appointmentConfirmationMode,
          newValue: updated.appointmentConfirmationMode,
          confirmationMode: updated.appointmentConfirmationMode,
          actorUserId: actor.userId,
          actorMembershipId: actor.membershipId,
        }),
      }),
    ]);
    realtimeService.publish({
      type: "business.appointment.updated",
      businessId: actor.businessId,
      payload: {
        businessId: actor.businessId,
        appointmentConfirmationMode: updated.appointmentConfirmationMode,
        updatedAt: updated.updatedAt.toISOString(),
      },
    });
    return { settings: updated };
  },

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
    await markDueAppointmentsForOutcome(actor);
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
      data: withAvailableActionsList(data),
      summary: { total: Object.values(byStatus).reduce((sum, count) => sum + count, 0), byStatus },
      pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
    };
    await cacheService.set(key, result, 60);
    return result;
  },

  async calendar(actor: AppointmentActor, query: AppointmentCalendarQuery) {
    await markDueAppointmentsForOutcome(actor);
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
        rescheduleCount: true,
        outcomeRequiredAt: true,
        outcomeConfirmedAt: true,
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
    const result = { view: query.view, dateFrom: query.dateFrom, dateTo: query.dateTo, appointments: withAvailableActionsList(appointments) };
    await cacheService.set(key, result, 60);
    return result;
  },

  async detail(actor: AppointmentActor, appointmentId: string) {
    await markDueAppointmentsForOutcome(actor, [appointmentId]);
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
      appointment: withAvailableActions(appointment),
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

  async confirm(actor: AppointmentActor, appointmentId: string, note: string | null | undefined, context: Omit<AuditInput, "action">) {
    requireManager(actor);
    const existing = await loadAppointment(actor, appointmentId);
    if (!CONFIRMABLE_APPOINTMENT_STATUSES.has(existing.status)) {
      throw new AppError(422, "This appointment cannot be confirmed.", "APPOINTMENT_CANNOT_CONFIRM");
    }
    const updated = await prisma.$transaction(async (tx) => {
      const record = await tx.appointment.update({
        where: { id: appointmentId },
        data: {
          status: AppointmentStatus.CONFIRMED,
          confirmedAt: new Date(),
          confirmedById: actor.userId,
          humanConfirmationRequired: false,
          humanConfirmationReason: null,
          updatedById: actor.userId,
        },
        include: appointmentInclude,
      });
      await logAppointmentActivity(tx, actor, appointmentId, AppointmentActivityType.APPOINTMENT_CONFIRMED, "Appointment confirmed.", {
        previousStatus: existing.status,
        newStatus: record.status,
        note: note ?? null,
      });
      await logAppointmentActivity(tx, actor, appointmentId, AppointmentActivityType.APPOINTMENT_STATUS_CHANGED, "Appointment status changed to CONFIRMED.", {
        previousStatus: existing.status,
        newStatus: record.status,
      });
      await logLeadAppointmentActivity(tx, actor, record.leadId, LeadActivityAction.APPOINTMENT_UPDATED, {
        appointmentId,
        previousStatus: existing.status,
        newStatus: record.status,
      });
      if (record.conversationId && record.leadId) {
        await createSystemMessage({
          businessId: actor.businessId,
          leadId: record.leadId,
          conversationId: record.conversationId,
          content: "Appointment confirmed.",
          metadata: json({ appointmentId, type: "APPOINTMENT_CONFIRMED" }),
        }, tx);
      }
      return record;
    }, TRANSACTION_OPTIONS);
    await Promise.all([
      audit(actor, AuditAction.APPOINTMENT_CONFIRMED, updated.id, context, {
        oldStatus: existing.status,
        newStatus: updated.status,
        source: updated.source,
        noteProvided: Boolean(note?.trim()),
      }),
      publishAndInvalidate(actor, "business.appointment.confirmed", updated),
    ]);
    return withAvailableActions(updated);
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
    return withAvailableActions(updated);
  },

  async complete(actor: AppointmentActor, appointmentId: string, completedNote: string | null | undefined, context: Omit<AuditInput, "action">) {
    const existing = await loadAppointment(actor, appointmentId);
    if (!isManager(actor) && existing.assignedStaffId !== actor.membershipId) throw new AppError(403, "You do not have permission to manage this appointment.", "FORBIDDEN");
    if (existing.status === AppointmentStatus.COMPLETED || existing.status === AppointmentStatus.NO_SHOW || existing.status === AppointmentStatus.MISSED) {
      throw new AppError(422, "This appointment already has an outcome recorded.", "APPOINTMENT_OUTCOME_ALREADY_RECORDED");
    }
    if (existing.status === AppointmentStatus.CANCELLED) {
      throw new AppError(422, "This appointment cannot be completed in its current status.", "APPOINTMENT_CANNOT_COMPLETE");
    }
    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const record = await tx.appointment.update({
        where: { id: appointmentId },
        data: {
          status: AppointmentStatus.COMPLETED,
          completedAt: now,
          completedById: actor.userId,
          outcomeConfirmedAt: now,
          outcomeConfirmedById: actor.membershipId,
          outcomeNote: completedNote?.trim() || null,
          completedNote: completedNote?.trim() || null,
          updatedById: actor.userId,
        },
        include: appointmentInclude,
      });
      await logAppointmentActivity(tx, actor, appointmentId, AppointmentActivityType.APPOINTMENT_COMPLETED, appointmentMessage(AppointmentActivityType.APPOINTMENT_COMPLETED, record), {
        oldStatus: existing.status,
        newStatus: record.status,
        outcomeConfirmedAt: record.outcomeConfirmedAt,
        noteProvided: Boolean(completedNote?.trim()),
      });
      await logLeadAppointmentActivity(tx, actor, record.leadId, LeadActivityAction.APPOINTMENT_COMPLETED, { appointmentId, conversationId: record.conversationId, noteProvided: Boolean(completedNote?.trim()) });
      return record;
    }, TRANSACTION_OPTIONS);
    await Promise.all([
      audit(actor, AuditAction.APPOINTMENT_COMPLETED, updated.id, context, { previousValues: { status: existing.status }, newValues: { status: updated.status }, noteProvided: Boolean(completedNote?.trim()) }),
      publishAndInvalidate(actor, "business.appointment.completed", updated),
    ]);
    return withAvailableActions(updated);
  },

  async noShow(actor: AppointmentActor, appointmentId: string, noShowReason: string | null | undefined, context: Omit<AuditInput, "action">) {
    const existing = await loadAppointment(actor, appointmentId);
    if (!isManager(actor) && existing.assignedStaffId !== actor.membershipId) throw new AppError(403, "You do not have permission to manage this appointment.", "FORBIDDEN");
    if (existing.status === AppointmentStatus.COMPLETED || existing.status === AppointmentStatus.MISSED || existing.status === AppointmentStatus.NO_SHOW) {
      throw new AppError(422, "This appointment already has an outcome recorded.", "APPOINTMENT_OUTCOME_ALREADY_RECORDED");
    }
    if (existing.status === AppointmentStatus.CANCELLED) {
      throw new AppError(422, "This appointment cannot be marked no-show in its current status.", "APPOINTMENT_CANNOT_NO_SHOW");
    }
    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const record = await tx.appointment.update({
        where: { id: appointmentId },
        data: {
          status: AppointmentStatus.NO_SHOW,
          outcomeConfirmedAt: now,
          outcomeConfirmedById: actor.membershipId,
          outcomeNote: noShowReason?.trim() || null,
          noShowReason: noShowReason?.trim() || null,
          updatedById: actor.userId,
        },
        include: appointmentInclude,
      });
      await logAppointmentActivity(tx, actor, appointmentId, AppointmentActivityType.APPOINTMENT_NO_SHOW, appointmentMessage(AppointmentActivityType.APPOINTMENT_NO_SHOW, record), {
        oldStatus: existing.status,
        newStatus: record.status,
        outcomeConfirmedAt: record.outcomeConfirmedAt,
        noteProvided: Boolean(noShowReason?.trim()),
      });
      await logLeadAppointmentActivity(tx, actor, record.leadId, LeadActivityAction.APPOINTMENT_NO_SHOW, { appointmentId, conversationId: record.conversationId, noteProvided: Boolean(noShowReason?.trim()) });
      return record;
    }, TRANSACTION_OPTIONS);
    await Promise.all([
      audit(actor, AuditAction.APPOINTMENT_NO_SHOW, updated.id, context, { previousValues: { status: existing.status }, newValues: { status: updated.status }, noteProvided: Boolean(noShowReason?.trim()) }),
      publishAndInvalidate(actor, "business.appointment.no_show", updated),
    ]);
    return withAvailableActions(updated);
  },

  async missed(actor: AppointmentActor, appointmentId: string, missedReason: string | null | undefined, context: Omit<AuditInput, "action">) {
    const existing = await loadAppointment(actor, appointmentId);
    if (!isManager(actor) && existing.assignedStaffId !== actor.membershipId) throw new AppError(403, "You do not have permission to manage this appointment.", "FORBIDDEN");
    if (existing.status === AppointmentStatus.COMPLETED || existing.status === AppointmentStatus.NO_SHOW || existing.status === AppointmentStatus.MISSED) {
      throw new AppError(422, "This appointment already has an outcome recorded.", "APPOINTMENT_OUTCOME_ALREADY_RECORDED");
    }
    if (existing.status === AppointmentStatus.CANCELLED) {
      throw new AppError(422, "This appointment cannot be marked missed in its current status.", "APPOINTMENT_CANNOT_MARK_MISSED");
    }
    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const record = await tx.appointment.update({
        where: { id: appointmentId },
        data: {
          status: AppointmentStatus.MISSED,
          outcomeConfirmedAt: now,
          outcomeConfirmedById: actor.membershipId,
          outcomeNote: missedReason?.trim() || null,
          missedReason: missedReason?.trim() || null,
          updatedById: actor.userId,
        },
        include: appointmentInclude,
      });
      await logAppointmentActivity(tx, actor, appointmentId, AppointmentActivityType.APPOINTMENT_MISSED, "Appointment marked missed.", {
        oldStatus: existing.status,
        newStatus: record.status,
        outcomeConfirmedAt: record.outcomeConfirmedAt,
        noteProvided: Boolean(missedReason?.trim()),
      });
      await logLeadAppointmentActivity(tx, actor, record.leadId, LeadActivityAction.APPOINTMENT_MISSED, { appointmentId, conversationId: record.conversationId, noteProvided: Boolean(missedReason?.trim()) });
      return record;
    }, TRANSACTION_OPTIONS);
    await Promise.all([
      audit(actor, AuditAction.APPOINTMENT_MISSED, updated.id, context, { previousValues: { status: existing.status }, newValues: { status: updated.status }, noteProvided: Boolean(missedReason?.trim()) }),
      publishAndInvalidate(actor, "business.appointment.missed", updated),
    ]);
    return withAvailableActions(updated);
  },

  async assign(actor: AppointmentActor, appointmentId: string, assignedStaffId: string | null, context: Omit<AuditInput, "action">) {
    requireManager(actor);
    const existing = await loadAppointment(actor, appointmentId);
    await validateAssignee(actor.businessId, assignedStaffId);
    const business = await validateBusiness(actor);
    const subscription = await activeSubscription(actor);
    let shouldAutoConfirm = false;
    if (
      assignedStaffId
      && existing.status === AppointmentStatus.PENDING_BUSINESS_CONFIRMATION
      && subscription.plan.code !== PlanCode.BASIC
      && business.appointmentConfirmationMode === AppointmentConfirmationMode.AUTO_CONFIRM_WHEN_STAFF_ASSIGNED
      && (existing.humanConfirmationReason === AppointmentHumanConfirmationReason.STAFF_REQUIRED || existing.humanConfirmationReason === null)
      && existing.locationStatus !== AppointmentLocationStatus.NEEDS_CONFIRMATION
    ) {
      const existingDurationMinutes = Math.max(1, Math.round((existing.endTime.getTime() - existing.startTime.getTime()) / 60_000));
      const availability = await checkSlot({
        businessId: actor.businessId,
        serviceId: existing.serviceId ?? undefined,
        date: dateInTimezone(existing.startTime, existing.timezone),
        time: timeInTimezone(existing.startTime, existing.timezone),
        timezone: existing.timezone,
        assignedStaffId,
        durationMinutes: existing.service?.durationMinutes ?? existingDurationMinutes,
        excludeAppointmentId: appointmentId,
      });
      shouldAutoConfirm = availability.available && !appointmentHasEnded(existing);
    }
    let assignmentNotifications: Array<{ id: string; recipientMembershipId: string; recipientUserId: string; type: BusinessNotificationType; priority: BusinessNotificationPriority; status: BusinessNotificationStatus; title: string; message: string; createdAt: Date }> = [];
    const updated = await prisma.$transaction(async (tx) => {
      const record = await tx.appointment.update({
        where: { id: appointmentId },
        data: {
          assignedStaffId,
          ...(shouldAutoConfirm ? {
            status: AppointmentStatus.CONFIRMED,
            confirmedAt: new Date(),
            confirmedById: actor.userId,
            humanConfirmationRequired: false,
            humanConfirmationReason: null,
          } : {}),
          updatedById: actor.userId,
        },
        include: appointmentInclude,
      });
      await logAppointmentActivity(tx, actor, appointmentId, AppointmentActivityType.APPOINTMENT_STAFF_ASSIGNED, "Appointment staff assignment updated.", {
        previousAssignedStaffId: existing.assignedStaffId,
        newAssignedStaffId: assignedStaffId,
      });
      if (shouldAutoConfirm) {
        await logAppointmentActivity(tx, actor, appointmentId, AppointmentActivityType.APPOINTMENT_AUTO_CONFIRMED_STAFF_ASSIGNED, "Appointment auto-confirmed after staff assignment.", {
          assignedStaffId,
          confirmationMode: business.appointmentConfirmationMode,
          previousStatus: existing.status,
          newStatus: record.status,
        });
      }
      await logLeadAppointmentActivity(tx, actor, record.leadId, LeadActivityAction.APPOINTMENT_ASSIGNED, {
        appointmentId,
        previousAssignedStaffId: existing.assignedStaffId,
        newAssignedStaffId: assignedStaffId,
      });
      if (assignedStaffId) {
        assignmentNotifications = await createStaffAssignmentNotifications(
          tx,
          actor,
          record,
          shouldAutoConfirm ? BusinessNotificationType.APPOINTMENT_AUTO_CONFIRMED : BusinessNotificationType.APPOINTMENT_ASSIGNED,
        );
      }
      return record;
    }, TRANSACTION_OPTIONS);
    await Promise.all([
      audit(actor, AuditAction.APPOINTMENT_STAFF_ASSIGNED, updated.id, context, {
        previousValues: { assignedStaffId: existing.assignedStaffId },
        newValues: { assignedStaffId: updated.assignedStaffId },
        confirmationMode: business.appointmentConfirmationMode,
      }),
      ...(shouldAutoConfirm ? [
        audit(actor, AuditAction.APPOINTMENT_AUTO_CONFIRMED_STAFF_ASSIGNED, updated.id, context, {
          assignedStaffId: updated.assignedStaffId,
          oldStatus: existing.status,
          newStatus: updated.status,
          confirmationMode: business.appointmentConfirmationMode,
        }),
      ] : []),
      publishAndInvalidate(actor, "business.appointment.assigned", updated),
      ...(shouldAutoConfirm ? [publishAndInvalidate(actor, "business.appointment.confirmed", updated)] : []),
    ]);
    await publishNotificationEvents(actor, updated, assignmentNotifications);
    return withAvailableActions(updated);
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

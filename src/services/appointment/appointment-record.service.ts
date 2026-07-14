import { AppointmentActivityType, AppointmentStatus, AuditAction, BusinessNotificationEntityType, BusinessNotificationPriority, BusinessNotificationStatus, BusinessNotificationType, LeadActivityAction, Prisma } from "@prisma/client";
import { AppointmentActor } from "./appointment.types";
import { RealtimeEventType, realtimeService } from "../realtime.service";
import { OUTCOME_CONFIRMATION_GRACE_MS, OUTCOME_REQUIRED_SOURCE_STATUSES, TRANSACTION_OPTIONS } from "./appointment.constants";
import { AppError } from "../../utils/errors";
import { invalidateAppointmentCaches } from "./appointment-cache.service";
import { prisma } from "../../config/prisma";
import { auditService, AuditInput } from "../audit.service";
import { cacheService } from "../cache.service";
import { invalidateConversationCache } from "../conversation.service";
import { createOutcomeRequiredNotifications } from "./appointment-notification.service";
import { accessWhere } from "./appointment-access.service";
import { appointmentInclude } from "./appointment.include";
import { ACTIVE_APPOINTMENT_STATUSES } from "./appointment.constants";
import { withAvailableActions } from "./appointment-status.service";

export function appointmentMessage(action: AppointmentActivityType, appointment: { title: string; startTime: Date; timezone: string }, detail?: string | null) {
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

export async function logAppointmentActivity(
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

export async function logLeadAppointmentActivity(
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

export async function publishAndInvalidate(
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

export async function publishNotificationEvents(
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

export async function markDueAppointmentsForOutcome(actor: AppointmentActor, appointmentIds?: string[]) {
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
            actorMembershipId: actor.membershipId,
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

export async function audit(
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
    actorMembershipId: actor.membershipId,
    metadata: json({ businessId: actor.businessId, appointmentId, actorUserId: actor.userId, actorMembershipId: actor.membershipId, ...metadata }),
  });
}

export async function updateAppointmentIfUnchanged(
  tx: Prisma.TransactionClient,
  actor: AppointmentActor,
  existing: { id: string; status: AppointmentStatus; updatedAt: Date },
  data: Prisma.AppointmentUncheckedUpdateInput,
) {
  const changed = await tx.appointment.updateMany({
    where: {
      id: existing.id,
      businessId: actor.businessId,
      status: existing.status,
      updatedAt: existing.updatedAt,
    },
    data: { updatedAt: new Date() },
  });
  if (changed.count !== 1) {
    throw new AppError(409, "Appointment changed. Refresh and try again.", "APPOINTMENT_STATE_CHANGED");
  }
  return tx.appointment.update({
    where: { id: existing.id },
    data,
    include: appointmentInclude,
  });
}

export async function loadAppointment(actor: AppointmentActor, appointmentId: string) {
  const appointment = await prisma.appointment.findFirst({
    where: { id: appointmentId, ...accessWhere(actor) },
    include: appointmentInclude,
  });
  if (!appointment) throw new AppError(404, "Appointment not found.", "APPOINTMENT_NOT_FOUND");
  return withAvailableActions(appointment);
}


export function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

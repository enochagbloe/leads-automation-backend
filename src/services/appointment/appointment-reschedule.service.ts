import { AppointmentActivityType, AuditAction, AppointmentStatus, LeadActivityAction, BusinessNotificationType, BusinessNotificationPriority, BusinessNotificationStatus, AppointmentRescheduleRequestStatus, AppointmentRescheduleRequestedBy } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError } from "../../utils/errors";
import { RescheduleAppointmentInput, RequestAppointmentRescheduleInput, ApproveAppointmentRescheduleRequestInput, DeclineAppointmentRescheduleRequestInput } from "../../validation/appointment.schemas";
import { AuditInput, auditService } from "../audit.service";
import { followUpService } from "../follow-up.service";
import { createSystemMessage } from "../message.service";
import { checkSlot, lockAppointmentAvailabilityScope } from "./appointment-availability.service";
import { canSendAutomaticCustomerAppointmentMessage, sendAiAppointmentRescheduledCustomerMessage, appointmentMessageProviderError, sendAppointmentRescheduleRequestAcknowledgementMessage, sendAppointmentRescheduleRequestDeclinedCustomerMessage } from "./appointment-customer-notification.service";
import { appointmentDateUtc, zonedDateTimeToUtc, dateInTimezone, timeInTimezone } from "./appointment-date-time.utils";
import { createRescheduleRequestNotifications } from "./appointment-notification.service";
import { appointmentMessage, audit, json, loadAppointment, logAppointmentActivity, logLeadAppointmentActivity, publishAndInvalidate, publishNotificationEvents, updateAppointmentIfUnchanged } from "./appointment-record.service";
import { TERMINAL_APPOINTMENT_STATUSES, TRANSACTION_OPTIONS } from "./appointment.constants";
import { AppointmentActor } from "./appointment.types";
import { requireManager, requireReason } from "./appointment-access.service";
import { appointmentHasEnded, withAvailableActions } from "./appointment-status.service";
import { appointmentInclude } from "./appointment.include";

export async function rescheduleAppointmentFromValidatedInput(actor: AppointmentActor, appointmentId: string, input: RescheduleAppointmentInput, context: Omit<AuditInput, "action">) {
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
  const updated = await prisma.$transaction(async (tx) => {
    await lockAppointmentAvailabilityScope(tx, { businessId: actor.businessId, assignedStaffId: existing.assignedStaffId, date: input.date });
    const availability = await checkSlot({
      businessId: actor.businessId,
      serviceId: existing.serviceId ?? undefined,
      date: input.date,
      time: input.time,
      timezone: input.timezone,
      assignedStaffId: existing.assignedStaffId,
      durationMinutes: input.durationMinutes ?? existing.service?.durationMinutes ?? existingDurationMinutes,
      excludeAppointmentId: appointmentId,
    }, tx);
    if (!availability.available) {
      throw new AppError(422, availability.message ?? "Appointment slot is unavailable.", availability.reason ?? "APPOINTMENT_SLOT_UNAVAILABLE", { availability });
    }
    const record = await updateAppointmentIfUnchanged(tx, actor, existing, {
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
  const appointmentTimeChanged = existing.startTime.getTime() !== updated.startTime.getTime()
    || existing.endTime.getTime() !== updated.endTime.getTime()
    || existing.timezone !== updated.timezone;
  if (
    canSendAutomaticCustomerAppointmentMessage(existing)
    && (existing.status === AppointmentStatus.CONFIRMED || existing.status === AppointmentStatus.RESCHEDULED)
    && appointmentTimeChanged
  ) {
    await sendAiAppointmentRescheduledCustomerMessage(actor, updated, context).catch((error: unknown) =>
      auditService.log({
        ...context,
        action: AuditAction.WHATSAPP_MESSAGE_SEND_FAILED,
        businessId: actor.businessId,
        userId: actor.userId,
        actorMembershipId: actor.membershipId,
        metadata: json({
          source: "APPOINTMENT_LIFECYCLE_NOTIFICATION",
          eventType: "APPOINTMENT_RESCHEDULED",
          appointmentId: updated.id,
          conversationId: updated.conversationId,
          leadId: updated.leadId,
          failureReason: appointmentMessageProviderError(error),
        }),
      }));
  }
  await followUpService.cancelAppointmentReminderJobs({ businessId: actor.businessId, appointmentId, reason: "APPOINTMENT_RESCHEDULED" });
  await followUpService.cancelPostAppointmentFollowUpJobs({ businessId: actor.businessId, appointmentId, reason: "APPOINTMENT_RESCHEDULED" });
  await followUpService.scheduleAppointmentReminder(updated);
  return withAvailableActions(updated);
}

function requestedRescheduleTime(
  appointment: { endTime: Date; startTime: Date },
  input: RequestAppointmentRescheduleInput,
) {
  if (!input.date || !input.time || !input.timezone) {
    return { requestedStartTime: null, requestedEndTime: null, requestedTimezone: input.timezone ?? null };
  }
  const requestedStartTime = zonedDateTimeToUtc(input.date, input.time, input.timezone);
  const durationMinutes = input.durationMinutes ?? Math.max(1, Math.round((appointment.endTime.getTime() - appointment.startTime.getTime()) / 60_000));
  return {
    requestedStartTime,
    requestedEndTime: new Date(requestedStartTime.getTime() + durationMinutes * 60_000),
    requestedTimezone: input.timezone,
  };
}

export async function requestAppointmentReschedule(
  actor: AppointmentActor,
  appointmentId: string,
  input: RequestAppointmentRescheduleInput,
  context: Omit<AuditInput, "action">,
) {
  const existing = await loadAppointment(actor, appointmentId);
  if (TERMINAL_APPOINTMENT_STATUSES.has(existing.status)) {
    throw new AppError(422, "This appointment cannot be rescheduled in its current status.", "INVALID_APPOINTMENT_STATUS");
  }
  if (appointmentHasEnded(existing)) {
    throw new AppError(422, "Past appointments cannot be rescheduled. Please record the appointment outcome or create a new appointment.", "APPOINTMENT_CANNOT_RESCHEDULE_PAST");
  }
  if (!existing.conversationId || !existing.leadId) {
    throw new AppError(422, "A reschedule request requires a linked conversation and lead.", "APPOINTMENT_RESCHEDULE_REQUEST_CONTEXT_REQUIRED");
  }
  const requested = requestedRescheduleTime(existing, input);
  let notifications: Array<{ id: string; recipientMembershipId: string; recipientUserId: string; type: BusinessNotificationType; priority: BusinessNotificationPriority; status: BusinessNotificationStatus; title: string; message: string; createdAt: Date }> = [];
  const result = await prisma.$transaction(async (tx) => {
    const pending = await tx.appointmentRescheduleRequest.findFirst({
      where: {
        businessId: actor.businessId,
        appointmentId,
        status: AppointmentRescheduleRequestStatus.PENDING,
      },
      select: { id: true },
    });
    if (pending) {
      throw new AppError(409, "This appointment already has a pending reschedule request.", "APPOINTMENT_RESCHEDULE_REQUEST_ALREADY_PENDING", {
        rescheduleRequestId: pending.id,
      });
    }
    const request = await tx.appointmentRescheduleRequest.create({
      data: {
        businessId: actor.businessId,
        appointmentId,
        conversationId: existing.conversationId,
        leadId: existing.leadId,
        requestedBy: input.requestedBy ?? AppointmentRescheduleRequestedBy.CUSTOMER,
        requestedStartTime: requested.requestedStartTime,
        requestedEndTime: requested.requestedEndTime,
        requestedTimezone: requested.requestedTimezone,
        requestedDateText: input.requestedDateText?.trim() || null,
        reason: input.reason?.trim() || null,
        previousAppointmentStatus: existing.status,
      },
    });
    const appointment = await updateAppointmentIfUnchanged(tx, actor, existing, {
      status: AppointmentStatus.RESCHEDULE_REQUESTED,
      updatedById: actor.userId,
    });
    await logAppointmentActivity(tx, actor, appointmentId, AppointmentActivityType.APPOINTMENT_RESCHEDULE_REQUESTED, "Customer requested to reschedule appointment.", {
      rescheduleRequestId: request.id,
      requestedBy: request.requestedBy,
      requestedStartTime: request.requestedStartTime,
      requestedEndTime: request.requestedEndTime,
      requestedDateText: request.requestedDateText,
      previousStatus: existing.status,
      newStatus: appointment.status,
    });
    await logLeadAppointmentActivity(tx, actor, appointment.leadId, LeadActivityAction.APPOINTMENT_UPDATED, {
      appointmentId,
      conversationId: appointment.conversationId,
      rescheduleRequestId: request.id,
      action: "APPOINTMENT_RESCHEDULE_REQUESTED",
    });
    await createSystemMessage({
      businessId: actor.businessId,
      leadId: appointment.leadId!,
      conversationId: appointment.conversationId!,
      content: "Customer requested to reschedule this appointment.",
      metadata: json({
        appointmentId,
        rescheduleRequestId: request.id,
        type: "APPOINTMENT_RESCHEDULE_REQUESTED",
        requestedStartTime: request.requestedStartTime,
        requestedDateText: request.requestedDateText,
      }),
    }, tx);
    notifications = await createRescheduleRequestNotifications(tx, actor, appointment, request);
    return { appointment, request };
  }, TRANSACTION_OPTIONS);

  const acknowledgement = await sendAppointmentRescheduleRequestAcknowledgementMessage(actor, result.appointment, result.request, context).catch((error: unknown) =>
    auditService.log({
      ...context,
      action: AuditAction.APPOINTMENT_CUSTOMER_RESCHEDULE_MESSAGE_FAILED,
      businessId: actor.businessId,
      userId: actor.userId,
      actorMembershipId: actor.membershipId,
      metadata: json({
        source: "APPOINTMENT_LIFECYCLE_NOTIFICATION",
        eventType: "APPOINTMENT_RESCHEDULE_REQUEST_ACKNOWLEDGED",
        appointmentId: result.appointment.id,
        rescheduleRequestId: result.request.id,
        conversationId: result.appointment.conversationId,
        leadId: result.appointment.leadId,
        failureReason: appointmentMessageProviderError(error),
      }),
    }).then(() => null));

  if (acknowledgement?.id) {
    await prisma.appointmentRescheduleRequest.update({
      where: { id: result.request.id },
      data: {
        customerAcknowledgementSentAt: new Date(),
        customerAcknowledgementMessageId: acknowledgement.id,
      },
    });
  }

  await Promise.all([
    audit(actor, AuditAction.APPOINTMENT_RESCHEDULE_REQUESTED_BY_CUSTOMER, appointmentId, context, {
      rescheduleRequestId: result.request.id,
      requestedStartTime: result.request.requestedStartTime,
      requestedDateText: result.request.requestedDateText,
      previousStatus: existing.status,
      newStatus: result.appointment.status,
    }),
    ...(acknowledgement?.id ? [
      audit(actor, AuditAction.APPOINTMENT_RESCHEDULE_REQUEST_ACKNOWLEDGED, appointmentId, context, {
        rescheduleRequestId: result.request.id,
        messageId: acknowledgement.id,
      }),
    ] : []),
    publishAndInvalidate(actor, "business.appointment.reschedule_requested", result.appointment),
  ]);
  await publishNotificationEvents(actor, result.appointment, notifications);
  return { appointment: withAvailableActions(result.appointment), rescheduleRequest: result.request };
}

export async function approveAppointmentRescheduleRequest(
  actor: AppointmentActor,
  appointmentId: string,
  requestId: string,
  input: ApproveAppointmentRescheduleRequestInput,
  context: Omit<AuditInput, "action">,
) {
  requireManager(actor);
  const request = await prisma.appointmentRescheduleRequest.findFirst({
    where: { id: requestId, appointmentId, businessId: actor.businessId },
    include: { appointment: { include: appointmentInclude } },
  });
  if (!request) throw new AppError(404, "Appointment reschedule request not found.", "APPOINTMENT_RESCHEDULE_REQUEST_NOT_FOUND");
  if (request.status !== AppointmentRescheduleRequestStatus.PENDING) {
    throw new AppError(409, "This reschedule request has already been handled.", "APPOINTMENT_RESCHEDULE_REQUEST_ALREADY_HANDLED");
  }
  const timezone = input.timezone ?? request.requestedTimezone ?? request.appointment.timezone;
  const date = input.date ?? (request.requestedStartTime ? dateInTimezone(request.requestedStartTime, timezone) : null);
  const time = input.time ?? (request.requestedStartTime ? timeInTimezone(request.requestedStartTime, timezone) : null);
  if (!date || !time) {
    throw new AppError(422, "Approve requires a concrete date and time.", "APPOINTMENT_RESCHEDULE_APPROVAL_TIME_REQUIRED");
  }
  const updated = await rescheduleAppointmentFromValidatedInput(actor, appointmentId, {
    date,
    time,
    timezone,
    durationMinutes: input.durationMinutes,
    reason: input.reason ?? request.reason ?? "Customer reschedule request approved.",
    notifyCustomer: false,
  }, context);
  const handled = await prisma.appointmentRescheduleRequest.update({
    where: { id: request.id },
    data: {
      status: AppointmentRescheduleRequestStatus.APPROVED,
      approvedByMembershipId: actor.membershipId,
      approvedAt: new Date(),
    },
  });
  await Promise.all([
    prisma.appointmentActivity.create({
      data: {
        businessId: actor.businessId,
        appointmentId,
        actorUserId: actor.userId,
        actorMembershipId: actor.membershipId,
        type: AppointmentActivityType.APPOINTMENT_RESCHEDULE_REQUEST_APPROVED,
        message: "Appointment reschedule request approved.",
        metadata: json({ rescheduleRequestId: request.id, approvedByMembershipId: actor.membershipId }),
      },
    }),
    audit(actor, AuditAction.APPOINTMENT_RESCHEDULE_APPROVED_BY_TEAM, appointmentId, context, {
      rescheduleRequestId: request.id,
      approvedByMembershipId: actor.membershipId,
      requestedStartTime: request.requestedStartTime,
      newStartTime: date,
      newTime: time,
    }),
    publishAndInvalidate(actor, "business.appointment.reschedule_approved", updated),
  ]);
  return { appointment: updated, rescheduleRequest: handled };
}

export async function declineAppointmentRescheduleRequest(
  actor: AppointmentActor,
  appointmentId: string,
  requestId: string,
  input: DeclineAppointmentRescheduleRequestInput,
  context: Omit<AuditInput, "action">,
) {
  requireManager(actor);
  const request = await prisma.appointmentRescheduleRequest.findFirst({
    where: { id: requestId, appointmentId, businessId: actor.businessId },
    include: { appointment: { include: appointmentInclude } },
  });
  if (!request) throw new AppError(404, "Appointment reschedule request not found.", "APPOINTMENT_RESCHEDULE_REQUEST_NOT_FOUND");
  if (request.status !== AppointmentRescheduleRequestStatus.PENDING) {
    throw new AppError(409, "This reschedule request has already been handled.", "APPOINTMENT_RESCHEDULE_REQUEST_ALREADY_HANDLED");
  }
  const restoredStatus = request.previousAppointmentStatus ?? AppointmentStatus.CONFIRMED;
  const result = await prisma.$transaction(async (tx) => {
    const updatedRequest = await tx.appointmentRescheduleRequest.update({
      where: { id: request.id },
      data: {
        status: AppointmentRescheduleRequestStatus.DECLINED,
        declinedByMembershipId: actor.membershipId,
        declinedAt: new Date(),
        declineReason: input.reason?.trim() || null,
        alternativeTimes: input.alternativeTimes ?? [],
      },
    });
    const appointment = await updateAppointmentIfUnchanged(tx, actor, request.appointment, {
      status: restoredStatus,
      updatedById: actor.userId,
    });
    await logAppointmentActivity(tx, actor, appointmentId, AppointmentActivityType.APPOINTMENT_RESCHEDULE_REQUEST_DECLINED, "Appointment reschedule request declined.", {
      rescheduleRequestId: request.id,
      declinedByMembershipId: actor.membershipId,
      declineReason: updatedRequest.declineReason,
      alternativeTimes: updatedRequest.alternativeTimes,
      previousStatus: request.appointment.status,
      restoredStatus,
    });
    await createSystemMessage({
      businessId: actor.businessId,
      leadId: appointment.leadId!,
      conversationId: appointment.conversationId!,
      content: "Appointment reschedule request declined.",
      metadata: json({
        appointmentId,
        rescheduleRequestId: request.id,
        type: "APPOINTMENT_RESCHEDULE_REQUEST_DECLINED",
      }),
    }, tx);
    return { appointment, request: updatedRequest };
  }, TRANSACTION_OPTIONS);

  const declineMessage = await sendAppointmentRescheduleRequestDeclinedCustomerMessage(actor, result.appointment, result.request, context).catch((error: unknown) =>
    auditService.log({
      ...context,
      action: AuditAction.APPOINTMENT_CUSTOMER_RESCHEDULE_MESSAGE_FAILED,
      businessId: actor.businessId,
      userId: actor.userId,
      actorMembershipId: actor.membershipId,
      metadata: json({
        source: "APPOINTMENT_LIFECYCLE_NOTIFICATION",
        eventType: "APPOINTMENT_RESCHEDULE_REQUEST_DECLINED",
        appointmentId,
        rescheduleRequestId: request.id,
        conversationId: result.appointment.conversationId,
        leadId: result.appointment.leadId,
        failureReason: appointmentMessageProviderError(error),
      }),
    }).then(() => null));

  if (declineMessage?.id) {
    await prisma.appointmentRescheduleRequest.update({
      where: { id: request.id },
      data: {
        customerDeclinedMessageSentAt: new Date(),
        customerDeclinedMessageId: declineMessage.id,
      },
    });
  }

  await Promise.all([
    audit(actor, AuditAction.APPOINTMENT_RESCHEDULE_DECLINED_BY_TEAM, appointmentId, context, {
      rescheduleRequestId: request.id,
      declinedByMembershipId: actor.membershipId,
      reasonProvided: Boolean(input.reason?.trim()),
      alternativeTimesCount: input.alternativeTimes?.length ?? 0,
    }),
    ...(declineMessage?.id ? [
      audit(actor, AuditAction.APPOINTMENT_CUSTOMER_RESCHEDULE_MESSAGE_SENT, appointmentId, context, {
        rescheduleRequestId: request.id,
        messageId: declineMessage.id,
      }),
    ] : []),
    publishAndInvalidate(actor, "business.appointment.reschedule_declined", result.appointment),
  ]);
  return { appointment: withAvailableActions(result.appointment), rescheduleRequest: result.request };
}

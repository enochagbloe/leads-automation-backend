import { AppointmentActivityType, AppointmentStatus, AuditAction, LeadActivityAction } from "@prisma/client";
import { AppError } from "../../utils/errors";
import { AppointmentActor } from "./appointment.types";
import { prisma } from "../../config/prisma";
import { dateInTimezone, timeInTimezone } from "./appointment-date-time.utils";
import { checkSlot, lockAppointmentAvailabilityScope } from "./appointment-availability.service";
import { appointmentMessage, audit, json, loadAppointment, logAppointmentActivity, logLeadAppointmentActivity, publishAndInvalidate, updateAppointmentIfUnchanged } from "./appointment-record.service";
import { appointmentMessageProviderError, canSendAutomaticCustomerAppointmentMessage, sendAiAppointmentConfirmedCustomerMessage } from "./appointment-customer-notification.service";
import { isManager, requireReason } from "./appointment-access.service";
import { AuditInput, auditService } from "../audit.service";
import { followUpService } from "../follow-up.service";
import { createSystemMessage } from "../message.service";
import { CONFIRMABLE_APPOINTMENT_STATUSES, TRANSACTION_OPTIONS } from "./appointment.constants";
import { requireManager } from "./appointment-access.service";
import { assertAppointmentEndedForOutcome, withAvailableActions } from "./appointment-status.service";
export async function confirm(actor: AppointmentActor, appointmentId: string, note: string | null | undefined, context: Omit<AuditInput, "action">) {
    requireManager(actor);
    const existing = await loadAppointment(actor, appointmentId);
    if (!CONFIRMABLE_APPOINTMENT_STATUSES.has(existing.status)) {
      throw new AppError(422, "This appointment cannot be confirmed.", "APPOINTMENT_CANNOT_CONFIRM");
    }
    const updated = await prisma.$transaction(async (tx) => {
      const localDate = dateInTimezone(existing.startTime, existing.timezone);
      const localTime = timeInTimezone(existing.startTime, existing.timezone);
      const durationMinutes = Math.max(1, Math.round((existing.endTime.getTime() - existing.startTime.getTime()) / 60_000));
      await lockAppointmentAvailabilityScope(tx, {
        businessId: actor.businessId,
        assignedStaffId: existing.assignedStaffId,
        date: localDate,
      });
      const availability = await checkSlot({
        businessId: actor.businessId,
        serviceId: existing.serviceId ?? undefined,
        date: localDate,
        time: localTime,
        timezone: existing.timezone,
        assignedStaffId: existing.assignedStaffId,
        durationMinutes: existing.service?.durationMinutes ?? durationMinutes,
        excludeAppointmentId: appointmentId,
      }, tx);
      if (!availability.available) {
        throw new AppError(
          422,
          availability.message ?? "Appointment slot is unavailable.",
          availability.reason ?? "APPOINTMENT_SLOT_UNAVAILABLE",
          { availability },
        );
      }
      const record = await updateAppointmentIfUnchanged(tx, actor, existing, {
          status: AppointmentStatus.CONFIRMED,
          confirmedAt: new Date(),
          confirmedById: actor.userId,
          humanConfirmationRequired: false,
          humanConfirmationReason: null,
          updatedById: actor.userId,
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
    if (
      canSendAutomaticCustomerAppointmentMessage(existing)
      && existing.status !== AppointmentStatus.CONFIRMED
      && updated.status === AppointmentStatus.CONFIRMED
    ) {
      await sendAiAppointmentConfirmedCustomerMessage(actor, updated, context).catch((error: unknown) =>
        auditService.log({
          ...context,
          action: AuditAction.WHATSAPP_MESSAGE_SEND_FAILED,
          businessId: actor.businessId,
          userId: actor.userId,
          actorMembershipId: actor.membershipId,
          metadata: json({
            source: "APPOINTMENT_LIFECYCLE_NOTIFICATION",
            eventType: "APPOINTMENT_CONFIRMED",
            appointmentId: updated.id,
            conversationId: updated.conversationId,
            leadId: updated.leadId,
            failureReason: appointmentMessageProviderError(error),
          }),
        }));
    }
    await followUpService.scheduleContactEmailRequestForAppointment(updated);
    await followUpService.scheduleAppointmentReminder(updated);
    return withAvailableActions(updated);
  }

export async function cancel(actor: AppointmentActor, appointmentId: string, reason: string | null | undefined, context: Omit<AuditInput, "action">) {
    requireManager(actor);
    const cancellationReason = requireReason(reason, "cancelling");
    const existing = await loadAppointment(actor, appointmentId);
    if (existing.status === AppointmentStatus.CANCELLED) throw new AppError(422, "Appointment is already cancelled.", "APPOINTMENT_ALREADY_CANCELLED");
    if (existing.status === AppointmentStatus.COMPLETED || existing.status === AppointmentStatus.NO_SHOW || existing.status === AppointmentStatus.MISSED) {
      throw new AppError(422, "Appointments with a recorded outcome cannot be cancelled.", "APPOINTMENT_OUTCOME_ALREADY_RECORDED");
    }
    const updated = await prisma.$transaction(async (tx) => {
      const record = await updateAppointmentIfUnchanged(tx, actor, existing, {
        status: AppointmentStatus.CANCELLED,
        cancellationReason,
        cancelledAt: new Date(),
        cancelledById: actor.userId,
        updatedById: actor.userId,
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
    await followUpService.cancelAppointmentReminderJobs({ businessId: actor.businessId, appointmentId, reason: "APPOINTMENT_CANCELLED" });
    return withAvailableActions(updated);
  }

export async function complete(actor: AppointmentActor, appointmentId: string, completedNote: string | null | undefined, context: Omit<AuditInput, "action">) {
    const existing = await loadAppointment(actor, appointmentId);
    if (!isManager(actor) && existing.assignedStaffId !== actor.membershipId) throw new AppError(403, "You do not have permission to manage this appointment.", "FORBIDDEN");
    if (existing.status === AppointmentStatus.COMPLETED || existing.status === AppointmentStatus.NO_SHOW || existing.status === AppointmentStatus.MISSED) {
      throw new AppError(422, "This appointment already has an outcome recorded.", "APPOINTMENT_OUTCOME_ALREADY_RECORDED");
    }
    if (existing.status === AppointmentStatus.CANCELLED) {
      throw new AppError(422, "This appointment cannot be completed in its current status.", "APPOINTMENT_CANNOT_COMPLETE");
    }
    assertAppointmentEndedForOutcome(existing, "complete");
    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const record = await updateAppointmentIfUnchanged(tx, actor, existing, {
          status: AppointmentStatus.COMPLETED,
          completedAt: now,
          completedById: actor.userId,
          outcomeConfirmedAt: now,
          outcomeConfirmedById: actor.membershipId,
          outcomeNote: completedNote?.trim() || null,
          completedNote: completedNote?.trim() || null,
          updatedById: actor.userId,
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
      followUpService.schedulePostAppointmentFollowUp(updated),
    ]);
    return withAvailableActions(updated);
  }

export async function noShow(actor: AppointmentActor, appointmentId: string, noShowReason: string | null | undefined, context: Omit<AuditInput, "action">) {
    const existing = await loadAppointment(actor, appointmentId);
    if (!isManager(actor) && existing.assignedStaffId !== actor.membershipId) throw new AppError(403, "You do not have permission to manage this appointment.", "FORBIDDEN");
    if (existing.status === AppointmentStatus.COMPLETED || existing.status === AppointmentStatus.MISSED || existing.status === AppointmentStatus.NO_SHOW) {
      throw new AppError(422, "This appointment already has an outcome recorded.", "APPOINTMENT_OUTCOME_ALREADY_RECORDED");
    }
    if (existing.status === AppointmentStatus.CANCELLED) {
      throw new AppError(422, "This appointment cannot be marked no-show in its current status.", "APPOINTMENT_CANNOT_NO_SHOW");
    }
    assertAppointmentEndedForOutcome(existing, "no-show");
    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const record = await updateAppointmentIfUnchanged(tx, actor, existing, {
          status: AppointmentStatus.NO_SHOW,
          outcomeConfirmedAt: now,
          outcomeConfirmedById: actor.membershipId,
          outcomeNote: noShowReason?.trim() || null,
          noShowReason: noShowReason?.trim() || null,
          updatedById: actor.userId,
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
      followUpService.cancelPostAppointmentFollowUpJobs({ businessId: actor.businessId, appointmentId, reason: "APPOINTMENT_OUTCOME_CHANGED_FROM_COMPLETED" }),
    ]);
    return withAvailableActions(updated);
  }

export async function missed(actor: AppointmentActor, appointmentId: string, missedReason: string | null | undefined, context: Omit<AuditInput, "action">) {
    const existing = await loadAppointment(actor, appointmentId);
    if (!isManager(actor) && existing.assignedStaffId !== actor.membershipId) throw new AppError(403, "You do not have permission to manage this appointment.", "FORBIDDEN");
    if (existing.status === AppointmentStatus.COMPLETED || existing.status === AppointmentStatus.NO_SHOW || existing.status === AppointmentStatus.MISSED) {
      throw new AppError(422, "This appointment already has an outcome recorded.", "APPOINTMENT_OUTCOME_ALREADY_RECORDED");
    }
    if (existing.status === AppointmentStatus.CANCELLED) {
      throw new AppError(422, "This appointment cannot be marked missed in its current status.", "APPOINTMENT_CANNOT_MARK_MISSED");
    }
    assertAppointmentEndedForOutcome(existing, "missed");
    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const record = await updateAppointmentIfUnchanged(tx, actor, existing, {
          status: AppointmentStatus.MISSED,
          outcomeConfirmedAt: now,
          outcomeConfirmedById: actor.membershipId,
          outcomeNote: missedReason?.trim() || null,
          missedReason: missedReason?.trim() || null,
          updatedById: actor.userId,
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
      followUpService.cancelPostAppointmentFollowUpJobs({ businessId: actor.businessId, appointmentId, reason: "APPOINTMENT_OUTCOME_CHANGED_FROM_COMPLETED" }),
    ]);
    return withAvailableActions(updated);
  }

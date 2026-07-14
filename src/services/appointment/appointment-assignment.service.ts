
import { 
    BusinessRole, 
    AuditAction,
    AppointmentActivityType,
    AppointmentConfirmationMode,
    AppointmentHumanConfirmationReason,
    AppointmentLocationStatus,
    AppointmentStatus,
    BusinessNotificationPriority,
    BusinessNotificationStatus,
    BusinessNotificationType,
    LeadActivityAction,
    PlanCode
} from "@prisma/client";
import { audit, loadAppointment, logAppointmentActivity, logLeadAppointmentActivity, publishAndInvalidate, publishNotificationEvents, updateAppointmentIfUnchanged } from "./appointment-record.service";
import { prisma } from "../../config/prisma";
import { AuditInput } from "../audit.service";
import { lockAppointmentAvailabilityScope } from "./appointment-availability.service";
import { dateInTimezone, timeInTimezone } from "./appointment-date-time.utils";
import { createStaffAssignmentNotifications } from "./appointment-notification.service";
import { TERMINAL_APPOINTMENT_STATUSES, TRANSACTION_OPTIONS } from "./appointment.constants";
import { AppointmentActor } from "./appointment.types";
import { appointmentHasEnded, withAvailableActions } from "./appointment-status.service";
import { AppError } from "../../utils/errors";
import { requireManager } from "./appointment-access.service";
import { validateAssignee, validateBusiness, activeSubscription } from "./appointment-validation.service";
import { appointmentInclude } from "./appointment.include";
import { checkSlot } from "./appointment-availability.service";

export async function assign(actor: AppointmentActor, appointmentId: string, assignedStaffId: string | null, context: Omit<AuditInput, "action">) {
    if (actor.role === BusinessRole.STAFF) {
      if (assignedStaffId !== actor.membershipId) {
        await audit(actor, AuditAction.WORK_ASSIGNMENT_BLOCKED, appointmentId, context, {
          recordType: "APPOINTMENT",
          recordId: appointmentId,
          reason: "staff_assignment_target_not_self",
        });
        throw new AppError(403, "You do not have permission to reassign this appointment.", "CANNOT_REASSIGN_WITHOUT_PERMISSION");
      }
      return claim(actor, appointmentId, context);
    }
    requireManager(actor);
    const existing = await loadAppointment(actor, appointmentId);
    if (TERMINAL_APPOINTMENT_STATUSES.has(existing.status)) {
      throw new AppError(422, "Appointments with a final outcome cannot be reassigned.", "APPOINTMENT_OUTCOME_ALREADY_RECORDED");
    }
    await validateAssignee(actor.businessId, assignedStaffId);
    const business = await validateBusiness(actor);
    const subscription = await activeSubscription(actor);
    const canAutoConfirmAfterAssignment = Boolean(
      assignedStaffId
      && existing.status === AppointmentStatus.PENDING_BUSINESS_CONFIRMATION
      && subscription.plan.code !== PlanCode.BASIC
      && business.appointmentConfirmationMode === AppointmentConfirmationMode.AUTO_CONFIRM_WHEN_STAFF_ASSIGNED
      && (existing.humanConfirmationReason === AppointmentHumanConfirmationReason.STAFF_REQUIRED || existing.humanConfirmationReason === null)
      && existing.locationStatus !== AppointmentLocationStatus.NEEDS_CONFIRMATION
      && !appointmentHasEnded(existing),
    );
    let shouldAutoConfirm = false;
    let assignmentNotifications: Array<{ id: string; recipientMembershipId: string; recipientUserId: string; type: BusinessNotificationType; priority: BusinessNotificationPriority; status: BusinessNotificationStatus; title: string; message: string; createdAt: Date }> = [];
    const updated = await prisma.$transaction(async (tx) => {
      if (assignedStaffId) {
        const existingDurationMinutes = Math.max(1, Math.round((existing.endTime.getTime() - existing.startTime.getTime()) / 60_000));
        const localDate = dateInTimezone(existing.startTime, existing.timezone);
        await lockAppointmentAvailabilityScope(tx, { businessId: actor.businessId, assignedStaffId, date: localDate });
        const availability = await checkSlot({
          businessId: actor.businessId,
          serviceId: existing.serviceId ?? undefined,
          date: localDate,
          time: timeInTimezone(existing.startTime, existing.timezone),
          timezone: existing.timezone,
          assignedStaffId,
          durationMinutes: existing.service?.durationMinutes ?? existingDurationMinutes,
          excludeAppointmentId: appointmentId,
        }, tx);
        if (canAutoConfirmAfterAssignment && !availability.available) {
          throw new AppError(
            422,
            availability.message ?? "Appointment slot is unavailable.",
            availability.reason ?? "APPOINTMENT_SLOT_UNAVAILABLE",
            { availability },
          );
        }
        shouldAutoConfirm = canAutoConfirmAfterAssignment && availability.available;
      }
      const record = await updateAppointmentIfUnchanged(tx, actor, existing, {
          assignedStaffId,
          ...(shouldAutoConfirm ? {
            status: AppointmentStatus.CONFIRMED,
            confirmedAt: new Date(),
            confirmedById: actor.userId,
            humanConfirmationRequired: false,
            humanConfirmationReason: null,
          } : {}),
          updatedById: actor.userId,
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
  }

export async function claim(actor: AppointmentActor, appointmentId: string, context: Omit<AuditInput, "action">) {
    const existing = await prisma.appointment.findFirst({ where: { id: appointmentId, businessId: actor.businessId }, include: appointmentInclude });
    if (!existing) throw new AppError(404, "Appointment not found.", "APPOINTMENT_NOT_FOUND");
    if (existing.assignedStaffId && existing.assignedStaffId !== actor.membershipId) {
      await audit(actor, AuditAction.WORK_ASSIGNMENT_BLOCKED, appointmentId, context, {
        recordType: "APPOINTMENT",
        recordId: appointmentId,
        previousAssignedStaffId: existing.assignedStaffId,
        attemptedAssignedStaffId: actor.membershipId,
      });
      throw new AppError(409, "This appointment is already assigned to another team member.", "WORK_ALREADY_ASSIGNED");
    }
    if (TERMINAL_APPOINTMENT_STATUSES.has(existing.status)) {
      const code = existing.status === AppointmentStatus.CANCELLED ? "CANNOT_CLAIM_CANCELLED_WORK" : "CANNOT_CLAIM_COMPLETED_WORK";
      throw new AppError(409, "This appointment can no longer be claimed.", code);
    }
    if (existing.assignedStaffId === actor.membershipId) return withAvailableActions(existing);
    await validateAssignee(actor.businessId, actor.membershipId);
    const durationMinutes = Math.max(1, Math.round((existing.endTime.getTime() - existing.startTime.getTime()) / 60_000));
    const updated = await prisma.$transaction(async (tx) => {
      const localDate = dateInTimezone(existing.startTime, existing.timezone);
      await lockAppointmentAvailabilityScope(tx, { businessId: actor.businessId, assignedStaffId: actor.membershipId, date: localDate });
      const availability = await checkSlot({
        businessId: actor.businessId,
        serviceId: existing.serviceId ?? undefined,
        date: localDate,
        time: timeInTimezone(existing.startTime, existing.timezone),
        timezone: existing.timezone,
        assignedStaffId: actor.membershipId,
        durationMinutes: existing.service?.durationMinutes ?? durationMinutes,
        excludeAppointmentId: appointmentId,
      }, tx);
      if (!availability.available && availability.reason === "APPOINTMENT_STAFF_UNAVAILABLE") {
        throw new AppError(409, "You already have another appointment at this time.", "STAFF_SCHEDULE_CONFLICT", { availability });
      }
      if (!availability.available) {
        throw new AppError(422, availability.message ?? "Appointment slot is unavailable.", availability.reason ?? "APPOINTMENT_SLOT_UNAVAILABLE", { availability });
      }
      const record = await updateAppointmentIfUnchanged(tx, actor, existing, {
        assignedStaffId: actor.membershipId,
        updatedById: actor.userId,
      });
      await logAppointmentActivity(tx, actor, appointmentId, AppointmentActivityType.APPOINTMENT_STAFF_ASSIGNED, "Appointment claimed by staff.", {
        previousAssignedStaffId: null,
        newAssignedStaffId: actor.membershipId,
        reason: "CLAIM_UNASSIGNED_WORK",
      });
      await logLeadAppointmentActivity(tx, actor, record.leadId, LeadActivityAction.APPOINTMENT_ASSIGNED, {
        appointmentId,
        previousAssignedStaffId: null,
        newAssignedStaffId: actor.membershipId,
        reason: "CLAIM_UNASSIGNED_WORK",
      });
      return record;
    }, TRANSACTION_OPTIONS);
    await Promise.all([
      audit(actor, AuditAction.APPOINTMENT_CLAIMED_BY_STAFF, updated.id, context, {
        actorUserId: actor.userId,
        actorMembershipId: actor.membershipId,
        targetMembershipId: actor.membershipId,
        recordType: "APPOINTMENT",
        recordId: appointmentId,
        previousAssignedStaffId: null,
        newAssignedStaffId: actor.membershipId,
        reason: "CLAIM_UNASSIGNED_WORK",
      }),
      publishAndInvalidate(actor, "business.appointment.claimed", updated),
      publishAndInvalidate(actor, "business.appointment.assigned", updated),
    ]);
    return withAvailableActions(updated);
  }

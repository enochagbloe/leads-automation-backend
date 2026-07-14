import { PlanCode, AppointmentConfirmationMode, AppointmentSource, BusinessNotificationType, BusinessNotificationPriority, BusinessNotificationStatus, ServiceCapacityMode, AppointmentStatus, AppointmentHumanConfirmationReason, AppointmentConfirmationSource, AppointmentActivityType, AuditAction, LeadActivityAction, LeadStatus } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError } from "../../utils/errors";
import { AuditInput } from "../audit.service";
import { followUpService } from "../follow-up.service";
import { createSystemMessage } from "../message.service";
import { evaluatePremiumAppointmentAutoConfirmation } from "../premium-appointment-auto-confirm.service";
import { checkSlot, lockAppointmentAvailabilityScope } from "./appointment-availability.service";
import { confirmationForCreation } from "./appointment-confirmation.service";
import { appointmentDateUtc } from "./appointment-date-time.utils";
import { createConfirmationNotifications, createStaffAssignmentNotifications } from "./appointment-notification.service";
import { appointmentMessage, audit, json, logAppointmentActivity, logLeadAppointmentActivity, publishAndInvalidate, publishNotificationEvents } from "./appointment-record.service";
import { TRANSACTION_OPTIONS } from "./appointment.constants";
import { AppointmentActor, InternalCreateAppointmentInput } from "./appointment.types";
import { requireManager } from "./appointment-access.service";
import { withAvailableActions } from "./appointment-status.service";
import { validateBusiness, activeSubscription, resolveLinkedRecords, validateAssignee, statusForLocation, validateService } from "./appointment-validation.service";
import { resolveAppointmentLocationType, findEligibleAvailableStaff } from "./appointment-staff.service";
import { appointmentInclude } from "./appointment.include";
import { incrementAppointmentUsage } from "./appointment-usage.service";

export async function createAppointmentFromValidatedInput(actor: AppointmentActor, input: InternalCreateAppointmentInput, context: Omit<AuditInput, "action">) {
  requireManager(actor);
  const business = await validateBusiness(actor);
  const subscription = await activeSubscription(actor);
  const linked = await resolveLinkedRecords(actor, input);
  const initialAssignedStaffId = input.assignedStaffId ?? linked.lead?.assignedStaffId ?? null;
  await validateAssignee(actor.businessId, initialAssignedStaffId);
  const serviceValidation = await validateService(actor.businessId, input.serviceId ?? null, input.durationMinutes);
  const effectiveLocationType = resolveAppointmentLocationType(input, serviceValidation.service);
  const availability = await checkSlot({
    businessId: actor.businessId,
    serviceId: input.serviceId ?? undefined,
    date: input.date,
    time: input.time,
    timezone: input.timezone,
    assignedStaffId: initialAssignedStaffId,
    durationMinutes: input.durationMinutes,
  });
  const canDeferStaffConflict = (
    (
      (subscription.plan.code !== PlanCode.BASIC && business.appointmentConfirmationMode === AppointmentConfirmationMode.AUTO_CONFIRM_WHEN_STAFF_ASSIGNED)
      || (subscription.plan.code === PlanCode.PREMIUM && business.appointmentConfirmationMode === AppointmentConfirmationMode.AUTO_CONFIRM_SAFE_BOOKINGS)
    )
    && input.source !== AppointmentSource.MANUAL
    && availability.reason === "APPOINTMENT_STAFF_UNAVAILABLE"
    && Boolean(initialAssignedStaffId)
  );
  if (!availability.available && !canDeferStaffConflict) {
    throw new AppError(422, availability.message ?? "Appointment slot is unavailable.", availability.reason ?? "APPOINTMENT_SLOT_UNAVAILABLE", { availability });
  }
  const location = statusForLocation(effectiveLocationType, input.location ?? null);
  const customerName = input.customerName ?? linked.lead?.fullName ?? null;
  const customerPhone = input.customerPhone ?? linked.lead?.phone ?? null;
  const customerEmail = input.customerEmail ?? linked.lead?.email ?? null;

  let confirmationNotifications: Array<{ id: string; recipientMembershipId: string; recipientUserId: string; type: BusinessNotificationType; priority: BusinessNotificationPriority; status: BusinessNotificationStatus; title: string; message: string; createdAt: Date }> = [];
  let assignmentNotifications: Array<{ id: string; recipientMembershipId: string; recipientUserId: string; type: BusinessNotificationType; priority: BusinessNotificationPriority; status: BusinessNotificationStatus; title: string; message: string; createdAt: Date }> = [];
  const appointment = await prisma.$transaction(async (tx) => {
    await validateBusiness(actor, tx);
    let transactionAssignedStaffId = initialAssignedStaffId;
    if (transactionAssignedStaffId) {
      await lockAppointmentAvailabilityScope(tx, { businessId: actor.businessId, assignedStaffId: transactionAssignedStaffId, date: input.date });
    }
    let transactionAvailability = await checkSlot({
      businessId: actor.businessId,
      serviceId: input.serviceId ?? undefined,
      date: input.date,
      time: input.time,
      timezone: input.timezone,
      assignedStaffId: transactionAssignedStaffId,
      durationMinutes: input.durationMinutes,
    }, tx);
    if (
      input.source === AppointmentSource.AI_CONVERSATION
      && !transactionAssignedStaffId
      && transactionAvailability.available
      && serviceValidation.service?.capacityMode === ServiceCapacityMode.STAFF_BASED
      && serviceValidation.service.autoConfirmEligible
    ) {
      const eligibleStaff = await findEligibleAvailableStaff(tx, {
        businessId: actor.businessId,
        service: serviceValidation.service,
        serviceId: input.serviceId ?? undefined,
        date: input.date,
        time: input.time,
        timezone: input.timezone,
        durationMinutes: input.durationMinutes,
      });
      if (eligibleStaff) {
        transactionAssignedStaffId = eligibleStaff.memberId;
        transactionAvailability = eligibleStaff.availability;
      }
    }
    const canDeferTransactionStaffConflict = (
      (
        (subscription.plan.code !== PlanCode.BASIC && business.appointmentConfirmationMode === AppointmentConfirmationMode.AUTO_CONFIRM_WHEN_STAFF_ASSIGNED)
        || (subscription.plan.code === PlanCode.PREMIUM && business.appointmentConfirmationMode === AppointmentConfirmationMode.AUTO_CONFIRM_SAFE_BOOKINGS)
      )
      && input.source !== AppointmentSource.MANUAL
      && transactionAvailability.reason === "APPOINTMENT_STAFF_UNAVAILABLE"
      && Boolean(transactionAssignedStaffId)
    );
    if (!transactionAvailability.available && !canDeferTransactionStaffConflict) {
      throw new AppError(
        422,
        transactionAvailability.message ?? "Appointment slot is unavailable.",
        transactionAvailability.reason ?? "APPOINTMENT_SLOT_UNAVAILABLE",
        { availability: transactionAvailability },
      );
    }
    await incrementAppointmentUsage(tx, actor);
    const autoConfirmDecision = evaluatePremiumAppointmentAutoConfirmation({
      planCode: subscription.plan.code,
      appointmentConfirmationMode: business.appointmentConfirmationMode,
      aiAutoConfirmAppointmentsEnabled: business.aiAutoConfirmAppointmentsEnabled,
      source: input.source,
      service: serviceValidation.service,
      customerName,
      customerPhone,
      assignedStaffId: transactionAssignedStaffId,
      locationType: effectiveLocationType,
      locationStatus: location.locationStatus,
      availability: transactionAvailability,
      aiDecision: input.aiDecision,
    });
    let confirmation = confirmationForCreation(
      subscription.plan.code,
      business.appointmentConfirmationMode,
      input.source,
      location,
      transactionAssignedStaffId,
      transactionAvailability,
      serviceValidation.service,
    );
    if (input.source === AppointmentSource.AI_CONVERSATION) {
      confirmation = autoConfirmDecision.shouldAutoConfirm
        ? {
          status: AppointmentStatus.CONFIRMED,
          locationStatus: location.locationStatus,
          humanConfirmationRequired: false,
          humanConfirmationReason: null,
        }
        : {
          status: transactionAvailability.available ? AppointmentStatus.PENDING_BUSINESS_CONFIRMATION : AppointmentStatus.NEEDS_HUMAN_CONFIRMATION,
          locationStatus: location.locationStatus,
          humanConfirmationRequired: true,
          humanConfirmationReason: transactionAvailability.available
            ? location.humanConfirmationReason ?? AppointmentHumanConfirmationReason.BUSINESS_CONFIRMATION_REQUIRED
            : AppointmentHumanConfirmationReason.AVAILABILITY_CONFLICT,
        };
    }
    const created = await tx.appointment.create({
      data: {
        businessId: actor.businessId,
        businessAccountId: actor.businessAccountId,
        leadId: linked.leadId,
        conversationId: linked.conversation?.id ?? null,
        serviceId: input.serviceId ?? null,
        assignedStaffId: transactionAssignedStaffId,
        customerName,
        customerPhone,
        customerEmail,
        title: input.title,
        description: input.description,
        notes: input.notes,
        appointmentDate: appointmentDateUtc(input.date),
        startTime: transactionAvailability.startTime,
        endTime: transactionAvailability.endTime,
        timezone: input.timezone,
        status: confirmation.status,
        source: input.source,
        locationType: effectiveLocationType,
        location: input.location,
        locationStatus: confirmation.locationStatus,
        confirmationSource: input.source === AppointmentSource.AI_CONVERSATION
          ? autoConfirmDecision.shouldAutoConfirm ? AppointmentConfirmationSource.AI_PREMIUM_AUTO_CONFIRM : AppointmentConfirmationSource.AI_REQUEST
          : AppointmentConfirmationSource.MANUAL,
        autoConfirmedAt: autoConfirmDecision.shouldAutoConfirm ? new Date() : null,
        autoConfirmDecisionReason: autoConfirmDecision.evaluated ? autoConfirmDecision.decisionReason : null,
        autoConfirmFailedReason: autoConfirmDecision.failedReason,
        autoConfirmConfidence: autoConfirmDecision.confidence,
        humanConfirmationRequired: confirmation.humanConfirmationRequired,
        humanConfirmationReason: confirmation.humanConfirmationReason,
        createdById: actor.userId,
        confirmedAt: autoConfirmDecision.shouldAutoConfirm ? new Date() : null,
      },
      include: appointmentInclude,
    });
    await logAppointmentActivity(tx, actor, created.id, AppointmentActivityType.APPOINTMENT_CREATED, appointmentMessage(AppointmentActivityType.APPOINTMENT_CREATED, created), {
      source: created.source,
      leadId: created.leadId,
      conversationId: created.conversationId,
      assignedStaffId: created.assignedStaffId,
    });
    if (autoConfirmDecision.evaluated) {
      await tx.auditLog.create({
        data: {
          action: AuditAction.AI_APPOINTMENT_AUTO_CONFIRM_EVALUATED,
          businessId: actor.businessId,
          userId: actor.userId,
          actorMembershipId: actor.membershipId,
          metadata: json({
            appointmentId: created.id,
            confirmationSource: created.confirmationSource,
            confidence: autoConfirmDecision.confidence,
            shouldAutoConfirm: autoConfirmDecision.shouldAutoConfirm,
            failedReasons: autoConfirmDecision.failedReasons,
          }),
        },
      });
      if (autoConfirmDecision.shouldAutoConfirm) {
        await logAppointmentActivity(tx, actor, created.id, AppointmentActivityType.APPOINTMENT_AUTO_CONFIRMED_BY_AI, "Premium AI auto-confirmed this safe appointment booking.", {
          confirmationSource: created.confirmationSource,
          confidence: autoConfirmDecision.confidence,
          reason: autoConfirmDecision.decisionReason,
        });
        await tx.auditLog.create({
          data: {
            action: AuditAction.AI_APPOINTMENT_AUTO_CONFIRMED,
            businessId: actor.businessId,
            userId: actor.userId,
            actorMembershipId: actor.membershipId,
            metadata: json({
              appointmentId: created.id,
              oldStatus: null,
              newStatus: created.status,
              confirmationSource: created.confirmationSource,
              confidence: autoConfirmDecision.confidence,
            }),
          },
        });
      } else {
        await logAppointmentActivity(tx, actor, created.id, AppointmentActivityType.APPOINTMENT_AUTO_CONFIRM_SKIPPED, "AI auto-confirmation was skipped; business confirmation is required.", {
          confirmationSource: created.confirmationSource,
          confidence: autoConfirmDecision.confidence,
          failedReasons: autoConfirmDecision.failedReasons,
        });
        await logAppointmentActivity(tx, actor, created.id, AppointmentActivityType.APPOINTMENT_PENDING_CONFIRMATION_CREATED_BY_AI, "AI created a pending appointment request for business confirmation.", {
          confirmationSource: created.confirmationSource,
          failedReason: autoConfirmDecision.failedReason,
        });
        await tx.auditLog.create({
          data: {
            action: AuditAction.AI_APPOINTMENT_AUTO_CONFIRM_BLOCKED,
            businessId: actor.businessId,
            userId: actor.userId,
            actorMembershipId: actor.membershipId,
            metadata: json({
              appointmentId: created.id,
              oldStatus: null,
              newStatus: created.status,
              confirmationSource: created.confirmationSource,
              confidence: autoConfirmDecision.confidence,
              failedReasons: autoConfirmDecision.failedReasons,
            }),
          },
        });
        await tx.auditLog.create({
          data: {
            action: AuditAction.AI_APPOINTMENT_AUTO_CONFIRM_FALLBACK_PENDING,
            businessId: actor.businessId,
            userId: actor.userId,
            actorMembershipId: actor.membershipId,
            metadata: json({
              appointmentId: created.id,
              oldStatus: null,
              newStatus: created.status,
              confirmationSource: created.confirmationSource,
              failedReason: autoConfirmDecision.failedReason,
            }),
          },
        });
      }
    }
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
            actorMembershipId: actor.membershipId,
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
          actorMembershipId: actor.membershipId,
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
          actorMembershipId: actor.membershipId,
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
    ...(appointment.confirmationSource === AppointmentConfirmationSource.AI_PREMIUM_AUTO_CONFIRM ? [
      publishAndInvalidate(actor, "business.appointment.auto_confirmed", appointment),
    ] : []),
  ]);
  await publishNotificationEvents(actor, appointment, confirmationNotifications);
  await publishNotificationEvents(actor, appointment, assignmentNotifications);
  await followUpService.scheduleContactEmailRequestForAppointment(appointment);
  if (appointment.status === AppointmentStatus.CONFIRMED || appointment.status === AppointmentStatus.RESCHEDULED) {
    await followUpService.scheduleAppointmentReminder(appointment);
  }
  return withAvailableActions(appointment);
}

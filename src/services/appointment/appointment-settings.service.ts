import { AuditAction, PlanCode } from "@prisma/client";
import { AppointmentActor } from "./appointment.types";
import { AppointmentAutoConfirmSettingsInput, AppointmentSettingsInput } from "../../validation/appointment.schemas";
import { AuditInput, auditService } from "../audit.service";
import { AppError } from "../../utils/errors";
import { env } from "../../config/env";
import { prisma } from "../../config/prisma";
import { realtimeService } from "../realtime.service";
import { invalidateAppointmentCaches } from "./appointment-cache.service";
import { requireManager } from "./appointment-access.service";
import { activeSubscription, assertAppointmentConfirmationModeAllowed, validateBusiness } from "./appointment-validation.service";
import { json } from "./appointment-record.service";

export async function getAutoConfirmSettings(actor: AppointmentActor) {
    const [business, subscription] = await Promise.all([
      validateBusiness(actor),
      activeSubscription(actor),
    ]);
    return {
      settings: {
        aiAutoConfirmAppointmentsEnabled: business.aiAutoConfirmAppointmentsEnabled,
        appointmentConfirmationMode: business.appointmentConfirmationMode,
        minConfidence: env.AI_AUTO_CONFIRM_MIN_CONFIDENCE,
        currentPlan: subscription.plan.code,
        canEnable: subscription.plan.code === PlanCode.PREMIUM,
      },
    };
}

export async function updateAutoConfirmSettings(actor: AppointmentActor, input: AppointmentAutoConfirmSettingsInput, context: Omit<AuditInput, "action">) {
    requireManager(actor);
    const [business, subscription] = await Promise.all([
      validateBusiness(actor),
      activeSubscription(actor),
    ]);
    if (input.aiAutoConfirmAppointmentsEnabled && subscription.plan.code !== PlanCode.PREMIUM) {
      throw new AppError(403, "Upgrade to Premium to enable AI appointment auto-confirmation.", "PLAN_UPGRADE_REQUIRED", {
        currentPlan: subscription.plan.code,
        recommendedPlan: PlanCode.PREMIUM,
        featureKey: "aiAutoConfirmAppointmentsEnabled",
      });
    }
    const updated = await prisma.business.update({
      where: { id: actor.businessId },
      data: { aiAutoConfirmAppointmentsEnabled: input.aiAutoConfirmAppointmentsEnabled },
      select: {
        id: true,
        appointmentConfirmationMode: true,
        aiAutoConfirmAppointmentsEnabled: true,
        updatedAt: true,
      },
    });
    await Promise.all([
      invalidateAppointmentCaches(actor.businessId),
      auditService.log({
        ...context,
        action: AuditAction.APPOINTMENT_CONFIRMATION_MODE_UPDATED,
        businessId: actor.businessId,
        userId: actor.userId,
        actorMembershipId: actor.membershipId,
        metadata: json({
          businessId: actor.businessId,
          field: "aiAutoConfirmAppointmentsEnabled",
          oldValue: business.aiAutoConfirmAppointmentsEnabled,
          newValue: updated.aiAutoConfirmAppointmentsEnabled,
          currentPlan: subscription.plan.code,
        }),
      }),
    ]);
    realtimeService.publish({
      type: "business.appointment.updated",
      businessId: actor.businessId,
      payload: {
        businessId: actor.businessId,
        aiAutoConfirmAppointmentsEnabled: updated.aiAutoConfirmAppointmentsEnabled,
        appointmentConfirmationMode: updated.appointmentConfirmationMode,
        updatedAt: updated.updatedAt.toISOString(),
      },
    });
    return {
      settings: {
        aiAutoConfirmAppointmentsEnabled: updated.aiAutoConfirmAppointmentsEnabled,
        appointmentConfirmationMode: updated.appointmentConfirmationMode,
        minConfidence: env.AI_AUTO_CONFIRM_MIN_CONFIDENCE,
        currentPlan: subscription.plan.code,
        canEnable: subscription.plan.code === PlanCode.PREMIUM,
      },
    };
}

export async function updateSettings(actor: AppointmentActor, input: AppointmentSettingsInput, context: Omit<AuditInput, "action">) {
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
}

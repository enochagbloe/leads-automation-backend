import { AuditAction, PlanCode, Prisma } from "@prisma/client";
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
import { publishKnowledgeSettingsReconciliation, reconcileKnowledgeAfterSettingsMutation } from "../knowledge-document/knowledge-settings-reconciliation.service";

export type AppointmentSettingsMutationGuard = {
  assertCurrent(current: Readonly<{ appointmentConfirmationMode: string }>): void;
  skipKnowledgeReconciliation?: boolean;
};

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

export async function updateSettings(
  actor: AppointmentActor,
  input: AppointmentSettingsInput,
  context: Omit<AuditInput, "action">,
  guard?: AppointmentSettingsMutationGuard,
) {
    requireManager(actor);
    const subscription = await activeSubscription(actor);
    assertAppointmentConfirmationModeAllowed(subscription.plan.code, input.appointmentConfirmationMode);
    const updated = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "Business"
        WHERE "id" = ${actor.businessId}
          AND "businessAccountId" = ${actor.businessAccountId}
          AND "deletedAt" IS NULL
        FOR UPDATE
      `);
      const existing = await tx.business.findFirst({
        where: { id: actor.businessId, businessAccountId: actor.businessAccountId, deletedAt: null },
        select: { appointmentConfirmationMode: true },
      });
      if (!existing) throw new AppError(404, "Business not found", "BUSINESS_NOT_FOUND");
      guard?.assertCurrent(existing);
      const next = await tx.business.update({
        where: { id: actor.businessId },
        data: { appointmentConfirmationMode: input.appointmentConfirmationMode },
        select: { id: true, appointmentConfirmationMode: true, updatedAt: true },
      });
      await tx.auditLog.create({
        data: {
          ...context,
          action: AuditAction.APPOINTMENT_CONFIRMATION_MODE_UPDATED,
          businessId: actor.businessId,
          userId: actor.userId,
          actorMembershipId: actor.membershipId,
          metadata: json({
            businessId: actor.businessId,
            oldValue: existing.appointmentConfirmationMode,
            newValue: next.appointmentConfirmationMode,
            confirmationMode: next.appointmentConfirmationMode,
            actorUserId: actor.userId,
            actorMembershipId: actor.membershipId,
          }),
        },
      });
      const reconciliation = guard?.skipKnowledgeReconciliation ? null : await reconcileKnowledgeAfterSettingsMutation(tx, {
        businessId: actor.businessId,
        actorUserId: actor.userId,
        actorMembershipId: actor.membershipId,
        canonicalEntityType: "APPOINTMENT_SETTINGS",
        canonicalEntityId: actor.businessId,
        fields: [{
          canonicalField: "appointmentConfirmationMode",
          value: next.appointmentConfirmationMode,
          normalizedValue: next.appointmentConfirmationMode,
        }],
      });
      return { next, reconciliation };
    });
    await invalidateAppointmentCaches(actor.businessId);
    realtimeService.publish({
      type: "business.appointment.updated",
      businessId: actor.businessId,
      payload: {
        businessId: actor.businessId,
        appointmentConfirmationMode: updated.next.appointmentConfirmationMode,
        updatedAt: updated.next.updatedAt.toISOString(),
      },
    });
    publishKnowledgeSettingsReconciliation(actor.businessId, updated.reconciliation);
    return { settings: updated.next };
}

import { AiPromptScope, AuditAction } from "@prisma/client";
import { auditService } from "../../audit.service";
import { subscriptionService } from "../../subscription.service";
import { aiPromptValidationService } from "../validation/ai-prompt-validation.service";
import { AiPromptActor } from "../core/ai-prompt.types";
import { AiPromptPreviewInput } from "../../../validation/ai-prompt.schemas";
import { assertCanReadAiPrompts } from "../core/ai-prompt-management.service";
import { aiPromptResolverService } from "../resolution/ai-prompt-resolver.service";

function json(value: unknown) {
  return JSON.parse(JSON.stringify(value));
}

export const aiPromptPreviewService = {
  async preview(actor: AiPromptActor, scope: AiPromptScope, input: AiPromptPreviewInput) {
    assertCanReadAiPrompts(actor);
    const subscription = await subscriptionService.getCurrentRecord(actor.businessAccountId);
    const promptText = input.promptText ?? "";
    const validation = promptText
      ? aiPromptValidationService.validate({ scope, promptText, plan: subscription.plan.code })
      : null;
    const resolved = await aiPromptResolverService.resolve({
      businessId: actor.businessId,
      businessAccountId: actor.businessAccountId,
      scope,
    });

    const followUp = validation?.compiled.followUp;
    const preview = {
      previewType: "CONFIGURATION_PREVIEW" as const,
      isRuntimeSimulation: false,
      isAiResponsePreview: false,
      scope,
      plan: subscription.plan.code,
      capabilities: resolved.capabilities,
      activeLayers: {
        platformRules: resolved.platformRules,
        productRules: resolved.productRules,
        globalPromptVersionId: resolved.globalPrompt?.versionId ?? null,
        modulePromptVersionId: resolved.modulePrompt?.versionId ?? null,
        warnings: resolved.warnings ?? [],
      },
      valid: validation?.valid ?? null,
      issues: validation?.issues ?? [],
      compiled: validation?.compiled ?? null,
      detectedCondition: input.customerContext?.match(/\b(price|approval|wife|husband|boss|travel|next week|Friday|stop|not interested)\b/i)?.[0] ?? null,
      recommendedBehavior: scope === AiPromptScope.FOLLOW_UP ? {
        maximumAttempts: followUp?.maximumAttempts ?? (subscription.plan.code === "PREMIUM" ? 3 : subscription.plan.code === "PLUS" ? 2 : 1),
        defaultDelayMinutes: followUp?.defaultDelayMinutes ?? null,
        needsApprovalDelayMinutes: followUp?.needsApprovalDelayMinutes ?? null,
        tone: followUp?.tone ?? "professional",
        adaptiveTiming: Boolean(followUp?.allowAdaptiveTiming),
      } : null,
      sideEffects: {
        createsJobs: false,
        sendsMessages: false,
        modifiesLeads: false,
        modifiesAppointments: false,
        triggersNotifications: false,
      },
      note: "Configuration preview only. This is not an AI response simulation and no jobs, messages, leads, appointments, or notifications were changed.",
    };

    await auditService.log({
      action: AuditAction.AI_PROMPT_PREVIEWED,
      businessId: actor.businessId,
      userId: actor.userId,
      actorMembershipId: actor.membershipId,
      metadata: json({ scope, valid: preview.valid }),
    });

    return preview;
  },
};

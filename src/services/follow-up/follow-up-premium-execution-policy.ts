import { PremiumFollowUpGenerationStatus } from "@prisma/client";
import { PremiumFollowUpLifecycleValidationResult } from "./follow-up-premium-lifecycle-validator.service";
import { PremiumFollowUpGenerationResult } from "./follow-up-premium-message.types";

export type PremiumFollowUpExecutionAction =
  | "SEND"
  | "SCHEDULE"
  | "STOP"
  | "RECALCULATE"
  | "ESCALATE"
  | "BLOCK";

export type PremiumFollowUpExecutionPlan = {
  action: PremiumFollowUpExecutionAction;
  reason: string;
  requiresMessage: boolean;
  scheduledFor: Date | null;
};

const EXECUTABLE_VALIDATION_STATUSES = new Set([
  "APPROVED",
  "OVERRIDDEN",
  "ESCALATION_REQUIRED",
]);

const EXECUTABLE_GENERATION_STATUSES = new Set<PremiumFollowUpGenerationStatus>([
  PremiumFollowUpGenerationStatus.GENERATED,
  PremiumFollowUpGenerationStatus.FALLBACK_GENERATED,
]);

export function planPremiumFollowUpExecution(input: {
  validation: PremiumFollowUpLifecycleValidationResult;
  generation: PremiumFollowUpGenerationResult | null;
  now?: Date;
}): PremiumFollowUpExecutionPlan {
  const now = input.now ?? new Date();
  const { validation, generation } = input;

  if (validation.executionBlocked) {
    return {
      action: "BLOCK",
      reason: validation.blockReason ?? "PREMIUM_FOLLOW_UP_EXECUTION_BLOCKED",
      requiresMessage: false,
      scheduledFor: null,
    };
  }
  if (validation.finalDecision === "STOP") {
    return {
      action: "STOP",
      reason: validation.validationReason,
      requiresMessage: false,
      scheduledFor: null,
    };
  }
  if (validation.finalDecision === "RECALCULATE" || validation.staleDecision) {
    return {
      action: "RECALCULATE",
      reason: validation.validationReason,
      requiresMessage: false,
      scheduledFor: null,
    };
  }
  if (validation.finalDecision === "SCHEDULE_LATER") {
    const scheduledFor = validation.validatedFollowUpAt
      ? new Date(validation.validatedFollowUpAt)
      : null;
    if (!scheduledFor || !Number.isFinite(scheduledFor.getTime()) || scheduledFor <= now) {
      return {
        action: "RECALCULATE",
        reason: "VALIDATED_FOLLOW_UP_TIME_EXPIRED",
        requiresMessage: false,
        scheduledFor: null,
      };
    }
    return {
      action: "SCHEDULE",
      reason: validation.validationReason,
      requiresMessage: false,
      scheduledFor,
    };
  }
  if (!EXECUTABLE_VALIDATION_STATUSES.has(validation.validationStatus)) {
    return {
      action: "STOP",
      reason: "PREMIUM_VALIDATION_NOT_EXECUTABLE",
      requiresMessage: false,
      scheduledFor: null,
    };
  }
  if (validation.finalDecision === "ESCALATE_TO_STAFF") {
    const acknowledgementReady = Boolean(
      generation
      && EXECUTABLE_GENERATION_STATUSES.has(generation.generationStatus)
      && generation.validationPassed
      && generation.generatedMessage,
    );
    return {
      action: "ESCALATE",
      reason: validation.validationReason,
      requiresMessage: acknowledgementReady,
      scheduledFor: null,
    };
  }
  if (
    validation.finalDecision === "SEND_NOW"
    && generation
    && EXECUTABLE_GENERATION_STATUSES.has(generation.generationStatus)
    && generation.validationPassed
    && generation.generatedMessage
  ) {
    return {
      action: "SEND",
      reason: validation.validationReason,
      requiresMessage: true,
      scheduledFor: null,
    };
  }
  return {
    action: "STOP",
    reason: "PREMIUM_MESSAGE_NOT_APPROVED",
    requiresMessage: false,
    scheduledFor: null,
  };
}

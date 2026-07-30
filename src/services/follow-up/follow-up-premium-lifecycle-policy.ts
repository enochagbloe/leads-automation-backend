import {
  FollowUpRuleType,
  PremiumFollowUpSequenceStage,
} from "@prisma/client";
import { PremiumFollowUpContextDecision } from "./follow-up-premium-decision-context.service";

export type PremiumFollowUpValidationStatus =
  | "APPROVED"
  | "OVERRIDDEN"
  | "REJECTED"
  | "RECALCULATION_REQUIRED"
  | "ESCALATION_REQUIRED"
  | "EXECUTION_BLOCKED";

export type PremiumFollowUpScheduleValidation =
  | { status: "NOT_REQUIRED"; validatedAt: null }
  | { status: "VALID"; validatedAt: Date }
  | { status: "ADJUSTED"; validatedAt: Date }
  | { status: "EXPIRED"; validatedAt: null }
  | { status: "INVALID"; validatedAt: null };

export type PremiumFollowUpLifecycleFacts = {
  originalDecision: PremiumFollowUpContextDecision;
  originalReason: string;
  businessScopeValid: boolean;
  customerOptedOut: boolean;
  humanTakeoverActive: boolean;
  humanReviewActive: boolean;
  activeComplaint: boolean;
  complaintWorkflowHandling: boolean;
  conversationEligible: boolean;
  conversationCanReopen: boolean;
  leadLifecycleStop: boolean;
  leadLifecycleAllowsWorkflow: boolean;
  appointmentCancelled: boolean;
  appointmentRescheduled: boolean;
  appointmentReschedulePending: boolean;
  appointmentCompletedReminder: boolean;
  appointmentMissedOrNoShow: boolean;
  missedAppointmentWorkflowAvailable: boolean;
  staleChangeCode: string | null;
  staleChangeReason: string | null;
  premiumCapabilityActive: boolean;
  monthlyLimitReached: boolean;
  successfulAttemptCount: number;
  effectiveAttemptLimit: number;
  sequenceStage: PremiumFollowUpSequenceStage;
  sequenceStageValid: boolean;
  ruleExists: boolean;
  ruleEnabled: boolean;
  automationEnabled: boolean;
  contextSupported: boolean;
  jobEligible: boolean;
  ruleChanged: boolean;
  duplicateSuccessfulSend: boolean;
  duplicateActiveJob: boolean;
  duplicateShouldSupersede: boolean;
  schedule: PremiumFollowUpScheduleValidation;
  customerContactAvailable: boolean;
  whatsAppConnected: boolean;
  promptConflict: boolean;
  promptConflictReason: string | null;
  promptRequestsEscalation: boolean;
  promptProhibitsFollowUp: boolean;
  ruleType: FollowUpRuleType | null;
};

export type PremiumFollowUpPolicyDecision = {
  finalDecision: PremiumFollowUpContextDecision;
  validationStatus: PremiumFollowUpValidationStatus;
  validationReason: string;
  validatedFollowUpAt: Date | null;
  adjustedSchedule: boolean;
  staleDecision: boolean;
  executionBlocked: boolean;
  blockReason: string | null;
  cancelSequenceRequired: boolean;
  supersedeRequired: boolean;
  escalationRequired: boolean;
  promptConflict: boolean;
  promptConflictReason: string | null;
  hardRulesApplied: string[];
};

function result(
  facts: PremiumFollowUpLifecycleFacts,
  input: {
    decision: PremiumFollowUpContextDecision;
    status: PremiumFollowUpValidationStatus;
    reason: string;
    hardRule: string;
    validatedFollowUpAt?: Date | null;
    adjustedSchedule?: boolean;
    staleDecision?: boolean;
    executionBlocked?: boolean;
    blockReason?: string | null;
    cancelSequenceRequired?: boolean;
    supersedeRequired?: boolean;
    escalationRequired?: boolean;
  },
): PremiumFollowUpPolicyDecision {
  return {
    finalDecision: input.decision,
    validationStatus: input.status,
    validationReason: input.reason,
    validatedFollowUpAt: input.validatedFollowUpAt ?? null,
    adjustedSchedule: input.adjustedSchedule ?? false,
    staleDecision: input.staleDecision ?? false,
    executionBlocked: input.executionBlocked ?? false,
    blockReason: input.blockReason ?? null,
    cancelSequenceRequired: input.cancelSequenceRequired ?? false,
    supersedeRequired: input.supersedeRequired ?? false,
    escalationRequired: input.escalationRequired ?? false,
    promptConflict: facts.promptConflict,
    promptConflictReason: facts.promptConflictReason,
    hardRulesApplied: [input.hardRule],
  };
}

function stop(
  facts: PremiumFollowUpLifecycleFacts,
  reason: string,
  hardRule: string,
  options: {
    status?: PremiumFollowUpValidationStatus;
    cancelSequenceRequired?: boolean;
    supersedeRequired?: boolean;
  } = {},
) {
  return result(facts, {
    decision: "STOP",
    status: options.status ?? (facts.originalDecision === "STOP" ? "APPROVED" : "OVERRIDDEN"),
    reason,
    hardRule,
    cancelSequenceRequired: options.cancelSequenceRequired,
    supersedeRequired: options.supersedeRequired,
  });
}

function recalculate(
  facts: PremiumFollowUpLifecycleFacts,
  reason: string,
  hardRule: string,
  options: { supersedeRequired?: boolean } = {},
) {
  return result(facts, {
    decision: "RECALCULATE",
    status: "RECALCULATION_REQUIRED",
    reason,
    hardRule,
    staleDecision: true,
    supersedeRequired: options.supersedeRequired,
  });
}

function escalate(facts: PremiumFollowUpLifecycleFacts, reason: string, hardRule: string) {
  return result(facts, {
    decision: "ESCALATE_TO_STAFF",
    status: "ESCALATION_REQUIRED",
    reason,
    hardRule,
    escalationRequired: true,
  });
}

export function validatePremiumFollowUpLifecycle(
  facts: PremiumFollowUpLifecycleFacts,
): PremiumFollowUpPolicyDecision {
  if (!facts.businessScopeValid) {
    return stop(facts, "BUSINESS_SCOPE_MISMATCH", "BUSINESS_ISOLATION_CHECK", {
      status: "REJECTED",
      cancelSequenceRequired: true,
    });
  }
  if (facts.customerOptedOut) {
    return stop(facts, "CUSTOMER_OPTED_OUT", "CUSTOMER_OPT_OUT_CHECK", {
      cancelSequenceRequired: true,
    });
  }
  if (facts.humanTakeoverActive) {
    return stop(facts, "HUMAN_TAKEOVER_ACTIVE", "HUMAN_TAKEOVER_CHECK", {
      cancelSequenceRequired: true,
    });
  }
  if (facts.humanReviewActive) {
    return stop(facts, "HUMAN_REVIEW_ACTIVE", "HUMAN_REVIEW_CHECK");
  }
  if (facts.activeComplaint) {
    return facts.complaintWorkflowHandling
      ? stop(facts, "ACTIVE_COMPLAINT_WORKFLOW", "COMPLAINT_PROTECTION_CHECK")
      : escalate(facts, "ACTIVE_COMPLAINT_REQUIRES_STAFF", "COMPLAINT_PROTECTION_CHECK");
  }
  if (!facts.conversationEligible) {
    return facts.conversationCanReopen
      ? recalculate(facts, "CONVERSATION_REOPEN_REQUIRES_RECALCULATION", "CONVERSATION_LIFECYCLE_CHECK")
      : stop(facts, "CONVERSATION_NOT_ELIGIBLE", "CONVERSATION_LIFECYCLE_CHECK", {
        cancelSequenceRequired: true,
      });
  }
  if (facts.leadLifecycleStop && !facts.leadLifecycleAllowsWorkflow) {
    return stop(facts, "LEAD_LIFECYCLE_STOP", "LEAD_LIFECYCLE_CHECK", {
      cancelSequenceRequired: true,
    });
  }
  if (facts.appointmentCancelled) {
    return stop(facts, "APPOINTMENT_CANCELLED", "APPOINTMENT_LIFECYCLE_CHECK", {
      cancelSequenceRequired: true,
    });
  }
  if (facts.appointmentReschedulePending) {
    return recalculate(facts, "RESCHEDULE_REQUEST_PENDING", "APPOINTMENT_LIFECYCLE_CHECK", {
      supersedeRequired: true,
    });
  }
  if (facts.appointmentRescheduled) {
    return recalculate(facts, "APPOINTMENT_RESCHEDULED", "APPOINTMENT_LIFECYCLE_CHECK", {
      supersedeRequired: true,
    });
  }
  if (facts.appointmentCompletedReminder) {
    return stop(facts, "APPOINTMENT_ALREADY_COMPLETED", "APPOINTMENT_LIFECYCLE_CHECK", {
      cancelSequenceRequired: true,
    });
  }
  if (facts.appointmentMissedOrNoShow) {
    return facts.missedAppointmentWorkflowAvailable
      ? recalculate(facts, "APPOINTMENT_MISSED_WORKFLOW_REQUIRED", "APPOINTMENT_LIFECYCLE_CHECK")
      : stop(facts, "APPOINTMENT_NOT_ELIGIBLE", "APPOINTMENT_LIFECYCLE_CHECK", {
        cancelSequenceRequired: true,
      });
  }
  if (facts.staleChangeCode) {
    return recalculate(
      facts,
      facts.staleChangeCode,
      facts.staleChangeReason ?? "ENTITY_ACTIVITY_CHECK",
      { supersedeRequired: true },
    );
  }
  if (!facts.premiumCapabilityActive || facts.monthlyLimitReached) {
    return stop(facts, "PREMIUM_CAPABILITY_UNAVAILABLE", "SUBSCRIPTION_CAPABILITY_CHECK", {
      cancelSequenceRequired: true,
    });
  }
  if (!facts.sequenceStageValid) {
    return stop(facts, "INVALID_SEQUENCE_STAGE", "SEQUENCE_LIMIT_CHECK", {
      status: "REJECTED",
      cancelSequenceRequired: true,
    });
  }
  if (facts.successfulAttemptCount >= facts.effectiveAttemptLimit) {
    return stop(facts, "MAXIMUM_ATTEMPTS_REACHED", "SEQUENCE_LIMIT_CHECK", {
      cancelSequenceRequired: true,
    });
  }
  if (
    !facts.ruleExists
    || !facts.ruleEnabled
    || !facts.automationEnabled
    || !facts.contextSupported
    || !facts.jobEligible
  ) {
    return stop(facts, "FOLLOW_UP_JOB_NOT_ELIGIBLE", "FOLLOW_UP_CONFIGURATION_CHECK", {
      cancelSequenceRequired: true,
    });
  }
  if (facts.ruleChanged) {
    return recalculate(facts, "FOLLOW_UP_RULE_CHANGED", "FOLLOW_UP_CONFIGURATION_CHECK", {
      supersedeRequired: true,
    });
  }
  if (facts.duplicateSuccessfulSend) {
    return stop(facts, "FOLLOW_UP_ALREADY_SENT", "DUPLICATE_PREVENTION_CHECK", {
      cancelSequenceRequired: true,
    });
  }
  if (facts.duplicateActiveJob) {
    return stop(facts, "DUPLICATE_ACTIVE_JOB", "DUPLICATE_PREVENTION_CHECK", {
      supersedeRequired: facts.duplicateShouldSupersede,
    });
  }
  if (facts.originalDecision === "SEND_NOW" && facts.schedule.status === "ADJUSTED") {
    const whatsAppBlocked = !facts.whatsAppConnected;
    return result(facts, {
      decision: "SCHEDULE_LATER",
      status: whatsAppBlocked ? "EXECUTION_BLOCKED" : "OVERRIDDEN",
      reason: whatsAppBlocked ? "WHATSAPP_DISCONNECTED" : "SEND_TIME_ADJUSTED_TO_ALLOWED_WINDOW",
      hardRule: "SCHEDULING_VALIDATION_CHECK",
      validatedFollowUpAt: facts.schedule.validatedAt,
      adjustedSchedule: true,
      executionBlocked: whatsAppBlocked,
      blockReason: whatsAppBlocked ? "WHATSAPP_DISCONNECTED" : null,
    });
  }
  if (facts.originalDecision === "SEND_NOW" && facts.schedule.status === "INVALID") {
    return escalate(facts, "INVALID_SCHEDULING_CONTEXT", "SCHEDULING_VALIDATION_CHECK");
  }
  if (facts.originalDecision === "SCHEDULE_LATER") {
    if (facts.schedule.status === "EXPIRED") {
      return recalculate(facts, "PROPOSED_TIME_EXPIRED", "SCHEDULING_VALIDATION_CHECK");
    }
    if (facts.schedule.status === "INVALID" || facts.schedule.status === "NOT_REQUIRED") {
      return escalate(facts, "INVALID_SCHEDULING_CONTEXT", "SCHEDULING_VALIDATION_CHECK");
    }
  }
  if (!facts.customerContactAvailable) {
    return stop(facts, "CUSTOMER_CONTACT_UNAVAILABLE", "WHATSAPP_CONTACT_CHECK", {
      cancelSequenceRequired: true,
    });
  }
  if (facts.promptRequestsEscalation) {
    return escalate(facts, "BUSINESS_PROMPT_REQUESTS_ESCALATION", "BUSINESS_PROMPT_PREFERENCE_CHECK");
  }
  if (facts.promptProhibitsFollowUp) {
    return stop(facts, "BUSINESS_PROMPT_PROHIBITS_FOLLOW_UP", "BUSINESS_PROMPT_PREFERENCE_CHECK", {
      cancelSequenceRequired: true,
    });
  }

  const validatedAt = facts.originalDecision === "SCHEDULE_LATER"
    && (facts.schedule.status === "VALID" || facts.schedule.status === "ADJUSTED")
    ? facts.schedule.validatedAt
    : null;
  const requiresWhatsAppExecution = facts.originalDecision === "SEND_NOW"
    || facts.originalDecision === "SCHEDULE_LATER";
  const whatsAppBlocked = requiresWhatsAppExecution && !facts.whatsAppConnected;
  const approved = result(facts, {
    decision: facts.originalDecision,
    status: !whatsAppBlocked ? (
      facts.originalDecision === "RECALCULATE"
        ? "RECALCULATION_REQUIRED"
        : facts.originalDecision === "ESCALATE_TO_STAFF"
          ? "ESCALATION_REQUIRED"
          : "APPROVED"
    ) : "EXECUTION_BLOCKED",
    reason: !whatsAppBlocked ? facts.originalReason : "WHATSAPP_DISCONNECTED",
    hardRule: !whatsAppBlocked ? "FINAL_BACKEND_VALIDATION" : "WHATSAPP_CONNECTION_CHECK",
    validatedFollowUpAt: validatedAt,
    adjustedSchedule: facts.schedule.status === "ADJUSTED",
    executionBlocked: whatsAppBlocked,
    blockReason: whatsAppBlocked ? "WHATSAPP_DISCONNECTED" : null,
    escalationRequired: facts.originalDecision === "ESCALATE_TO_STAFF",
  });
  return approved;
}

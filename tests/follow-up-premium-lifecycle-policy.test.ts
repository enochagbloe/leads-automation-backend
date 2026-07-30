import assert from "node:assert/strict";
import test from "node:test";
import {
  FollowUpRuleType,
  PremiumFollowUpSequenceStage,
} from "@prisma/client";
import {
  PremiumFollowUpLifecycleFacts,
  validatePremiumFollowUpLifecycle,
} from "../src/services/follow-up/follow-up-premium-lifecycle-policy";

function validFacts(
  overrides: Partial<PremiumFollowUpLifecycleFacts> = {},
): PremiumFollowUpLifecycleFacts {
  return {
    originalDecision: "SEND_NOW",
    originalReason: "Follow-up is due",
    businessScopeValid: true,
    customerOptedOut: false,
    humanTakeoverActive: false,
    humanReviewActive: false,
    activeComplaint: false,
    complaintWorkflowHandling: false,
    conversationEligible: true,
    conversationCanReopen: false,
    leadLifecycleStop: false,
    leadLifecycleAllowsWorkflow: false,
    appointmentCancelled: false,
    appointmentRescheduled: false,
    appointmentReschedulePending: false,
    appointmentCompletedReminder: false,
    appointmentMissedOrNoShow: false,
    missedAppointmentWorkflowAvailable: false,
    staleChangeCode: null,
    staleChangeReason: null,
    premiumCapabilityActive: true,
    monthlyLimitReached: false,
    successfulAttemptCount: 0,
    effectiveAttemptLimit: 3,
    sequenceStage: PremiumFollowUpSequenceStage.INITIAL_CHECK_IN,
    sequenceStageValid: true,
    ruleExists: true,
    ruleEnabled: true,
    automationEnabled: true,
    contextSupported: true,
    jobEligible: true,
    ruleChanged: false,
    duplicateSuccessfulSend: false,
    duplicateActiveJob: false,
    duplicateShouldSupersede: false,
    schedule: { status: "NOT_REQUIRED", validatedAt: null },
    customerContactAvailable: true,
    whatsAppConnected: true,
    promptConflict: false,
    promptConflictReason: null,
    promptRequestsEscalation: false,
    promptProhibitsFollowUp: false,
    ruleType: FollowUpRuleType.NO_RESPONSE_AFTER_MESSAGE,
    ...overrides,
  };
}

test("customer opt-out overrides SEND_NOW and cancels the sequence", () => {
  const result = validatePremiumFollowUpLifecycle(validFacts({ customerOptedOut: true }));
  assert.equal(result.finalDecision, "STOP");
  assert.equal(result.validationReason, "CUSTOMER_OPTED_OUT");
  assert.equal(result.cancelSequenceRequired, true);
});

test("human takeover stops automation", () => {
  const result = validatePremiumFollowUpLifecycle(validFacts({ humanTakeoverActive: true }));
  assert.equal(result.finalDecision, "STOP");
  assert.equal(result.validationReason, "HUMAN_TAKEOVER_ACTIVE");
});

test("active complaint rejects generic follow-up and escalates", () => {
  const result = validatePremiumFollowUpLifecycle(validFacts({ activeComplaint: true }));
  assert.equal(result.finalDecision, "ESCALATE_TO_STAFF");
  assert.equal(result.escalationRequired, true);
});

test("staff activity after scheduling requires recalculation", () => {
  const result = validatePremiumFollowUpLifecycle(validFacts({
    staleChangeCode: "STAFF_REPLIED_AFTER_JOB_SCHEDULED",
    staleChangeReason: "STAFF_ACTIVITY_CHECK",
  }));
  assert.equal(result.finalDecision, "RECALCULATE");
  assert.equal(result.staleDecision, true);
  assert.equal(result.supersedeRequired, true);
});

test("rescheduled appointment invalidates an old reminder", () => {
  const result = validatePremiumFollowUpLifecycle(validFacts({
    appointmentRescheduled: true,
    ruleType: FollowUpRuleType.BEFORE_APPOINTMENT,
  }));
  assert.equal(result.finalDecision, "RECALCULATE");
  assert.equal(result.validationReason, "APPOINTMENT_RESCHEDULED");
});

test("cancelled appointment stops and cancels the sequence", () => {
  const result = validatePremiumFollowUpLifecycle(validFacts({
    appointmentCancelled: true,
    ruleType: FollowUpRuleType.BEFORE_APPOINTMENT,
  }));
  assert.equal(result.finalDecision, "STOP");
  assert.equal(result.validationReason, "APPOINTMENT_CANCELLED");
  assert.equal(result.cancelSequenceRequired, true);
});

test("maximum three successful attempts prevents a fourth attempt", () => {
  const result = validatePremiumFollowUpLifecycle(validFacts({
    successfulAttemptCount: 3,
    effectiveAttemptLimit: 3,
    sequenceStage: PremiumFollowUpSequenceStage.FINAL_POLITE_FOLLOW_UP,
  }));
  assert.equal(result.finalDecision, "STOP");
  assert.equal(result.validationReason, "MAXIMUM_ATTEMPTS_REACHED");
});

test("business maximum of two rejects a third attempt", () => {
  const result = validatePremiumFollowUpLifecycle(validFacts({
    successfulAttemptCount: 2,
    effectiveAttemptLimit: 2,
  }));
  assert.equal(result.finalDecision, "STOP");
  assert.equal(result.validationReason, "MAXIMUM_ATTEMPTS_REACHED");
});

test("business maximum of zero disables automated attempts", () => {
  const result = validatePremiumFollowUpLifecycle(validFacts({
    successfulAttemptCount: 0,
    effectiveAttemptLimit: 0,
  }));
  assert.equal(result.finalDecision, "STOP");
  assert.equal(result.validationReason, "MAXIMUM_ATTEMPTS_REACHED");
});

test("prompt cannot override customer opt-out", () => {
  const result = validatePremiumFollowUpLifecycle(validFacts({
    customerOptedOut: true,
    promptConflict: true,
    promptConflictReason: "Prompt requested messaging after opt-out",
  }));
  assert.equal(result.finalDecision, "STOP");
  assert.equal(result.validationReason, "CUSTOMER_OPTED_OUT");
  assert.equal(result.promptConflict, true);
});

test("subscription downgrade rejects the Premium job", () => {
  const result = validatePremiumFollowUpLifecycle(validFacts({ premiumCapabilityActive: false }));
  assert.equal(result.finalDecision, "STOP");
  assert.equal(result.validationReason, "PREMIUM_CAPABILITY_UNAVAILABLE");
});

test("customer timing is adjusted to a valid business-hours time", () => {
  const adjusted = new Date("2026-08-03T08:00:00.000Z");
  const result = validatePremiumFollowUpLifecycle(validFacts({
    originalDecision: "SCHEDULE_LATER",
    schedule: { status: "ADJUSTED", validatedAt: adjusted },
  }));
  assert.equal(result.finalDecision, "SCHEDULE_LATER");
  assert.equal(result.adjustedSchedule, true);
  assert.equal(result.validatedFollowUpAt?.toISOString(), adjusted.toISOString());
});

test("WhatsApp disconnection blocks execution without replacing the business decision", () => {
  const result = validatePremiumFollowUpLifecycle(validFacts({ whatsAppConnected: false }));
  assert.equal(result.finalDecision, "SEND_NOW");
  assert.equal(result.validationStatus, "EXECUTION_BLOCKED");
  assert.equal(result.executionBlocked, true);
  assert.equal(result.blockReason, "WHATSAPP_DISCONNECTED");
});

test("business-hours adjustment preserves the WhatsApp execution block", () => {
  const adjusted = new Date("2026-08-03T08:00:00.000Z");
  const result = validatePremiumFollowUpLifecycle(validFacts({
    schedule: { status: "ADJUSTED", validatedAt: adjusted },
    whatsAppConnected: false,
  }));
  assert.equal(result.finalDecision, "SCHEDULE_LATER");
  assert.equal(result.validatedFollowUpAt?.toISOString(), adjusted.toISOString());
  assert.equal(result.executionBlocked, true);
  assert.equal(result.blockReason, "WHATSAPP_DISCONNECTED");
});

test("reopenable closed conversation requires recalculation without reopening it", () => {
  const result = validatePremiumFollowUpLifecycle(validFacts({
    conversationEligible: false,
    conversationCanReopen: true,
  }));
  assert.equal(result.finalDecision, "RECALCULATE");
  assert.equal(result.validationReason, "CONVERSATION_REOPEN_REQUIRES_RECALCULATION");
});

test("successful duplicate prevents another send", () => {
  const result = validatePremiumFollowUpLifecycle(validFacts({ duplicateSuccessfulSend: true }));
  assert.equal(result.finalDecision, "STOP");
  assert.equal(result.validationReason, "FOLLOW_UP_ALREADY_SENT");
});

test("cross-business data is rejected before other rules", () => {
  const result = validatePremiumFollowUpLifecycle(validFacts({
    businessScopeValid: false,
    customerOptedOut: true,
  }));
  assert.equal(result.finalDecision, "STOP");
  assert.equal(result.validationStatus, "REJECTED");
  assert.equal(result.validationReason, "BUSINESS_SCOPE_MISMATCH");
  assert.deepEqual(result.hardRulesApplied, ["BUSINESS_ISOLATION_CHECK"]);
});

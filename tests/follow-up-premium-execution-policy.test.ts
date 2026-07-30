import assert from "node:assert/strict";
import test from "node:test";
import {
  FollowUpContextType,
  PremiumFollowUpExecutionStatus,
  PremiumFollowUpGenerationStatus,
  PremiumFollowUpMessageSource,
  PremiumFollowUpSequenceStage,
} from "@prisma/client";
import {
  planPremiumFollowUpExecution,
} from "../src/services/follow-up/follow-up-premium-execution-policy";
import {
  premiumFollowUpExecutionIdentity,
  premiumFollowUpExecutionLeaseDisposition,
  premiumFollowUpRecalculationRetryAt,
} from "../src/services/follow-up/follow-up-premium-execution.service";
import { followUpActivityBaseline } from "../src/services/follow-up/follow-up.shared";
import {
  PremiumFollowUpLifecycleValidationResult,
} from "../src/services/follow-up/follow-up-premium-lifecycle-validator.service";
import {
  PremiumFollowUpGenerationResult,
} from "../src/services/follow-up/follow-up-premium-message.types";

const now = new Date("2026-07-27T10:00:00.000Z");

function validation(
  overrides: Partial<PremiumFollowUpLifecycleValidationResult> = {},
): PremiumFollowUpLifecycleValidationResult {
  return {
    originalRecommendation: { decision: "SEND_NOW", reason: "Follow-up is due" },
    finalDecision: "SEND_NOW",
    validationStatus: "APPROVED",
    validationReason: "FOLLOW_UP_APPROVED",
    businessId: "business-1",
    conversationId: "conversation-1",
    customerId: "lead-1",
    followUpJobId: "job-1",
    followUpRuleId: "rule-1",
    contextType: FollowUpContextType.GENERAL_NO_RESPONSE,
    appointmentId: null,
    complaintId: null,
    complaintStatus: null,
    customerGoal: "Book a consultation",
    customerObjection: null,
    customerTiming: null,
    unresolvedRequest: null,
    leadStatus: null,
    appointmentStatus: null,
    assignedStaffId: null,
    promptVersions: { global: null, followUp: null },
    memoryVersion: "1",
    sequenceStage: PremiumFollowUpSequenceStage.INITIAL_CHECK_IN,
    successfulAttemptCount: 0,
    effectiveAttemptLimit: 3,
    proposedFollowUpAt: null,
    validatedFollowUpAt: null,
    adjustedSchedule: false,
    staleDecision: false,
    executionBlocked: false,
    blockReason: null,
    cancelSequenceRequired: false,
    supersedeRequired: false,
    escalationRequired: false,
    promptConflict: false,
    promptConflictReason: null,
    hardRulesApplied: [],
    latestEntityVersions: {
      evaluatedAt: now.toISOString(),
      jobUpdatedAt: now.toISOString(),
      ruleUpdatedAt: now.toISOString(),
      conversationUpdatedAt: now.toISOString(),
      leadUpdatedAt: now.toISOString(),
      appointmentUpdatedAt: null,
      appointmentStartTime: null,
      complaintUpdatedAt: null,
      lastCustomerActivityAt: null,
      lastStaffActivityAt: null,
      promptActivatedAt: null,
    },
    fallbacksUsed: [],
    ...overrides,
  };
}

function generation(
  overrides: Partial<PremiumFollowUpGenerationResult> = {},
): PremiumFollowUpGenerationResult {
  return {
    generationId: "generation-1",
    generationStatus: PremiumFollowUpGenerationStatus.GENERATED,
    finalDecision: "SEND_NOW",
    businessId: "business-1",
    conversationId: "conversation-1",
    customerId: "lead-1",
    followUpJobId: "job-1",
    followUpRuleId: "rule-1",
    contextType: FollowUpContextType.GENERAL_NO_RESPONSE,
    sequenceStage: PremiumFollowUpSequenceStage.INITIAL_CHECK_IN,
    successfulAttemptCount: 0,
    effectiveAttemptLimit: 3,
    generatedMessage: "Hi Nana, would you like to continue with your request?",
    fallbackMessageUsed: false,
    messageSource: PremiumFollowUpMessageSource.AI_GENERATED,
    customerGoalUsed: "Book a consultation",
    customerObjectionUsed: null,
    timingContextUsed: null,
    unresolvedRequestUsed: null,
    appointmentFactsUsed: null,
    promptVersionsUsed: { global: null, followUp: null },
    memoryVersionUsed: "1",
    generationModelUsed: "test-model",
    promptConflict: false,
    missingKnowledge: false,
    validationPassed: true,
    validationIssues: [],
    regenerationAttempted: false,
    idempotencyKey: "generation-key",
    contextVersion: "context-v1",
    generatedAt: now.toISOString(),
    ...overrides,
  };
}

test("approved SEND_NOW requires the validated Round 3 message", () => {
  const result = planPremiumFollowUpExecution({
    validation: validation(),
    generation: generation(),
    now,
  });
  assert.equal(result.action, "SEND");
  assert.equal(result.requiresMessage, true);
});

test("generation failure never reaches outbound execution", () => {
  const result = planPremiumFollowUpExecution({
    validation: validation(),
    generation: generation({
      generationStatus: PremiumFollowUpGenerationStatus.GENERATION_FAILED,
      generatedMessage: null,
      validationPassed: false,
    }),
    now,
  });
  assert.equal(result.action, "STOP");
  assert.equal(result.reason, "PREMIUM_MESSAGE_NOT_APPROVED");
});

test("validated future schedule is applied without sending stored copy", () => {
  const result = planPremiumFollowUpExecution({
    validation: validation({
      finalDecision: "SCHEDULE_LATER",
      validatedFollowUpAt: "2026-08-03T09:00:00.000Z",
    }),
    generation: null,
    now,
  });
  assert.equal(result.action, "SCHEDULE");
  assert.equal(result.requiresMessage, false);
  assert.equal(result.scheduledFor?.toISOString(), "2026-08-03T09:00:00.000Z");
});

test("expired schedule requires recalculation", () => {
  const result = planPremiumFollowUpExecution({
    validation: validation({
      finalDecision: "SCHEDULE_LATER",
      validatedFollowUpAt: "2026-07-27T09:00:00.000Z",
    }),
    generation: null,
    now,
  });
  assert.equal(result.action, "RECALCULATE");
});

test("STOP and stale decisions cannot generate delivery work", () => {
  assert.equal(planPremiumFollowUpExecution({
    validation: validation({ finalDecision: "STOP", cancelSequenceRequired: true }),
    generation: generation(),
    now,
  }).action, "STOP");
  assert.equal(planPremiumFollowUpExecution({
    validation: validation({ staleDecision: true }),
    generation: generation(),
    now,
  }).action, "RECALCULATE");
});

test("WhatsApp execution block preserves a blocked action", () => {
  const result = planPremiumFollowUpExecution({
    validation: validation({
      executionBlocked: true,
      blockReason: "WHATSAPP_DISCONNECTED",
    }),
    generation: generation(),
    now,
  });
  assert.equal(result.action, "BLOCK");
  assert.equal(result.reason, "WHATSAPP_DISCONNECTED");
});

test("staff escalation may send only an approved acknowledgement", () => {
  const result = planPremiumFollowUpExecution({
    validation: validation({
      finalDecision: "ESCALATE_TO_STAFF",
      validationStatus: "ESCALATION_REQUIRED",
      escalationRequired: true,
    }),
    generation: generation({
      finalDecision: "ESCALATE_TO_STAFF",
      messageSource: PremiumFollowUpMessageSource.ESCALATION_TEMPLATE,
    }),
    now,
  });
  assert.equal(result.action, "ESCALATE");
  assert.equal(result.requiresMessage, true);
});

test("execution identity is stable and changes with context", () => {
  const input = {
    businessId: "business-1",
    jobId: "job-1",
    sequenceStage: PremiumFollowUpSequenceStage.INITIAL_CHECK_IN,
    finalDecision: "SEND_NOW",
    contextVersion: "context-v1",
    generationId: "generation-1",
  };
  assert.equal(
    premiumFollowUpExecutionIdentity(input),
    premiumFollowUpExecutionIdentity(input),
  );
  assert.notEqual(
    premiumFollowUpExecutionIdentity(input),
    premiumFollowUpExecutionIdentity({ ...input, contextVersion: "context-v2" }),
  );
});

test("fresh execution leases cannot be taken over by concurrent callers", () => {
  assert.equal(
    premiumFollowUpExecutionLeaseDisposition({
      executionStatus: PremiumFollowUpExecutionStatus.EXECUTING,
      processingStartedAt: new Date("2026-07-27T09:55:00.000Z"),
      now,
    }),
    "ALREADY_IN_PROGRESS",
  );
  assert.equal(
    premiumFollowUpExecutionLeaseDisposition({
      executionStatus: PremiumFollowUpExecutionStatus.READY_TO_SEND,
      processingStartedAt: new Date("2026-07-27T09:51:00.000Z"),
      now,
    }),
    "ALREADY_IN_PROGRESS",
  );
});

test("only stale transient execution leases can be recovered", () => {
  assert.equal(
    premiumFollowUpExecutionLeaseDisposition({
      executionStatus: PremiumFollowUpExecutionStatus.EXECUTING,
      processingStartedAt: new Date("2026-07-27T09:49:59.000Z"),
      now,
    }),
    "TAKE_OVER",
  );
  assert.equal(
    premiumFollowUpExecutionLeaseDisposition({
      executionStatus: PremiumFollowUpExecutionStatus.DELIVERY_STARTED,
      processingStartedAt: new Date("2026-07-27T08:00:00.000Z"),
      now,
    }),
    "TERMINAL",
  );
  assert.equal(
    premiumFollowUpExecutionLeaseDisposition({
      executionStatus: PremiumFollowUpExecutionStatus.SENT,
      processingStartedAt: new Date("2026-07-27T08:00:00.000Z"),
      now,
    }),
    "TERMINAL",
  );
});

test("Premium recalculation retries use bounded exponential backoff", () => {
  assert.equal(
    premiumFollowUpRecalculationRetryAt(1, now).toISOString(),
    "2026-07-27T10:01:00.000Z",
  );
  assert.equal(
    premiumFollowUpRecalculationRetryAt(3, now).toISOString(),
    "2026-07-27T10:04:00.000Z",
  );
  assert.equal(
    premiumFollowUpRecalculationRetryAt(20, now).toISOString(),
    "2026-07-27T10:15:00.000Z",
  );
});

test("recalculation baseline supersedes old activity without trusting invalid metadata", () => {
  const createdAt = new Date("2026-07-27T09:00:00.000Z");
  assert.equal(
    followUpActivityBaseline({
      createdAt,
      metadata: { premiumRecalculationBaselineAt: "2026-07-27T09:55:00.000Z" },
    }, now).toISOString(),
    "2026-07-27T09:55:00.000Z",
  );
  assert.equal(
    followUpActivityBaseline({
      createdAt,
      metadata: { premiumRecalculationBaselineAt: "2026-07-27T11:00:00.000Z" },
    }, now).toISOString(),
    createdAt.toISOString(),
  );
});

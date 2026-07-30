import assert from "node:assert/strict";
import test from "node:test";
import {
  FollowUpContextType,
  PremiumFollowUpSequenceStage,
} from "@prisma/client";
import {
  premiumFollowUpGenerationIdentity,
  premiumFollowUpGenerationUsageKey,
} from "../src/services/follow-up/follow-up-premium-message-generator.service";
import {
  premiumFollowUpFallback,
} from "../src/services/follow-up/follow-up-premium-message-fallback.service";
import {
  messageSimilarity,
  validatePremiumFollowUpMessage,
} from "../src/services/follow-up/follow-up-premium-message-validator.service";
import {
  type PremiumFollowUpMessageContext,
} from "../src/services/follow-up/follow-up-premium-message.types";

function context(
  overrides: Partial<PremiumFollowUpMessageContext> = {},
): PremiumFollowUpMessageContext {
  return {
    finalDecision: "SEND_NOW",
    contextType: FollowUpContextType.GENERAL_NO_RESPONSE,
    sequenceStage: PremiumFollowUpSequenceStage.INITIAL_CHECK_IN,
    customerName: "Nana",
    businessName: "Demo Business",
    serviceName: null,
    customerGoal: null,
    customerObjection: null,
    timingContext: null,
    unresolvedRequest: null,
    conversationSummary: null,
    appointmentFacts: null,
    tone: "FRIENDLY",
    responseLength: "SHORT",
    prohibitedPhrases: [],
    recentMessages: [],
    previousAutomatedMessages: [],
    ...overrides,
  };
}

function validate(message: string, overrides: Partial<Parameters<typeof validatePremiumFollowUpMessage>[0]> = {}) {
  return validatePremiumFollowUpMessage({
    message,
    sequenceStage: PremiumFollowUpSequenceStage.INITIAL_CHECK_IN,
    prohibitedPhrases: [],
    previousMessages: [],
    appointmentStatus: null,
    appointmentTimeText: null,
    ...overrides,
  });
}

test("stage 1 continues a booking goal with one concise question", () => {
  const result = premiumFollowUpFallback(context({ customerGoal: "Book a consultation" }));
  assert.match(result.message, /booking request/i);
  assert.equal((result.message.match(/\?/g) ?? []).length, 1);
  assert.equal(validate(result.message).valid, true);
});

test("stage 2 addresses a price objection without inventing a price or discount", () => {
  const result = premiumFollowUpFallback(context({
    sequenceStage: PremiumFollowUpSequenceStage.HELPFUL_CLARIFICATION,
    customerObjection: "The price may be too expensive",
  }));
  assert.match(result.message, /pricing/i);
  assert.doesNotMatch(result.message, /discount|GHS|\$|\d+%/i);
  assert.equal(validate(result.message, {
    sequenceStage: PremiumFollowUpSequenceStage.HELPFUL_CLARIFICATION,
  }).valid, true);
});

test("stage 3 is final and low pressure even when a detail remains unresolved", () => {
  const result = premiumFollowUpFallback(context({
    sequenceStage: PremiumFollowUpSequenceStage.FINAL_POLITE_FOLLOW_UP,
    unresolvedRequest: "Customer location",
  }));
  assert.match(result.message, /final/i);
  assert.match(result.message, /whenever you're ready/i);
  assert.doesNotMatch(result.message, /must respond|last chance|urgent/i);
});

test("future timing context produces timing-aware fallback copy", () => {
  const result = premiumFollowUpFallback(context({
    finalDecision: "SCHEDULE_LATER",
    timingContext: "Contact me next Monday",
  }));
  assert.match(result.message, /as requested/i);
});

test("missing location asks only for the required detail", () => {
  const result = premiumFollowUpFallback(context({
    contextType: FollowUpContextType.MISSING_CUSTOMER_DETAIL,
    unresolvedRequest: "Service location",
  }));
  assert.match(result.message, /share the location/i);
  assert.equal((result.message.match(/\?/g) ?? []).length, 1);
});

test("escalation uses a safe acknowledgement for custom pricing or complaints", () => {
  const result = premiumFollowUpFallback(context({
    finalDecision: "ESCALATE_TO_STAFF",
    customerObjection: "Customer requested custom pricing",
  }));
  assert.match(result.message, /team assist/i);
  assert.doesNotMatch(result.message, /complaint|discount|approved/i);
});

test("false appointment confirmation and stale appointment time are rejected", () => {
  const falseConfirmation = validate("Your appointment is confirmed for 2:00 PM.", {
    appointmentStatus: "PENDING",
  });
  assert.ok(falseConfirmation.issues.includes("APPOINTMENT_FALSELY_CONFIRMED"));

  const staleTime = validate("Your appointment is scheduled for 2:00 PM.", {
    appointmentStatus: "RESCHEDULED",
    appointmentTimeText: "3:00 PM",
  });
  assert.ok(staleTime.issues.includes("APPOINTMENT_TIME_NOT_CURRENT"));
});

test("aggressive, prohibited, and invented commercial copy is rejected", () => {
  const result = validate("Act now for a guaranteed 20% discount.", {
    prohibitedPhrases: ["act now"],
  });
  assert.ok(result.issues.includes("PRESSURE_LANGUAGE_NOT_ALLOWED"));
  assert.ok(result.issues.includes("PROHIBITED_PHRASE_USED"));
  assert.ok(result.issues.includes("UNSUPPORTED_COMMERCIAL_FACT"));
});

test("unsupported operational and policy claims are rejected", () => {
  const cases = [
    {
      message: "We have a slot available tomorrow.",
      issue: "UNSUPPORTED_AVAILABILITY_CLAIM",
    },
    {
      message: "Our service includes free maintenance.",
      issue: "UNSUPPORTED_SERVICE_FEATURE_CLAIM",
    },
    {
      message: "Your project will be completed within five days.",
      issue: "UNSUPPORTED_DELIVERY_CLAIM",
    },
    {
      message: "We guarantee a successful outcome.",
      issue: "UNSUPPORTED_GUARANTEE_CLAIM",
    },
    {
      message: "Our cancellation policy allows refunds.",
      issue: "UNSUPPORTED_POLICY_CLAIM",
    },
  ];

  for (const item of cases) {
    assert.ok(
      validate(item.message).issues.includes(item.issue),
      `${item.issue} was not detected`,
    );
  }
});

test("neutral requests for authoritative details are allowed", () => {
  const messages = [
    "Would you like the team to check appointment availability?",
    "The team can clarify which service option may suit your request.",
    "The team can provide delivery information after reviewing your request.",
    "The team can clarify the warranty or cancellation policy.",
  ];

  for (const message of messages) {
    const issues = validate(message).issues;
    assert.equal(
      issues.some((issue) => issue.startsWith("UNSUPPORTED_")),
      false,
      `${message} was incorrectly treated as a factual claim`,
    );
  }
});

test("substantially duplicated copy is rejected before delivery", () => {
  const previous = "Hi Nana, just checking whether you still need help with your request.";
  const current = "Hi Nana, just checking if you still need help with your request.";
  assert.ok(messageSimilarity(current, previous) >= 0.78);
  assert.ok(validate(current, { previousMessages: [previous] }).issues.includes(
    "MESSAGE_SUBSTANTIALLY_DUPLICATED",
  ));
});

test("the same generation input has a stable idempotency identity", () => {
  const input = {
    jobId: "job-1",
    contextVersion: "context-v1",
    sequenceStage: PremiumFollowUpSequenceStage.HELPFUL_CLARIFICATION,
    promptVersions: { global: "v1", followUp: "v2" },
  };
  assert.equal(
    premiumFollowUpGenerationIdentity(input),
    premiumFollowUpGenerationIdentity(input),
  );
  assert.notEqual(
    premiumFollowUpGenerationIdentity(input),
    premiumFollowUpGenerationIdentity({ ...input, contextVersion: "context-v2" }),
  );
});

test("initial generation and regeneration use distinct stable usage reservations", () => {
  const generationKey = "premium-generation-key";
  assert.equal(
    premiumFollowUpGenerationUsageKey(generationKey, "INITIAL"),
    premiumFollowUpGenerationUsageKey(generationKey, "INITIAL"),
  );
  assert.notEqual(
    premiumFollowUpGenerationUsageKey(generationKey, "INITIAL"),
    premiumFollowUpGenerationUsageKey(generationKey, "REGENERATION"),
  );
});

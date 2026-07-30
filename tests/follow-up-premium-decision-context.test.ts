import assert from "node:assert/strict";
import test from "node:test";
import { FollowUpSendLogDeliveryStatus } from "@prisma/client";
import {
  parseCustomerTimingStatement,
  PremiumFollowUpRecommendationInput,
  recommendPremiumFollowUpDecision,
  safePremiumPromptDefaults,
} from "../src/services/follow-up/follow-up-premium-decision-context.service";
import { FOLLOW_UP_SUCCESSFUL_ATTEMPT_DELIVERY_STATUSES } from "../src/services/follow-up/follow-up.shared";

const now = new Date("2026-07-27T10:00:00.000Z");

function validInput(
  overrides: Partial<PremiumFollowUpRecommendationInput> = {},
): PremiumFollowUpRecommendationInput {
  return {
    now,
    requiredContextAvailable: true,
    premiumCapabilityActive: true,
    subscriptionActive: true,
    businessAutomationEnabled: true,
    ruleEnabled: true,
    whatsAppConnected: true,
    jobPending: true,
    supportedJobType: true,
    conversationClosed: false,
    jobDue: true,
    scheduledFor: new Date("2026-07-27T09:00:00.000Z"),
    pendingRequestResolved: false,
    leadClosed: false,
    appointmentCancelled: false,
    humanTakeoverActive: false,
    maximumAttemptsReached: false,
    customerOptedOut: false,
    customerNoLongerInterested: false,
    storedStopSignal: false,
    customerRequestedHuman: false,
    customPricingOrExceptionRequested: false,
    humanReviewRequired: false,
    activeComplaint: false,
    futureTiming: null,
    changedContext: [],
    ...overrides,
  };
}

test("customer future timing recommends SCHEDULE_LATER", () => {
  const timing = parseCustomerTimingStatement("Contact me next Monday", now, "Africa/Accra");
  assert.ok(timing);
  const result = recommendPremiumFollowUpDecision(validInput({ futureTiming: timing }));
  assert.equal(result.decision, "SCHEDULE_LATER");
  assert.equal(result.proposedFollowUpAt?.toISOString(), "2026-08-03T09:00:00.000Z");
  assert.match(result.reason, /Contact me next Monday/);
});

test("natural-language dates are interpreted in the business timezone", () => {
  const newYorkNow = new Date("2026-07-27T23:30:00.000Z");
  assert.equal(
    parseCustomerTimingStatement("Contact me tomorrow", newYorkNow, "America/New_York")
      ?.at.toISOString(),
    "2026-07-28T13:00:00.000Z",
  );
  assert.equal(
    parseCustomerTimingStatement("Contact me tonight", newYorkNow, "America/New_York")
      ?.at.toISOString(),
    "2026-07-28T23:00:00.000Z",
  );
  assert.equal(
    parseCustomerTimingStatement("Contact me next Monday", newYorkNow, "America/New_York")
      ?.at.toISOString(),
    "2026-08-03T13:00:00.000Z",
  );
});

test("local calendar timing remains correct across daylight-saving changes", () => {
  const beforeDstChange = new Date("2026-03-28T23:30:00.000Z");
  assert.equal(
    parseCustomerTimingStatement("Contact me tomorrow", beforeDstChange, "Europe/London")
      ?.at.toISOString(),
    "2026-03-29T08:00:00.000Z",
  );
  assert.equal(
    parseCustomerTimingStatement("Contact me in 1 day", beforeDstChange, "Europe/London")
      ?.at.toISOString(),
    "2026-03-29T22:30:00.000Z",
  );
});

test("staff activity after job creation recommends RECALCULATE", () => {
  const result = recommendPremiumFollowUpDecision(validInput({
    changedContext: ["Staff replied after the follow-up job was created"],
  }));
  assert.equal(result.decision, "RECALCULATE");
  assert.match(result.reason, /Staff replied/);
});

test("staff activity overrides an older stored timing preference", () => {
  const result = recommendPremiumFollowUpDecision(validInput({
    changedContext: ["Staff replied after the follow-up job was created"],
    futureTiming: {
      at: new Date("2026-08-03T09:00:00.000Z"),
      statement: "Stored Premium timing preference",
    },
  }));
  assert.equal(result.decision, "RECALCULATE");
});

test("customer opt-out recommends STOP", () => {
  const result = recommendPremiumFollowUpDecision(validInput({ customerOptedOut: true }));
  assert.equal(result.decision, "STOP");
  assert.match(result.reason, /stop/i);
});

test("customer manager request recommends ESCALATE_TO_STAFF", () => {
  const result = recommendPremiumFollowUpDecision(validInput({ customerRequestedHuman: true }));
  assert.equal(result.decision, "ESCALATE_TO_STAFF");
  assert.match(result.reason, /human|manager/i);
});

test("due valid unresolved job recommends SEND_NOW", () => {
  const result = recommendPremiumFollowUpDecision(validInput());
  assert.equal(result.decision, "SEND_NOW");
  assert.equal(result.proposedFollowUpAt, null);
});

test("temporary WhatsApp disconnection preserves the business recommendation", () => {
  const result = recommendPremiumFollowUpDecision(validInput({ whatsAppConnected: false }));
  assert.equal(result.decision, "SEND_NOW");
  assert.equal(result.proposedFollowUpAt, null);
});

test("only provider-accepted logs advance the Premium sequence", () => {
  assert.deepEqual(
    [...FOLLOW_UP_SUCCESSFUL_ATTEMPT_DELIVERY_STATUSES],
    [FollowUpSendLogDeliveryStatus.SENT],
  );
  assert.equal(
    (FOLLOW_UP_SUCCESSFUL_ATTEMPT_DELIVERY_STATUSES as readonly FollowUpSendLogDeliveryStatus[])
      .includes(FollowUpSendLogDeliveryStatus.QUEUED),
    false,
  );
});

test("prompt resolution failure uses defaults without any prompt version", () => {
  const fallback = safePremiumPromptDefaults();
  assert.equal(fallback.source, "DEFAULTS");
  assert.equal(fallback.maximumAttempts, 3);
  assert.deepEqual(fallback.versions, { global: null, followUp: null });
  assert.equal(fallback.lastChangedAt, null);
});

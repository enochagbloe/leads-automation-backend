import assert from "node:assert/strict";
import test from "node:test";
import { PremiumFollowUpSequenceStage } from "@prisma/client";
import {
  premiumContinuationRequired,
  premiumContinuationRetryAt,
} from "../src/services/follow-up/follow-up-premium-continuation-policy";

test("accepted non-final Premium sends require a durable continuation", () => {
  assert.equal(premiumContinuationRequired({
    providerAccepted: true,
    sequenceStage: PremiumFollowUpSequenceStage.INITIAL_CHECK_IN,
    executionAction: "SEND",
  }), true);
  assert.equal(premiumContinuationRequired({
    providerAccepted: true,
    sequenceStage: PremiumFollowUpSequenceStage.HELPFUL_CLARIFICATION,
    executionAction: "SEND",
  }), true);
});

test("failed, escalated, and final-stage deliveries never schedule another stage", () => {
  assert.equal(premiumContinuationRequired({
    providerAccepted: false,
    sequenceStage: PremiumFollowUpSequenceStage.INITIAL_CHECK_IN,
    executionAction: "SEND",
  }), false);
  assert.equal(premiumContinuationRequired({
    providerAccepted: true,
    sequenceStage: PremiumFollowUpSequenceStage.INITIAL_CHECK_IN,
    executionAction: "ESCALATE",
  }), false);
  assert.equal(premiumContinuationRequired({
    providerAccepted: true,
    sequenceStage: PremiumFollowUpSequenceStage.FINAL_POLITE_FOLLOW_UP,
    executionAction: "SEND",
  }), false);
});

test("continuation retry delay is bounded", () => {
  const now = new Date("2026-07-29T12:00:00.000Z");
  assert.equal(
    premiumContinuationRetryAt(1, now).toISOString(),
    "2026-07-29T12:00:30.000Z",
  );
  assert.equal(
    premiumContinuationRetryAt(99, now).toISOString(),
    "2026-07-29T12:15:00.000Z",
  );
});

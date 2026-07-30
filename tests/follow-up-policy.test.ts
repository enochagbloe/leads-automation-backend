import assert from "node:assert/strict";
import test from "node:test";
import { FollowUpRuleType, PlanCode } from "@prisma/client";
import { maxAttemptsForRule } from "../src/services/follow-up/follow-up-policy.service";

test("no-response attempt limits follow the subscription tier", () => {
  assert.equal(
    maxAttemptsForRule(PlanCode.BASIC, FollowUpRuleType.NO_RESPONSE_AFTER_MESSAGE),
    1,
  );
  assert.equal(
    maxAttemptsForRule(PlanCode.PLUS, FollowUpRuleType.NO_RESPONSE_AFTER_MESSAGE),
    2,
  );
  assert.equal(
    maxAttemptsForRule(PlanCode.PREMIUM, FollowUpRuleType.NO_RESPONSE_AFTER_MESSAGE),
    3,
  );
});

test("all follow-up workflows remain bounded by the plan attempt limit", () => {
  for (const type of [
    FollowUpRuleType.CONTACT_EMAIL_REQUEST,
    FollowUpRuleType.BEFORE_APPOINTMENT,
    FollowUpRuleType.AFTER_APPOINTMENT,
    FollowUpRuleType.STALE_LEAD,
  ]) {
    assert.equal(maxAttemptsForRule(PlanCode.BASIC, type), 1);
    assert.equal(maxAttemptsForRule(PlanCode.PLUS, type), 2);
    assert.equal(maxAttemptsForRule(PlanCode.PREMIUM, type), 3);
  }
});

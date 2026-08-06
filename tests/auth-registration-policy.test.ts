import assert from "node:assert/strict";
import test from "node:test";
import { initialTrialWindow } from "../src/services/auth.service";

test("first-time registration receives one exact 14-day trial period", () => {
  const now = new Date("2026-08-06T12:00:00.000Z");
  const trial = initialTrialWindow(now);

  assert.equal(trial.startsAt.toISOString(), now.toISOString());
  assert.equal(trial.currentPeriodStart.toISOString(), now.toISOString());
  assert.equal(trial.trialEndsAt.toISOString(), "2026-08-20T12:00:00.000Z");
  assert.equal(trial.currentPeriodEnd.toISOString(), trial.trialEndsAt.toISOString());
  assert.equal(trial.trialEndsAt.getTime() - trial.startsAt.getTime(), 14 * 86_400_000);
});

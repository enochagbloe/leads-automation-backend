import { PremiumFollowUpSequenceStage } from "@prisma/client";

export const PREMIUM_CONTINUATION_STATUS = {
  NOT_REQUIRED: "NOT_REQUIRED",
  PENDING: "PENDING",
  PROCESSING: "PROCESSING",
  SCHEDULED: "SCHEDULED",
  STOPPED: "STOPPED",
  FAILED: "FAILED",
} as const;

export type PremiumContinuationStatus =
  typeof PREMIUM_CONTINUATION_STATUS[keyof typeof PREMIUM_CONTINUATION_STATUS];

export function premiumContinuationRequired(input: {
  providerAccepted: boolean;
  sequenceStage: PremiumFollowUpSequenceStage;
  executionAction: string;
}) {
  return input.providerAccepted
    && input.executionAction !== "ESCALATE"
    && input.sequenceStage !== PremiumFollowUpSequenceStage.FINAL_POLITE_FOLLOW_UP;
}

export function premiumContinuationRetryAt(attemptCount: number, now = new Date()) {
  const exponent = Math.max(0, Math.min(attemptCount - 1, 5));
  return new Date(now.getTime() + Math.min(30_000 * 2 ** exponent, 15 * 60_000));
}

import {
  FollowUpContextType,
  FollowUpJobStatus,
  PremiumFollowUpExecutionStatus,
} from "@prisma/client";
import { prisma } from "../../config/prisma";
import { followUpPremiumIntelligenceService } from "./follow-up-premium-intelligence.service";
import {
  PREMIUM_CONTINUATION_STATUS,
  premiumContinuationRetryAt,
} from "./follow-up-premium-continuation-policy";

const CLAIM_STALE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;

function failureReason(error: unknown) {
  return error instanceof Error
    ? error.message.slice(0, 500)
    : "PREMIUM_CONTINUATION_SCHEDULING_FAILED";
}

async function claimExecution(executionId: string, now: Date) {
  const staleBefore = new Date(now.getTime() - CLAIM_STALE_MS);
  const execution = await prisma.premiumFollowUpExecution.findFirst({
    where: {
      id: executionId,
      executionStatus: PremiumFollowUpExecutionStatus.SENT,
      continuationAttemptCount: { lt: MAX_ATTEMPTS },
      OR: [
        {
          continuationStatus: {
            in: [PREMIUM_CONTINUATION_STATUS.PENDING, PREMIUM_CONTINUATION_STATUS.FAILED],
          },
          OR: [
            { continuationNextAttemptAt: null },
            { continuationNextAttemptAt: { lte: now } },
          ],
        },
        {
          continuationStatus: PREMIUM_CONTINUATION_STATUS.PROCESSING,
          continuationProcessingStartedAt: { lt: staleBefore },
        },
      ],
    },
    select: {
      id: true,
      businessId: true,
      jobId: true,
      ruleId: true,
      leadId: true,
      conversationId: true,
      outboundMessageId: true,
      continuationStatus: true,
      continuationAttemptCount: true,
    },
  });
  if (!execution) return null;

  const claimed = await prisma.premiumFollowUpExecution.updateMany({
    where: {
      id: execution.id,
      executionStatus: PremiumFollowUpExecutionStatus.SENT,
      continuationStatus: execution.continuationStatus,
      continuationAttemptCount: execution.continuationAttemptCount,
    },
    data: {
      continuationStatus: PREMIUM_CONTINUATION_STATUS.PROCESSING,
      continuationAttemptCount: { increment: 1 },
      continuationProcessingStartedAt: now,
      continuationNextAttemptAt: null,
      continuationReason: null,
    },
  });
  return claimed.count === 1 ? execution : null;
}

async function settleScheduled(
  executionId: string,
  result: Awaited<ReturnType<typeof followUpPremiumIntelligenceService.scheduleNoResponseAfterOutboundMessage>>,
) {
  const resultJobId = "job" in result && result.job
    ? result.job.id
    : "jobId" in result && typeof result.jobId === "string"
      ? result.jobId
      : null;
  const duplicate = !result.scheduled && result.reason === "FOLLOW_UP_DUPLICATE_JOB";
  const status = result.scheduled || duplicate
    ? PREMIUM_CONTINUATION_STATUS.SCHEDULED
    : PREMIUM_CONTINUATION_STATUS.STOPPED;

  await prisma.premiumFollowUpExecution.updateMany({
    where: {
      id: executionId,
      continuationStatus: PREMIUM_CONTINUATION_STATUS.PROCESSING,
    },
    data: {
      continuationStatus: status,
      continuationJobId: resultJobId,
      continuationReason: result.scheduled
        ? "PREMIUM_NEXT_STAGE_SCHEDULED"
        : result.reason,
      continuationProcessingStartedAt: null,
      continuationCompletedAt: new Date(),
    },
  });
}

async function settleFailure(executionId: string, error: unknown) {
  const current = await prisma.premiumFollowUpExecution.findUnique({
    where: { id: executionId },
    select: { continuationAttemptCount: true },
  });
  if (!current) return;
  const exhausted = current.continuationAttemptCount >= MAX_ATTEMPTS;
  await prisma.premiumFollowUpExecution.updateMany({
    where: {
      id: executionId,
      continuationStatus: PREMIUM_CONTINUATION_STATUS.PROCESSING,
    },
    data: {
      continuationStatus: PREMIUM_CONTINUATION_STATUS.FAILED,
      continuationReason: exhausted
        ? "PREMIUM_CONTINUATION_ATTEMPTS_EXHAUSTED"
        : failureReason(error),
      continuationProcessingStartedAt: null,
      continuationNextAttemptAt: exhausted
        ? null
        : premiumContinuationRetryAt(current.continuationAttemptCount),
      continuationCompletedAt: exhausted ? new Date() : null,
    },
  });
}

async function settleExistingJob(executionId: string, jobId: string) {
  await prisma.premiumFollowUpExecution.updateMany({
    where: {
      id: executionId,
      continuationStatus: PREMIUM_CONTINUATION_STATUS.PROCESSING,
    },
    data: {
      continuationStatus: PREMIUM_CONTINUATION_STATUS.SCHEDULED,
      continuationJobId: jobId,
      continuationReason: "PREMIUM_NEXT_STAGE_ALREADY_SCHEDULED",
      continuationProcessingStartedAt: null,
      continuationNextAttemptAt: null,
      continuationCompletedAt: new Date(),
    },
  });
}

export const followUpPremiumContinuationService = {
  async processExecution(executionId: string) {
    const claimed = await claimExecution(executionId, new Date());
    if (!claimed) return { processed: false as const };
    if (
      !claimed.leadId
      || !claimed.conversationId
      || !claimed.outboundMessageId
    ) {
      await settleFailure(executionId, new Error("PREMIUM_CONTINUATION_CONTEXT_MISSING"));
      return { processed: true as const, scheduled: false as const };
    }

    try {
      const existingJob = await prisma.followUpJob.findFirst({
        where: {
          businessId: claimed.businessId,
          ruleId: claimed.ruleId,
          leadId: claimed.leadId,
          conversationId: claimed.conversationId,
          relatedMessageId: claimed.outboundMessageId,
          contextType: FollowUpContextType.GENERAL_NO_RESPONSE,
          status: {
            in: [
              FollowUpJobStatus.SCHEDULED,
              FollowUpJobStatus.PROCESSING,
              FollowUpJobStatus.SENT,
            ],
          },
        },
        select: { id: true },
      });
      if (existingJob) {
        await settleExistingJob(executionId, existingJob.id);
        return { processed: true as const, scheduled: true as const };
      }

      const message = await prisma.message.findFirst({
        where: {
          id: claimed.outboundMessageId,
          businessId: claimed.businessId,
          conversationId: claimed.conversationId,
          deletedAt: null,
        },
        select: { id: true, createdAt: true },
      });
      if (!message) throw new Error("PREMIUM_CONTINUATION_SOURCE_MESSAGE_MISSING");

      const result = await followUpPremiumIntelligenceService.scheduleNoResponseAfterOutboundMessage({
        businessId: claimed.businessId,
        leadId: claimed.leadId,
        conversationId: claimed.conversationId,
        messageId: message.id,
        messageCreatedAt: message.createdAt,
      });
      await settleScheduled(executionId, result);
      return { processed: true as const, scheduled: result.scheduled, result };
    } catch (error) {
      await settleFailure(executionId, error);
      return { processed: true as const, scheduled: false as const, error };
    }
  },

  async reconcilePending(businessId: string, limit = 25) {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - CLAIM_STALE_MS);
    const executions = await prisma.premiumFollowUpExecution.findMany({
      where: {
        businessId,
        executionStatus: PremiumFollowUpExecutionStatus.SENT,
        continuationAttemptCount: { lt: MAX_ATTEMPTS },
        OR: [
          {
            continuationStatus: {
              in: [PREMIUM_CONTINUATION_STATUS.PENDING, PREMIUM_CONTINUATION_STATUS.FAILED],
            },
            OR: [
              { continuationNextAttemptAt: null },
              { continuationNextAttemptAt: { lte: now } },
            ],
          },
          {
            continuationStatus: PREMIUM_CONTINUATION_STATUS.PROCESSING,
            continuationProcessingStartedAt: { lt: staleBefore },
          },
        ],
      },
      orderBy: [{ continuationNextAttemptAt: "asc" }, { updatedAt: "asc" }],
      select: { id: true },
      take: Math.max(1, Math.min(limit, 100)),
    });

    for (const execution of executions) {
      await this.processExecution(execution.id);
    }
    return executions.length;
  },
};

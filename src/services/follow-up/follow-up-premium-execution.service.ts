import crypto from "node:crypto";
import {
  AiPromptScope,
  AuditAction,
  BusinessStatus,
  ConversationStatus,
  CustomerIssueStatus,
  FollowUpJobStatus,
  FollowUpSendLogDeliveryStatus,
  HumanReviewType,
  MessageDirection,
  PlanCode,
  PremiumFollowUpExecutionStatus,
  PremiumFollowUpGenerationStatus,
  Prisma,
  SubscriptionStatus,
} from "@prisma/client";
import { prisma } from "../../config/prisma";
import { aiHumanReviewService } from "../ai-human-review.service";
import { auditService } from "../audit.service";
import { realtimeService } from "../realtime.service";
import { followUpPremiumDecisionContextService } from "./follow-up-premium-decision-context.service";
import {
  planPremiumFollowUpExecution,
  PremiumFollowUpExecutionPlan,
} from "./follow-up-premium-execution-policy";
import {
  followUpPremiumLifecycleValidatorService,
  PremiumFollowUpLifecycleValidationResult,
} from "./follow-up-premium-lifecycle-validator.service";
import { followUpPremiumMessageGeneratorService } from "./follow-up-premium-message-generator.service";
import { PremiumFollowUpGenerationResult } from "./follow-up-premium-message.types";
import { json, jsonObject } from "./follow-up.shared";

const ACTIVE_SUBSCRIPTIONS = [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING];
const ACTIVE_COMPLAINTS = [
  CustomerIssueStatus.OPEN,
  CustomerIssueStatus.ACKNOWLEDGED,
  CustomerIssueStatus.REOPENED,
];
const BLOCK_RETRY_MS = 5 * 60_000;
const EXECUTION_LEASE_STALE_MS = 10 * 60_000;
const RECALCULATION_RETRY_BASE_MS = 60_000;
const RECALCULATION_RETRY_MAX_MS = 15 * 60_000;
const RECOVERABLE_EXECUTION_STATUSES = new Set<PremiumFollowUpExecutionStatus>([
  PremiumFollowUpExecutionStatus.EXECUTING,
  PremiumFollowUpExecutionStatus.READY_TO_SEND,
  PremiumFollowUpExecutionStatus.ESCALATION_STARTED,
]);

export type PremiumFollowUpPreparedExecution = {
  premium: true;
  handled: boolean;
  executionId: string;
  executionIdempotencyKey: string;
  executionLeaseToken: string | null;
  plan: PremiumFollowUpExecutionPlan;
  validation: PremiumFollowUpLifecycleValidationResult;
  generation: PremiumFollowUpGenerationResult | null;
  messageText: string | null;
  job: Awaited<ReturnType<typeof loadJobRecord>>;
};

function hash(value: unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function datesEqual(left: Date | null | undefined, right: string | null | undefined) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.toISOString() === right;
}

function currentWhatsAppDestination(phone: string | null | undefined) {
  if (!phone) return null;
  const trimmed = phone.trim();
  const normalized = trimmed.replace(/[\s().-]/g, "");
  return /^\+?[1-9]\d{7,14}$/.test(normalized) ? trimmed : null;
}

function validationContextVersion(validation: PremiumFollowUpLifecycleValidationResult) {
  return hash({
    jobId: validation.followUpJobId,
    decision: validation.finalDecision,
    stage: validation.sequenceStage,
    entityVersions: validation.latestEntityVersions,
    prompts: validation.promptVersions,
    memory: validation.memoryVersion,
  });
}

export function premiumFollowUpExecutionIdentity(input: {
  businessId: string;
  jobId: string;
  sequenceStage: string;
  finalDecision: string;
  contextVersion: string;
  generationId: string | null;
}) {
  return hash({
    namespace: "premium-follow-up-execution",
    ...input,
  });
}

export function premiumFollowUpExecutionLeaseDisposition(input: {
  executionStatus: PremiumFollowUpExecutionStatus;
  processingStartedAt: Date;
  now?: Date;
}) {
  if (!RECOVERABLE_EXECUTION_STATUSES.has(input.executionStatus)) {
    return "TERMINAL" as const;
  }
  const now = input.now ?? new Date();
  return input.processingStartedAt.getTime() < now.getTime() - EXECUTION_LEASE_STALE_MS
    ? "TAKE_OVER" as const
    : "ALREADY_IN_PROGRESS" as const;
}

export function premiumFollowUpRecalculationRetryAt(
  recalculationCount: number,
  now = new Date(),
) {
  const safeCount = Math.max(1, Math.min(Math.trunc(recalculationCount), 10));
  const delayMs = Math.min(
    RECALCULATION_RETRY_BASE_MS * 2 ** (safeCount - 1),
    RECALCULATION_RETRY_MAX_MS,
  );
  return new Date(now.getTime() + delayMs);
}

type PremiumFollowUpDb = typeof prisma | Prisma.TransactionClient;

async function loadJobRecord(jobId: string, db: PremiumFollowUpDb = prisma) {
  return db.followUpJob.findUnique({
    where: { id: jobId },
    include: {
      rule: true,
      business: true,
      lead: true,
      conversation: true,
      appointment: true,
    },
  });
}

async function logExecution(input: {
  validation: PremiumFollowUpLifecycleValidationResult;
  executionId: string;
  executionIdempotencyKey: string;
  status: PremiumFollowUpExecutionStatus;
  reason: string;
  generation?: PremiumFollowUpGenerationResult | null;
}) {
  await auditService.log({
    action: input.status === PremiumFollowUpExecutionStatus.SCHEDULED
      ? AuditAction.FOLLOW_UP_JOB_RESCHEDULED
      : input.status === PremiumFollowUpExecutionStatus.FAILED
        ? AuditAction.FOLLOW_UP_JOB_FAILED
        : input.status === PremiumFollowUpExecutionStatus.STOPPED
          || input.status === PremiumFollowUpExecutionStatus.EXHAUSTED
          ? AuditAction.FOLLOW_UP_JOB_CANCELLED
          : AuditAction.FOLLOW_UP_CONTEXT_EVALUATED,
    businessId: input.validation.businessId,
    metadata: json({
      premiumRound: 4,
      executionId: input.executionId,
      executionIdempotencyKey: input.executionIdempotencyKey,
      followUpJobId: input.validation.followUpJobId,
      conversationId: input.validation.conversationId,
      customerId: input.validation.customerId,
      sequenceStage: input.validation.sequenceStage,
      finalDecision: input.validation.finalDecision,
      executionStatus: input.status,
      reason: input.reason,
      messageSource: input.generation?.messageSource ?? null,
      fallbackMessageUsed: input.generation?.fallbackMessageUsed ?? false,
      promptVersions: input.validation.promptVersions,
      memoryVersion: input.validation.memoryVersion,
      contextVersion: input.generation?.contextVersion ?? null,
    }),
  });
}

function publishExecution(
  validation: PremiumFollowUpLifecycleValidationResult,
  executionId: string,
  status: PremiumFollowUpExecutionStatus,
  reason: string,
) {
  realtimeService.publish({
    type: "business.follow_up.premium.execution.updated",
    businessId: validation.businessId!,
    conversationId: validation.conversationId ?? undefined,
    leadId: validation.customerId ?? undefined,
    payload: {
      executionId,
      followUpJobId: validation.followUpJobId,
      sequenceStage: validation.sequenceStage,
      finalDecision: validation.finalDecision,
      executionStatus: status,
      reason,
    },
    broadcastToStaff: true,
  });
}

async function claimExecution(input: {
  validation: PremiumFollowUpLifecycleValidationResult;
  generation: PremiumFollowUpGenerationResult | null;
  contextVersion: string;
  executionIdempotencyKey: string;
}) {
  const leaseToken = crypto.randomUUID();
  const claimedAt = new Date();
  try {
    const execution = await prisma.premiumFollowUpExecution.create({
      data: {
        businessId: input.validation.businessId!,
        jobId: input.validation.followUpJobId,
        ruleId: input.validation.followUpRuleId!,
        leadId: input.validation.customerId,
        conversationId: input.validation.conversationId,
        generationId: input.generation?.generationId,
        sequenceStage: input.validation.sequenceStage,
        finalDecision: input.validation.finalDecision,
        validationStatus: input.validation.validationStatus,
        executionStatus: PremiumFollowUpExecutionStatus.EXECUTING,
        processingLeaseToken: leaseToken,
        processingStartedAt: claimedAt,
        executionReason: input.validation.validationReason,
        executionBlocked: input.validation.executionBlocked,
        blockReason: input.validation.blockReason,
        messageSource: input.generation?.messageSource,
        fallbackMessageUsed: input.generation?.fallbackMessageUsed ?? false,
        contextVersion: input.contextVersion,
        promptVersions: json(input.validation.promptVersions),
        memoryVersion: input.validation.memoryVersion,
        validationSnapshot: json({
          validationReason: input.validation.validationReason,
          successfulAttemptCount: input.validation.successfulAttemptCount,
          effectiveAttemptLimit: input.validation.effectiveAttemptLimit,
          latestEntityVersions: input.validation.latestEntityVersions,
          hardRulesApplied: input.validation.hardRulesApplied,
        }),
        executionIdempotencyKey: input.executionIdempotencyKey,
      },
    });
    return {
      execution,
      claimed: true as const,
      leaseToken,
      resumedStatus: null,
    };
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
      throw error;
    }
    const existing = await prisma.premiumFollowUpExecution.findUnique({
      where: { executionIdempotencyKey: input.executionIdempotencyKey },
    });
    if (!existing) throw error;
    const leaseDisposition = premiumFollowUpExecutionLeaseDisposition({
      executionStatus: existing.executionStatus,
      processingStartedAt: existing.processingStartedAt,
      now: claimedAt,
    });
    if (leaseDisposition === "TAKE_OVER") {
      const takeover = await prisma.premiumFollowUpExecution.updateMany({
        where: {
          id: existing.id,
          executionStatus: existing.executionStatus,
          processingLeaseToken: existing.processingLeaseToken,
          processingStartedAt: existing.processingStartedAt,
        },
        data: {
          processingLeaseToken: leaseToken,
          processingStartedAt: claimedAt,
          executionReason: "STALE_EXECUTION_LEASE_RECOVERED",
        },
      });
      if (takeover.count === 1) {
        return {
          execution: {
            ...existing,
            processingLeaseToken: leaseToken,
            processingStartedAt: claimedAt,
          },
          claimed: true as const,
          leaseToken,
          resumedStatus: existing.executionStatus,
        };
      }
    }
    return {
      execution: existing,
      claimed: false as const,
      leaseToken: null,
      resumedStatus: null,
    };
  }
}

async function handleSchedule(input: {
  executionId: string;
  leaseToken: string;
  validation: PremiumFollowUpLifecycleValidationResult;
  scheduledFor: Date;
}) {
  return prisma.$transaction(async (tx) => {
    const execution = await tx.premiumFollowUpExecution.findFirst({
      where: {
        id: input.executionId,
        processingLeaseToken: input.leaseToken,
        executionStatus: PremiumFollowUpExecutionStatus.EXECUTING,
      },
      select: { id: true },
    });
    if (!execution) return null;
    const job = await tx.followUpJob.findFirst({
      where: {
        id: input.validation.followUpJobId,
        businessId: input.validation.businessId!,
        status: FollowUpJobStatus.PROCESSING,
      },
    });
    if (!job) return null;
    const updated = await tx.followUpJob.update({
      where: { id: job.id },
      data: {
        status: FollowUpJobStatus.SCHEDULED,
        scheduledFor: input.scheduledFor,
        processingStartedAt: null,
        metadata: json({
          ...jsonObject(job.metadata),
          premiumValidatedFollowUpAt: input.scheduledFor.toISOString(),
          premiumCustomerTiming: input.validation.customerTiming,
          premiumScheduleAdjusted: input.validation.adjustedSchedule,
          premiumPromptVersions: input.validation.promptVersions,
          premiumMemoryVersion: input.validation.memoryVersion,
          premiumSequenceStage: input.validation.sequenceStage,
          premiumReevaluateBeforeSend: true,
        }),
      },
    });
    await tx.premiumFollowUpExecution.updateMany({
      where: {
        id: input.executionId,
        processingLeaseToken: input.leaseToken,
        executionStatus: PremiumFollowUpExecutionStatus.EXECUTING,
      },
      data: {
        executionStatus: PremiumFollowUpExecutionStatus.SCHEDULED,
        scheduledFor: input.scheduledFor,
        executedAt: new Date(),
        completedAt: new Date(),
      },
    });
    return updated;
  });
}

async function handleStop(input: {
  executionId: string;
  leaseToken: string;
  validation: PremiumFollowUpLifecycleValidationResult;
  reason: string;
  allowedExecutionStatuses?: PremiumFollowUpExecutionStatus[];
}) {
  return prisma.$transaction(async (tx) => {
    const allowedExecutionStatuses = input.allowedExecutionStatuses
      ?? [PremiumFollowUpExecutionStatus.EXECUTING];
    const execution = await tx.premiumFollowUpExecution.findFirst({
      where: {
        id: input.executionId,
        processingLeaseToken: input.leaseToken,
        executionStatus: { in: allowedExecutionStatuses },
      },
      select: { id: true },
    });
    if (!execution) return false;
    const current = await tx.followUpJob.updateMany({
      where: {
        id: input.validation.followUpJobId,
        businessId: input.validation.businessId!,
        status: { in: [FollowUpJobStatus.PROCESSING, FollowUpJobStatus.SCHEDULED] },
      },
      data: {
        status: FollowUpJobStatus.CANCELLED,
        cancelReason: input.reason,
        processingStartedAt: null,
      },
    });
    if (input.validation.cancelSequenceRequired && input.validation.conversationId) {
      await tx.followUpJob.updateMany({
        where: {
          id: { not: input.validation.followUpJobId },
          businessId: input.validation.businessId!,
          conversationId: input.validation.conversationId,
          ruleId: input.validation.followUpRuleId!,
          status: FollowUpJobStatus.SCHEDULED,
        },
        data: {
          status: FollowUpJobStatus.CANCELLED,
          cancelReason: input.reason,
        },
      });
    }
    const exhausted = input.reason === "MAXIMUM_ATTEMPTS_REACHED";
    await tx.premiumFollowUpExecution.updateMany({
      where: {
        id: input.executionId,
        processingLeaseToken: input.leaseToken,
        executionStatus: { in: allowedExecutionStatuses },
      },
      data: {
        executionStatus: exhausted
          ? PremiumFollowUpExecutionStatus.EXHAUSTED
          : PremiumFollowUpExecutionStatus.STOPPED,
        executionReason: input.reason,
        executedAt: new Date(),
        completedAt: new Date(),
      },
    });
    return current.count > 0;
  });
}

async function handleRecalculation(input: {
  executionId: string;
  leaseToken: string;
  validation: PremiumFollowUpLifecycleValidationResult;
  reason: string;
}) {
  return prisma.$transaction(async (tx) => {
    const recalculationRequestedAt = new Date();
    const execution = await tx.premiumFollowUpExecution.findFirst({
      where: {
        id: input.executionId,
        processingLeaseToken: input.leaseToken,
        executionStatus: PremiumFollowUpExecutionStatus.EXECUTING,
      },
      select: { id: true },
    });
    if (!execution) return false;
    const job = await tx.followUpJob.findFirst({
      where: {
        id: input.validation.followUpJobId,
        businessId: input.validation.businessId!,
        status: { in: [FollowUpJobStatus.PROCESSING, FollowUpJobStatus.SCHEDULED] },
      },
    });
    if (!job) return false;
    const metadata = jsonObject(job.metadata);
    const recalculationCount = Number(metadata.premiumRecalculationCount ?? 0) + 1;
    const retryAt = premiumFollowUpRecalculationRetryAt(
      recalculationCount,
      recalculationRequestedAt,
    );
    await tx.followUpJob.update({
      where: { id: job.id },
      data: {
        status: FollowUpJobStatus.SCHEDULED,
        scheduledFor: retryAt,
        cancelReason: null,
        failureReason: null,
        processingStartedAt: null,
        metadata: json({
          ...metadata,
          premiumRecalculationCount: recalculationCount,
          premiumRecalculationReason: input.reason,
          premiumRecalculationRequestedAt: recalculationRequestedAt.toISOString(),
          premiumRecalculationBaselineAt: recalculationRequestedAt.toISOString(),
          premiumRecalculationExecutionId: input.executionId,
          premiumRecalculationRetryAt: retryAt.toISOString(),
        }),
      },
    });
    await tx.premiumFollowUpExecution.updateMany({
      where: {
        id: input.executionId,
        processingLeaseToken: input.leaseToken,
        executionStatus: PremiumFollowUpExecutionStatus.EXECUTING,
      },
      data: {
        executionStatus: PremiumFollowUpExecutionStatus.RECALCULATION_REQUIRED,
        executionReason: input.reason,
        recalculationCount,
        scheduledFor: retryAt,
        executedAt: recalculationRequestedAt,
        completedAt: recalculationRequestedAt,
      },
    });
    return true;
  });
}

function reviewType(reason: string) {
  if (/complaint/i.test(reason)) return HumanReviewType.COMPLAINT;
  if (/manager|human|staff/i.test(reason)) return HumanReviewType.CUSTOMER_REQUESTED_HUMAN;
  if (/price|pricing|discount|exception/i.test(reason)) return HumanReviewType.PAYMENT_OR_REFUND;
  return HumanReviewType.OTHER;
}

export const followUpPremiumExecutionService = {
  async prepare(jobId: string): Promise<PremiumFollowUpPreparedExecution | null> {
    const decision = await followUpPremiumDecisionContextService.evaluate(jobId);
    if (!decision.businessId || !decision.followUpRuleId) return null;
    const validation = await followUpPremiumLifecycleValidatorService.validate(decision);
    const needsGeneration = ["SEND_NOW", "ESCALATE_TO_STAFF"].includes(validation.finalDecision);
    const generation = needsGeneration
      ? await followUpPremiumMessageGeneratorService.generate(validation)
      : null;
    const plan = planPremiumFollowUpExecution({ validation, generation });
    const contextVersion = generation?.contextVersion ?? validationContextVersion(validation);
    const executionIdempotencyKey = premiumFollowUpExecutionIdentity({
      businessId: decision.businessId,
      jobId,
      sequenceStage: validation.sequenceStage,
      finalDecision: validation.finalDecision,
      contextVersion,
      generationId: generation?.generationId ?? null,
    });
    const claim = await claimExecution({
      validation,
      generation,
      contextVersion,
      executionIdempotencyKey,
    });
    const preparedResult = async (
      handled: boolean,
      messageText: string | null,
      executionLeaseToken: string | null,
    ): Promise<PremiumFollowUpPreparedExecution> => ({
        premium: true,
        handled,
        executionId: claim.execution.id,
        executionIdempotencyKey,
        executionLeaseToken,
        plan,
        validation,
        generation,
        messageText,
        job: await loadJobRecord(jobId),
      });
    if (!claim.claimed || !claim.leaseToken) {
      return preparedResult(true, null, null);
    }
    if (claim.resumedStatus === PremiumFollowUpExecutionStatus.READY_TO_SEND) {
      return preparedResult(false, generation?.generatedMessage ?? null, claim.leaseToken);
    }

    let handled = true;
    let status: PremiumFollowUpExecutionStatus = PremiumFollowUpExecutionStatus.EXECUTING;
    if (plan.action === "SCHEDULE" && plan.scheduledFor) {
      const scheduled = await handleSchedule({
        executionId: claim.execution.id,
        leaseToken: claim.leaseToken,
        validation,
        scheduledFor: plan.scheduledFor,
      });
      if (!scheduled) return preparedResult(true, null, null);
      status = PremiumFollowUpExecutionStatus.SCHEDULED;
    } else if (plan.action === "STOP") {
      const stopped = await handleStop({
        executionId: claim.execution.id,
        leaseToken: claim.leaseToken,
        validation,
        reason: plan.reason,
      });
      if (!stopped) return preparedResult(true, null, null);
      status = plan.reason === "MAXIMUM_ATTEMPTS_REACHED"
        ? PremiumFollowUpExecutionStatus.EXHAUSTED
        : PremiumFollowUpExecutionStatus.STOPPED;
    } else if (plan.action === "RECALCULATE") {
      const recalculated = await handleRecalculation({
        executionId: claim.execution.id,
        leaseToken: claim.leaseToken,
        validation,
        reason: plan.reason,
      });
      if (!recalculated) return preparedResult(true, null, null);
      status = PremiumFollowUpExecutionStatus.RECALCULATION_REQUIRED;
    } else if (plan.action === "BLOCK") {
      const retryAt = new Date(Date.now() + BLOCK_RETRY_MS);
      const blocked = await prisma.$transaction(async (tx) => {
        const execution = await tx.premiumFollowUpExecution.updateMany({
          where: {
            id: claim.execution.id,
            processingLeaseToken: claim.leaseToken,
            executionStatus: PremiumFollowUpExecutionStatus.EXECUTING,
          },
          data: {
            executionStatus: PremiumFollowUpExecutionStatus.BLOCKED,
            executionBlocked: true,
            blockReason: plan.reason,
            scheduledFor: retryAt,
            completedAt: new Date(),
          },
        });
        if (execution.count !== 1) return false;
        await tx.followUpJob.updateMany({
          where: {
            id: jobId,
            businessId: decision.businessId!,
            status: FollowUpJobStatus.PROCESSING,
          },
          data: {
            status: FollowUpJobStatus.SCHEDULED,
            scheduledFor: retryAt,
            processingStartedAt: null,
            failureReason: plan.reason,
          },
        });
        return true;
      });
      if (!blocked) return preparedResult(true, null, null);
      status = PremiumFollowUpExecutionStatus.BLOCKED;
    } else if (plan.action === "ESCALATE") {
      const escalationClaim = await prisma.premiumFollowUpExecution.updateMany({
        where: {
          id: claim.execution.id,
          processingLeaseToken: claim.leaseToken,
          executionStatus: {
            in: [
              PremiumFollowUpExecutionStatus.EXECUTING,
              PremiumFollowUpExecutionStatus.ESCALATION_STARTED,
            ],
          },
        },
        data: {
          executionStatus: PremiumFollowUpExecutionStatus.ESCALATION_STARTED,
          processingStartedAt: new Date(),
        },
      });
      if (escalationClaim.count !== 1) return preparedResult(true, null, null);
      const currentJob = await loadJobRecord(jobId);
      if (
        claim.execution.executionStatus !== PremiumFollowUpExecutionStatus.ESCALATION_STARTED
        || !currentJob?.conversation?.needsHumanReview
      ) {
        try {
          await aiHumanReviewService.requestHumanReview({
            businessId: decision.businessId,
            businessAccountId: currentJob?.business.businessAccountId ?? null,
            conversationId: decision.conversationId!,
            reviewType: reviewType(plan.reason),
            reason: plan.reason,
            source: "PREMIUM_FOLLOW_UP_ROUND_4",
            metadata: {
              executionId: claim.execution.id,
              followUpJobId: jobId,
              sequenceStage: validation.sequenceStage,
            },
          });
        } catch (error) {
          const reviewApplied = await prisma.conversation.findFirst({
            where: {
              id: decision.conversationId!,
              businessId: decision.businessId,
              needsHumanReview: true,
            },
            select: { id: true },
          });
          if (!reviewApplied) throw error;
        }
      }
      if (plan.requiresMessage && generation?.generatedMessage) {
        handled = false;
        status = PremiumFollowUpExecutionStatus.READY_TO_SEND;
        const ready = await prisma.premiumFollowUpExecution.updateMany({
          where: {
            id: claim.execution.id,
            processingLeaseToken: claim.leaseToken,
            executionStatus: PremiumFollowUpExecutionStatus.ESCALATION_STARTED,
          },
          data: {
            executionStatus: status,
            executedAt: new Date(),
          },
        });
        if (ready.count !== 1) return preparedResult(true, null, null);
      } else {
        const stopped = await handleStop({
          executionId: claim.execution.id,
          leaseToken: claim.leaseToken,
          validation: { ...validation, cancelSequenceRequired: true },
          reason: `ESCALATED:${plan.reason}`,
          allowedExecutionStatuses: [PremiumFollowUpExecutionStatus.ESCALATION_STARTED],
        });
        if (!stopped) return preparedResult(true, null, null);
        status = PremiumFollowUpExecutionStatus.ESCALATED;
        const escalated = await prisma.premiumFollowUpExecution.updateMany({
          where: {
            id: claim.execution.id,
            processingLeaseToken: claim.leaseToken,
            executionStatus: PremiumFollowUpExecutionStatus.STOPPED,
          },
          data: {
            executionStatus: status,
            executionReason: plan.reason,
            executedAt: new Date(),
            completedAt: new Date(),
          },
        });
        if (escalated.count !== 1) return preparedResult(true, null, null);
      }
    } else if (plan.action === "SEND" && generation?.generatedMessage) {
      handled = false;
      status = PremiumFollowUpExecutionStatus.READY_TO_SEND;
      const ready = await prisma.premiumFollowUpExecution.updateMany({
        where: {
          id: claim.execution.id,
          processingLeaseToken: claim.leaseToken,
          executionStatus: PremiumFollowUpExecutionStatus.EXECUTING,
        },
        data: {
          executionStatus: status,
          executedAt: new Date(),
        },
      });
      if (ready.count !== 1) return preparedResult(true, null, null);
    } else {
      const stopped = await handleStop({
        executionId: claim.execution.id,
        leaseToken: claim.leaseToken,
        validation,
        reason: "PREMIUM_EXECUTION_NOT_SAFE",
      });
      if (!stopped) return preparedResult(true, null, null);
      status = PremiumFollowUpExecutionStatus.STOPPED;
    }

    await logExecution({
      validation,
      executionId: claim.execution.id,
      executionIdempotencyKey,
      status,
      reason: plan.reason,
      generation,
    }).catch(() => undefined);
    try {
      publishExecution(validation, claim.execution.id, status, plan.reason);
    } catch {
      // Execution state is authoritative; realtime delivery is best-effort.
    }
    return {
      premium: true,
      handled,
      executionId: claim.execution.id,
      executionIdempotencyKey,
      executionLeaseToken: claim.leaseToken,
      plan,
      validation,
      generation,
      messageText: handled ? null : generation?.generatedMessage ?? null,
      job: await loadJobRecord(jobId),
    };
  },

  async finalDeliveryCheck(
    input: PremiumFollowUpPreparedExecution,
    db: PremiumFollowUpDb = prisma,
    options: { claimDelivery?: boolean } = {},
  ) {
    if (!input.executionLeaseToken) {
      return { allowed: false as const, reason: "PREMIUM_EXECUTION_LEASE_LOST" };
    }
    const validation = input.validation;
    if (options.claimDelivery && validation.businessId && validation.customerId) {
      await db.$queryRaw`
        SELECT "id"
        FROM "Lead"
        WHERE "id" = ${validation.customerId}
          AND "businessId" = ${validation.businessId}
        FOR UPDATE
      `;
    }
    const [
      job,
      latestCustomerMessage,
      latestStaff,
      complaint,
      subscription,
      successfulAttempts,
      execution,
      appointment,
      memoryProfile,
      promptConfigurations,
    ] =
      await Promise.all([
        loadJobRecord(validation.followUpJobId, db),
        db.message.findFirst({
          where: {
            businessId: validation.businessId!,
            conversationId: validation.conversationId!,
            senderType: "CUSTOMER",
            direction: MessageDirection.INBOUND,
            deletedAt: null,
          },
          orderBy: { createdAt: "desc" },
          select: { content: true, createdAt: true },
        }),
        db.message.findFirst({
          where: {
            businessId: validation.businessId!,
            conversationId: validation.conversationId!,
            senderType: "STAFF",
            direction: MessageDirection.OUTBOUND,
            deletedAt: null,
          },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        }),
        db.customerIssueLog.findFirst({
          where: {
            businessId: validation.businessId!,
            status: { in: ACTIVE_COMPLAINTS },
            OR: [
              { conversationId: validation.conversationId },
              { leadId: validation.customerId },
            ],
          },
          orderBy: { updatedAt: "desc" },
          select: { id: true, updatedAt: true },
        }),
        db.subscription.findFirst({
          where: {
            businessAccountId: input.job?.business.businessAccountId,
            status: { in: ACTIVE_SUBSCRIPTIONS },
            currentPeriodStart: { lte: new Date() },
            currentPeriodEnd: { gt: new Date() },
          },
          include: { plan: true },
          orderBy: { createdAt: "desc" },
        }),
        db.followUpSendLog.count({
          where: {
            businessId: validation.businessId!,
            ruleId: validation.followUpRuleId!,
            conversationId: validation.conversationId,
            deliveryStatus: FollowUpSendLogDeliveryStatus.SENT,
          },
        }),
        db.premiumFollowUpExecution.findFirst({
          where: {
            id: input.executionId,
            businessId: validation.businessId!,
            jobId: validation.followUpJobId,
            processingLeaseToken: input.executionLeaseToken,
          },
        }),
        validation.appointmentId
          ? db.appointment.findFirst({
            where: {
              id: validation.appointmentId,
              businessId: validation.businessId!,
              leadId: validation.customerId!,
            },
            select: { id: true, updatedAt: true },
          })
          : Promise.resolve(null),
        validation.customerId
          ? db.customerMemoryProfile.findUnique({
            where: {
              businessId_leadId: {
                businessId: validation.businessId!,
                leadId: validation.customerId,
              },
            },
            select: { memoryEnabled: true, memoryRevision: true },
          })
          : Promise.resolve(null),
        db.aiPromptConfiguration.findMany({
          where: {
            businessId: validation.businessId!,
            scope: { in: [AiPromptScope.GLOBAL, AiPromptScope.FOLLOW_UP] },
            archivedAt: null,
          },
          select: {
            scope: true,
            activeVersion: {
              select: { id: true },
            },
          },
        }),
      ]);
    const currentGlobalPromptId = promptConfigurations
      .find((configuration) => configuration.scope === AiPromptScope.GLOBAL)
      ?.activeVersion?.id ?? null;
    const currentFollowUpPromptId = promptConfigurations
      .find((configuration) => configuration.scope === AiPromptScope.FOLLOW_UP)
      ?.activeVersion?.id ?? null;

    if (
      !job
      || !job.lead
      || !job.conversation
      || job.businessId !== validation.businessId
      || job.ruleId !== validation.followUpRuleId
      || job.leadId !== validation.customerId
      || job.conversationId !== validation.conversationId
      || job.rule.businessId !== validation.businessId
      || job.lead.businessId !== validation.businessId
      || job.conversation.businessId !== validation.businessId
    ) return { allowed: false as const, reason: "BUSINESS_SCOPE_MISMATCH" };
    const destinationPhone = currentWhatsAppDestination(job.lead.phone);
    if (!destinationPhone) {
      return { allowed: false as const, reason: "CUSTOMER_CONTACT_UNAVAILABLE" };
    }
    if (!execution || execution.executionStatus !== PremiumFollowUpExecutionStatus.READY_TO_SEND) {
      return { allowed: false as const, reason: "PREMIUM_EXECUTION_LEASE_LOST" };
    }
    if (job.status !== FollowUpJobStatus.PROCESSING) {
      return { allowed: false as const, reason: "FOLLOW_UP_JOB_NOT_ELIGIBLE" };
    }
    if (
      job.business.status !== BusinessStatus.ACTIVE
      || job.business.deletedAt
      || job.lead.deletedAt
      || job.conversation.deletedAt
    ) return { allowed: false as const, reason: "CORE_ENTITY_NOT_ELIGIBLE" };
    if (!job.business.followUpAutomationEnabled || !job.rule.enabled || job.rule.deletedAt) {
      return { allowed: false as const, reason: "FOLLOW_UP_RULE_DISABLED" };
    }
    if (
      !datesEqual(job.updatedAt, validation.latestEntityVersions.jobUpdatedAt)
      || !datesEqual(job.rule.updatedAt, validation.latestEntityVersions.ruleUpdatedAt)
      || !datesEqual(job.lead.updatedAt, validation.latestEntityVersions.leadUpdatedAt)
    ) return { allowed: false as const, reason: "CORE_ENTITY_CHANGED_AFTER_VALIDATION" };
    if (!subscription || subscription.plan.code !== PlanCode.PREMIUM) {
      return { allowed: false as const, reason: "PREMIUM_CAPABILITY_UNAVAILABLE" };
    }
    if (
      job.conversation.humanTakeover
      || (
        job.conversation.needsHumanReview
        && input.plan.action !== "ESCALATE"
      )
      || job.conversation.status === ConversationStatus.CLOSED
      || job.conversation.status === ConversationStatus.PLAN_LIMIT_BLOCKED
    ) return { allowed: false as const, reason: "HUMAN_OR_CONVERSATION_STOP" };
    const currentAssignedStaffId = job.conversation.assignedStaffId
      ?? job.lead.assignedStaffId
      ?? job.appointment?.assignedStaffId
      ?? null;
    if (currentAssignedStaffId !== validation.assignedStaffId) {
      return { allowed: false as const, reason: "STAFF_ASSIGNMENT_CHANGED" };
    }
    if (job.lead.whatsAppOptedOut) {
      return { allowed: false as const, reason: "CUSTOMER_OPTED_OUT" };
    }
    if (
      !datesEqual(latestCustomerMessage?.createdAt, validation.latestEntityVersions.lastCustomerActivityAt)
      || !datesEqual(latestStaff?.createdAt, validation.latestEntityVersions.lastStaffActivityAt)
    ) return { allowed: false as const, reason: "ACTIVITY_CHANGED_AFTER_VALIDATION" };
    if (
      complaint?.id !== validation.complaintId
      || !datesEqual(complaint?.updatedAt, validation.latestEntityVersions.complaintUpdatedAt)
    ) return { allowed: false as const, reason: "COMPLAINT_STATUS_CHANGED" };
    if (complaint && input.plan.action !== "ESCALATE") {
      return { allowed: false as const, reason: "ACTIVE_COMPLAINT" };
    }
    if (
      String(memoryProfile?.memoryRevision ?? "") !== (validation.memoryVersion ?? "")
      || memoryProfile?.memoryEnabled === false
    ) return { allowed: false as const, reason: "CUSTOMER_MEMORY_CHANGED" };
    if (
      currentGlobalPromptId !== validation.promptVersions.global?.versionId
      || currentFollowUpPromptId !== validation.promptVersions.followUp?.versionId
    ) return { allowed: false as const, reason: "PROMPT_VERSION_CHANGED" };
    if (successfulAttempts >= Math.min(3, validation.effectiveAttemptLimit)) {
      return { allowed: false as const, reason: "MAXIMUM_ATTEMPTS_REACHED" };
    }
    if (
      validation.appointmentId
      && (
        !appointment
        || !datesEqual(appointment.updatedAt, validation.latestEntityVersions.appointmentUpdatedAt)
      )
    ) return { allowed: false as const, reason: "APPOINTMENT_CHANGED" };
    const renewed = await db.premiumFollowUpExecution.updateMany({
      where: {
        id: input.executionId,
        businessId: validation.businessId!,
        jobId: validation.followUpJobId,
        executionStatus: PremiumFollowUpExecutionStatus.READY_TO_SEND,
        processingLeaseToken: input.executionLeaseToken,
      },
      data: {
        processingStartedAt: new Date(),
        ...(options.claimDelivery
          ? { executionStatus: PremiumFollowUpExecutionStatus.DELIVERY_STARTED }
          : {}),
      },
    });
    if (renewed.count !== 1) {
      return { allowed: false as const, reason: "PREMIUM_EXECUTION_LEASE_LOST" };
    }
    return {
      allowed: true as const,
      reason: null,
      destinationPhone,
      deliveryClaimed: options.claimDelivery === true,
    };
  },

  async blockBeforeDelivery(input: PremiumFollowUpPreparedExecution, reason: string) {
    if (!input.executionLeaseToken) return false;
    const retryableDisconnect = reason === "WHATSAPP_DISCONNECTED";
    const retryAt = retryableDisconnect ? new Date(Date.now() + BLOCK_RETRY_MS) : null;
    const changed = await prisma.$transaction(async (tx) => {
      const execution = await tx.premiumFollowUpExecution.updateMany({
        where: {
          id: input.executionId,
          businessId: input.validation.businessId!,
          executionStatus: PremiumFollowUpExecutionStatus.READY_TO_SEND,
          processingLeaseToken: input.executionLeaseToken,
        },
        data: {
          executionStatus: PremiumFollowUpExecutionStatus.BLOCKED,
          executionBlocked: true,
          blockReason: reason,
          scheduledFor: retryAt,
          completedAt: new Date(),
        },
      });
      if (execution.count !== 1) return false;
      await tx.followUpJob.updateMany({
        where: {
          id: input.validation.followUpJobId,
          businessId: input.validation.businessId!,
          status: FollowUpJobStatus.PROCESSING,
        },
        data: {
          status: retryableDisconnect
            ? FollowUpJobStatus.SCHEDULED
            : FollowUpJobStatus.CANCELLED,
          ...(retryableDisconnect
            ? { scheduledFor: retryAt!, failureReason: reason }
            : { cancelReason: reason }),
          processingStartedAt: null,
        },
      });
      return true;
    });
    if (!changed) return false;
    await logExecution({
      validation: input.validation,
      executionId: input.executionId,
      executionIdempotencyKey: input.executionIdempotencyKey,
      status: PremiumFollowUpExecutionStatus.BLOCKED,
      reason,
      generation: input.generation,
    }).catch(() => undefined);
    try {
      publishExecution(
        input.validation,
        input.executionId,
        PremiumFollowUpExecutionStatus.BLOCKED,
        reason,
      );
    } catch {
      // Execution state is authoritative; realtime delivery is best-effort.
    }
    return true;
  },
};

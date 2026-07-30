import {
  BusinessStatus,
  ConversationChannel,
  ConversationStatus,
  FollowUpJobStatus,
  FollowUpRuleType,
  LeadStatus,
  MessageDeliveryStatus,
  MessageDirection,
  MessageSenderType,
} from "@prisma/client";
import { env } from "../../config/env";
import { prisma } from "../../config/prisma";
import { isDatabaseUnavailableError } from "../../utils/database-error";
import { aiUsageService } from "../ai-usage.service";
import { followUpPlusService } from "./follow-up-plus.service";
import { followUpJobProcessorService } from "./follow-up-processor.service";
import { followUpPremiumContinuationService } from "./follow-up-premium-continuation.service";
import { PREMIUM_CONTINUATION_STATUS } from "./follow-up-premium-continuation-policy";
import { fairMergeBusinessIds } from "./follow-up-worker-policy";

let timer: NodeJS.Timeout | null = null;
let running = false;
let dueBusinessSourceCursor = 0;
let databaseUnavailableSince: Date | null = null;
let databaseUnavailableLogCount = 0;
let nextDatabaseRetryAt: Date | null = null;

const DATABASE_BACKOFF_BASE_MS = 30_000;
const DATABASE_BACKOFF_MAX_MS = 5 * 60_000;

function databaseBackoffMs() {
  const multiplier = Math.min(databaseUnavailableLogCount, 4);
  return Math.min(DATABASE_BACKOFF_BASE_MS * 2 ** multiplier, DATABASE_BACKOFF_MAX_MS);
}

function databaseErrorSummary(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function shouldSkipForDatabaseBackoff(now = new Date()) {
  return Boolean(nextDatabaseRetryAt && nextDatabaseRetryAt > now);
}

function handleDatabaseUnavailable(error: unknown) {
  const now = new Date();
  if (!databaseUnavailableSince) databaseUnavailableSince = now;
  const backoffMs = databaseBackoffMs();
  nextDatabaseRetryAt = new Date(now.getTime() + backoffMs);
  databaseUnavailableLogCount += 1;

  const payload = {
    unavailableSince: databaseUnavailableSince.toISOString(),
    nextRetryAt: nextDatabaseRetryAt.toISOString(),
    retryInSeconds: Math.ceil(backoffMs / 1000),
    reason: databaseErrorSummary(error),
  };

  if (databaseUnavailableLogCount === 1) {
    console.warn("Follow-up worker paused because the database is unreachable", payload);
    return;
  }

  console.warn("Follow-up worker database retry failed", payload);
}

function markDatabaseAvailable() {
  if (!databaseUnavailableSince) return;
  console.info("Follow-up worker database connection recovered", {
    unavailableSince: databaseUnavailableSince.toISOString(),
    recoveredAt: new Date().toISOString(),
    failedRetries: databaseUnavailableLogCount,
  });
  databaseUnavailableSince = null;
  databaseUnavailableLogCount = 0;
  nextDatabaseRetryAt = null;
}

async function dueBusinessIds(limit: number) {
  const now = new Date();
  const staleContinuationClaim = new Date(now.getTime() - 10 * 60_000);
  const [scheduled, ambiguous, pendingMessages, premiumContinuations] = await Promise.all([
    prisma.followUpJob.findMany({
      where: { status: FollowUpJobStatus.SCHEDULED, scheduledFor: { lte: now } },
      distinct: ["businessId"],
      orderBy: [{ scheduledFor: "asc" }, { createdAt: "asc" }],
      select: { businessId: true },
      take: limit,
    }),
    prisma.followUpJob.findMany({
      where: {
        status: FollowUpJobStatus.FAILED,
        failureReason: { in: ["FOLLOW_UP_DELIVERY_PENDING_RECONCILIATION", "FOLLOW_UP_STALE_PROCESSING_PENDING_MESSAGE"] },
      },
      distinct: ["businessId"],
      orderBy: [{ updatedAt: "asc" }],
      select: { businessId: true },
      take: limit,
    }),
    prisma.message.findMany({
      where: {
        direction: MessageDirection.OUTBOUND,
        senderType: MessageSenderType.SYSTEM,
        deliveryStatus: MessageDeliveryStatus.PENDING,
        deletedAt: null,
        metadata: { path: ["source"], equals: "FOLLOW_UP_AUTOMATION" },
      },
      distinct: ["businessId"],
      orderBy: [{ createdAt: "asc" }],
      select: { businessId: true },
      take: limit,
    }),
    prisma.premiumFollowUpExecution.findMany({
      where: {
        continuationAttemptCount: { lt: 5 },
        OR: [
          {
            continuationStatus: {
              in: [
                PREMIUM_CONTINUATION_STATUS.PENDING,
                PREMIUM_CONTINUATION_STATUS.FAILED,
              ],
            },
            OR: [
              { continuationNextAttemptAt: null },
              { continuationNextAttemptAt: { lte: now } },
            ],
          },
          {
            continuationStatus: PREMIUM_CONTINUATION_STATUS.PROCESSING,
            continuationProcessingStartedAt: { lt: staleContinuationClaim },
          },
        ],
      },
      distinct: ["businessId"],
      orderBy: [{ continuationNextAttemptAt: "asc" }, { updatedAt: "asc" }],
      select: { businessId: true },
      take: limit,
    }),
  ]);
  const sources = [
    scheduled.map((row) => row.businessId),
    ambiguous.map((row) => row.businessId),
    pendingMessages.map((row) => row.businessId),
    premiumContinuations.map((row) => row.businessId),
  ];
  const selected = fairMergeBusinessIds(sources, limit, dueBusinessSourceCursor);
  dueBusinessSourceCursor = (dueBusinessSourceCursor + 1) % sources.length;
  return selected;
}

async function scheduleStaleLeadJobs(limit: number) {
  const now = new Date();
  const rules = await prisma.followUpAutomationRule.findMany({
    where: {
      type: FollowUpRuleType.STALE_LEAD,
      enabled: true,
      deletedAt: null,
      business: {
        status: BusinessStatus.ACTIVE,
        deletedAt: null,
        followUpAutomationEnabled: true,
      },
    },
    select: { id: true, businessId: true, delayMinutes: true },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });

  for (const rule of rules) {
    const staleCutoff = new Date(now.getTime() - rule.delayMinutes * 60_000);
    const leads = await prisma.lead.findMany({
      where: {
        businessId: rule.businessId,
        deletedAt: null,
        status: { notIn: [LeadStatus.WON, LeadStatus.LOST] },
        OR: [
          { lastContactedAt: { lte: staleCutoff } },
          { lastContactedAt: null, updatedAt: { lte: staleCutoff } },
        ],
        conversations: {
          some: {
            deletedAt: null,
            channel: ConversationChannel.WHATSAPP,
            status: { notIn: [ConversationStatus.CLOSED, ConversationStatus.PLAN_LIMIT_BLOCKED] },
          },
        },
        followUpJobs: {
          none: {
            ruleId: rule.id,
            status: { in: [FollowUpJobStatus.SCHEDULED, FollowUpJobStatus.PROCESSING] },
          },
        },
      },
      select: {
        id: true,
        lastContactedAt: true,
        updatedAt: true,
        conversations: {
          where: {
            deletedAt: null,
            channel: ConversationChannel.WHATSAPP,
            status: { notIn: [ConversationStatus.CLOSED, ConversationStatus.PLAN_LIMIT_BLOCKED] },
          },
          orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
          take: 1,
          select: { id: true },
        },
      },
      orderBy: [{ lastContactedAt: "asc" }, { updatedAt: "asc" }],
      take: limit,
    });

    for (const lead of leads) {
      await followUpPlusService.scheduleStaleLeadFollowUp({
        businessId: rule.businessId,
        leadId: lead.id,
        conversationId: lead.conversations[0]?.id ?? null,
        staleFrom: lead.lastContactedAt ?? lead.updatedAt,
      });
    }
  }
}

export const followUpWorkerService = {
  async tick() {
    if (running) return;
    if (shouldSkipForDatabaseBackoff()) return;
    running = true;
    try {
      await aiUsageService.reconcileStalePremiumFollowUpGenerationReservations(
        new Date(Date.now() - 10 * 60_000),
      );
      await scheduleStaleLeadJobs(env.FOLLOW_UP_WORKER_JOB_BATCH_SIZE);
      const businessIds = await dueBusinessIds(env.FOLLOW_UP_WORKER_BUSINESS_BATCH_SIZE);
      for (const businessId of businessIds) {
        await followUpJobProcessorService.reconcileLocalPendingFollowUpState(businessId);
        await followUpPremiumContinuationService.reconcilePending(
          businessId,
          env.FOLLOW_UP_WORKER_JOB_BATCH_SIZE,
        );
        await followUpJobProcessorService.processDueJobs(businessId, env.FOLLOW_UP_WORKER_JOB_BATCH_SIZE);
      }
      markDatabaseAvailable();
    } catch (error) {
      if (isDatabaseUnavailableError(error)) {
        handleDatabaseUnavailable(error);
        return;
      }
      console.error("Follow-up worker tick failed", error);
    } finally {
      running = false;
    }
  },

  start() {
    if (!env.FOLLOW_UP_WORKER_ENABLED || timer) return;
    timer = setInterval(() => void this.tick(), env.FOLLOW_UP_WORKER_INTERVAL_SECONDS * 1000);
    timer.unref?.();
    void this.tick();
    console.info("Follow-up worker started", {
      intervalSeconds: env.FOLLOW_UP_WORKER_INTERVAL_SECONDS,
      businessBatchSize: env.FOLLOW_UP_WORKER_BUSINESS_BATCH_SIZE,
      jobBatchSize: env.FOLLOW_UP_WORKER_JOB_BATCH_SIZE,
    });
  },

  stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    databaseUnavailableSince = null;
    databaseUnavailableLogCount = 0;
    nextDatabaseRetryAt = null;
    dueBusinessSourceCursor = 0;
  },
};

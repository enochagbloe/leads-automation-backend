import { AiUsageReservationStatus, PlanCode, Prisma } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import { subscriptionService } from "./subscription.service";

export type AiPlanPermissions = {
  aiReplies: boolean;
  teamRouting: boolean;
  safeAutoConfirm: boolean;
  monthlyAiReplyLimit: number | null;
};

export function getAiMonthlyLimit(planCode: PlanCode, configuredLimit?: number | null) {
  if (configuredLimit !== undefined) return configuredLimit;
  if (planCode === PlanCode.BASIC) return 500;
  if (planCode === PlanCode.PLUS) return 2000;
  return 10000;
}

export function getAiPlanPermissions(planCode: PlanCode, configuredLimit?: number | null): AiPlanPermissions {
  return {
    aiReplies: true,
    teamRouting: planCode === PlanCode.PLUS || planCode === PlanCode.PREMIUM,
    safeAutoConfirm: planCode === PlanCode.PREMIUM,
    monthlyAiReplyLimit: getAiMonthlyLimit(planCode, configuredLimit),
  };
}

export function getCustomerMemoryAiRequestLimit(planCode: PlanCode) {
  if (planCode === PlanCode.PREMIUM) return env.CUSTOMER_MEMORY_PREMIUM_MONTHLY_AI_REQUEST_LIMIT;
  if (planCode === PlanCode.PLUS) return env.CUSTOMER_MEMORY_PLUS_MONTHLY_AI_REQUEST_LIMIT;
  return env.CUSTOMER_MEMORY_BASIC_MONTHLY_AI_REQUEST_LIMIT;
}

const CUSTOMER_MEMORY_RESERVATION_FEATURE = "CUSTOMER_MEMORY_EXTRACTION";

function customerMemoryReservationKey(processingBatchId: string) {
  return `customer-memory:${processingBatchId}`;
}

async function lockAiBudget(tx: Prisma.TransactionClient, businessAccountId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`customer-memory-ai-budget:${businessAccountId}`}))`;
}

export const aiUsageService = {
  async reserveCustomerMemoryExtraction(input: { businessAccountId: string; processingBatchId: string }) {
    const { businessAccountId, processingBatchId } = input;
    const idempotencyKey = customerMemoryReservationKey(processingBatchId);
    const subscription = await subscriptionService.getCurrentRecord(businessAccountId);
    const usage = subscription.usageRecords[0];
    if (!usage) throw new AppError(500, "Current account usage record is unavailable", "USAGE_RECORD_UNAVAILABLE");
    const limit = getCustomerMemoryAiRequestLimit(subscription.plan.code);
    const reservedRequests = 1 + Math.min(env.OPENROUTER_MAX_FALLBACK_ATTEMPTS, env.OPENROUTER_FALLBACK_MODELS.length);
    return prisma.$transaction(async (tx) => {
      await lockAiBudget(tx, businessAccountId);
      const existing = await tx.aiUsageReservation.findUnique({ where: { idempotencyKey } });
      if (existing) {
        return {
          allowed: existing.status === AiUsageReservationStatus.RESERVED,
          usageId: existing.accountUsageId,
          reservationId: existing.id,
          idempotencyKey,
          plan: subscription.plan.code,
          current: usage.aiMemoryExtractionRequestsUsed,
          limit,
          reservedRequests: existing.reservedRequests,
          reservationStatus: existing.status,
        } as const;
      }
      const current = await tx.accountUsageRecord.findUnique({
        where: { id: usage.id },
        select: { aiMemoryExtractionRequestsUsed: true },
      });
      if (!current) throw new AppError(500, "Current account usage record is unavailable", "USAGE_RECORD_UNAVAILABLE");
      if (current.aiMemoryExtractionRequestsUsed + reservedRequests > limit) {
        return {
          allowed: false as const,
          usageId: usage.id,
          plan: subscription.plan.code,
          current: current.aiMemoryExtractionRequestsUsed,
          limit,
          reservedRequests,
          idempotencyKey,
          reservationStatus: null,
        };
      }
      await tx.accountUsageRecord.update({
        where: { id: usage.id },
        data: {
          aiMemoryExtractionRequestsUsed: { increment: reservedRequests },
          aiRequestsUsed: { increment: reservedRequests },
        },
      });
      const reservation = await tx.aiUsageReservation.create({
        data: {
          businessAccountId,
          accountUsageId: usage.id,
          idempotencyKey,
          feature: CUSTOMER_MEMORY_RESERVATION_FEATURE,
          processingBatchId,
          reservedRequests,
        },
      });
      return {
        allowed: true as const,
        usageId: usage.id,
        reservationId: reservation.id,
        idempotencyKey,
        plan: subscription.plan.code,
        current: current.aiMemoryExtractionRequestsUsed + reservedRequests,
        limit,
        reservedRequests,
        reservationStatus: reservation.status,
      };
    });
  },

  async markCustomerMemoryExtractionAttemptStarted(idempotencyKey: string) {
    return prisma.aiUsageReservation.updateMany({
      where: { idempotencyKey, status: AiUsageReservationStatus.RESERVED, providerAttemptStartedAt: null },
      data: { providerAttemptStartedAt: new Date() },
    });
  },

  async settleCustomerMemoryExtraction(input: {
    idempotencyKey: string;
    tokens?: number;
    providerRequestCount: number;
    providerRequestId?: string;
    failureCode?: string;
  }) {
    const actualRequests = Math.max(0, Math.floor(input.providerRequestCount));
    const actualTokens = Math.max(0, Math.floor(input.tokens ?? 0));
    return prisma.$transaction(async (tx) => {
      const initial = await tx.aiUsageReservation.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (!initial) throw new AppError(404, "AI usage reservation not found.", "AI_USAGE_RESERVATION_NOT_FOUND");
      await lockAiBudget(tx, initial.businessAccountId);
      const reservation = await tx.aiUsageReservation.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (!reservation) throw new AppError(404, "AI usage reservation not found.", "AI_USAGE_RESERVATION_NOT_FOUND");
      if (reservation.status === AiUsageReservationStatus.SETTLED) return reservation;
      if (reservation.status === AiUsageReservationStatus.RELEASED) {
        throw new AppError(409, "AI usage reservation was already released.", "AI_USAGE_RESERVATION_RELEASED");
      }

      const requestDelta = actualRequests - reservation.reservedRequests;
      await tx.accountUsageRecord.update({
        where: { id: reservation.accountUsageId },
        data: {
          ...(requestDelta > 0 ? {
            aiMemoryExtractionRequestsUsed: { increment: requestDelta },
            aiRequestsUsed: { increment: requestDelta },
          } : requestDelta < 0 ? {
            aiMemoryExtractionRequestsUsed: { decrement: Math.abs(requestDelta) },
            aiRequestsUsed: { decrement: Math.abs(requestDelta) },
          } : {}),
          ...(actualTokens > 0 ? {
            aiMemoryExtractionTokensUsed: { increment: actualTokens },
            aiTokensUsed: { increment: actualTokens },
          } : {}),
        },
      });
      return tx.aiUsageReservation.update({
        where: { id: reservation.id },
        data: {
          status: AiUsageReservationStatus.SETTLED,
          actualRequests,
          actualTokens,
          providerRequestId: input.providerRequestId,
          failureCode: input.failureCode,
          settledAt: new Date(),
          reconciliationRequiredAt: null,
        },
      });
    });
  },

  async releaseCustomerMemoryExtraction(input: { idempotencyKey: string; failureCode?: string }) {
    return prisma.$transaction(async (tx) => {
      const initial = await tx.aiUsageReservation.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (!initial) return null;
      await lockAiBudget(tx, initial.businessAccountId);
      const reservation = await tx.aiUsageReservation.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (!reservation || reservation.status === AiUsageReservationStatus.RELEASED) return reservation;
      if (reservation.status === AiUsageReservationStatus.SETTLED) return reservation;
      if (reservation.status === AiUsageReservationStatus.RECONCILIATION_REQUIRED) return reservation;
      await tx.accountUsageRecord.update({
        where: { id: reservation.accountUsageId },
        data: {
          aiMemoryExtractionRequestsUsed: { decrement: reservation.reservedRequests },
          aiRequestsUsed: { decrement: reservation.reservedRequests },
        },
      });
      return tx.aiUsageReservation.update({
        where: { id: reservation.id },
        data: {
          status: AiUsageReservationStatus.RELEASED,
          actualRequests: 0,
          actualTokens: 0,
          failureCode: input.failureCode,
          releasedAt: new Date(),
        },
      });
    });
  },

  async requireCustomerMemoryExtractionReconciliation(input: { idempotencyKey: string; failureCode?: string }) {
    return prisma.aiUsageReservation.updateMany({
      where: { idempotencyKey: input.idempotencyKey, status: AiUsageReservationStatus.RESERVED },
      data: {
        status: AiUsageReservationStatus.RECONCILIATION_REQUIRED,
        failureCode: input.failureCode,
        reconciliationRequiredAt: new Date(),
      },
    });
  },

  async reconcileStaleCustomerMemoryReservations(staleBefore: Date) {
    const stale = await prisma.aiUsageReservation.findMany({
      where: {
        feature: CUSTOMER_MEMORY_RESERVATION_FEATURE,
        status: AiUsageReservationStatus.RESERVED,
        createdAt: { lt: staleBefore },
      },
      select: { idempotencyKey: true, processingBatchId: true, providerAttemptStartedAt: true },
      take: 100,
    });
    const releasedBatchIds: string[] = [];
    const ambiguousBatchIds: string[] = [];
    for (const reservation of stale) {
      if (reservation.providerAttemptStartedAt) {
        await aiUsageService.requireCustomerMemoryExtractionReconciliation({
          idempotencyKey: reservation.idempotencyKey,
          failureCode: "CUSTOMER_MEMORY_AI_USAGE_AMBIGUOUS_CRASH",
        });
        if (reservation.processingBatchId) ambiguousBatchIds.push(reservation.processingBatchId);
      } else {
        await aiUsageService.releaseCustomerMemoryExtraction({
          idempotencyKey: reservation.idempotencyKey,
          failureCode: "CUSTOMER_MEMORY_AI_USAGE_RELEASED_BEFORE_PROVIDER",
        });
        if (reservation.processingBatchId) releasedBatchIds.push(reservation.processingBatchId);
      }
    }
    return { releasedBatchIds, ambiguousBatchIds };
  },

  async assertCanUseAiReplies(businessAccountId: string) {
    const subscription = await subscriptionService.getCurrentRecord(businessAccountId);
    const usage = subscription.usageRecords[0];
    if (!usage) throw new AppError(500, "Current account usage record is unavailable", "USAGE_RECORD_UNAVAILABLE");
    const permissions = getAiPlanPermissions(subscription.plan.code, subscription.plan.maxAiRepliesPerMonth);
    if (!permissions.aiReplies) throw new AppError(403, "AI replies are not available on this plan.", "AI_DISABLED");
    const current = usage.aiRepliesUsed ?? 0;
    const limit = permissions.monthlyAiReplyLimit;
    if (limit !== null && current >= limit) {
      throw new AppError(403, "Your account has reached the monthly AI reply limit for the current plan.", "AI_QUOTA_EXCEEDED", {
        current,
        limit,
        currentPlan: subscription.plan.code,
      });
    }
    return { subscription, usage, permissions };
  },

  async trackRequest(input: { accountUsageId: string; tokens?: number }) {
    return prisma.accountUsageRecord.update({
      where: { id: input.accountUsageId },
      data: {
        aiRequestsUsed: { increment: 1 },
        ...(input.tokens ? { aiTokensUsed: { increment: input.tokens } } : {}),
      },
    });
  },

  async trackReply(input: { accountUsageId: string; businessUsageId?: string | null }) {
    const updates: Promise<unknown>[] = [
      prisma.accountUsageRecord.update({ where: { id: input.accountUsageId }, data: { aiRepliesUsed: { increment: 1 } } }),
    ];
    if (input.businessUsageId) {
      updates.push(prisma.businessUsageRecord.update({ where: { id: input.businessUsageId }, data: { aiRepliesUsed: { increment: 1 } } }));
    }
    await Promise.all(updates);
  },

  async trackBlocked(input: { accountUsageId: string; humanReview?: boolean }) {
    return prisma.accountUsageRecord.update({
      where: { id: input.accountUsageId },
      data: {
        aiBlockedUsed: { increment: 1 },
        ...(input.humanReview ? { aiHumanReviewsUsed: { increment: 1 } } : {}),
      },
    });
  },

  async trackBookingRequest(input: { accountUsageId: string }) {
    return prisma.accountUsageRecord.update({
      where: { id: input.accountUsageId },
      data: { aiBookingRequestsCreated: { increment: 1 } },
    });
  },

  async trackSafeHandoff(input: { accountUsageId: string; emailSent?: boolean }) {
    return prisma.accountUsageRecord.update({
      where: { id: input.accountUsageId },
      data: {
        aiSafeHandoffsTriggered: { increment: 1 },
        ...(input.emailSent ? { aiSafeHandoffEmailsSent: { increment: 1 } } : {}),
      },
    });
  },

  async trackCustomerIssue(input: { accountUsageId: string; routed?: boolean; emailSent?: boolean }) {
    return prisma.accountUsageRecord.update({
      where: { id: input.accountUsageId },
      data: {
        aiComplaintsDetected: { increment: 1 },
        customerIssuesLogged: { increment: 1 },
        ...(input.routed ? { customerIssuesRouted: { increment: 1 } } : {}),
        ...(input.emailSent ? { customerIssueEmailsSent: { increment: 1 } } : {}),
      },
    });
  },
};

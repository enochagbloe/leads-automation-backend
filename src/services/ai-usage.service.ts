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
const PREMIUM_FOLLOW_UP_GENERATION_FEATURE = "PREMIUM_FOLLOW_UP_MESSAGE_GENERATION";
const KNOWLEDGE_DOCUMENT_ANALYSIS_FEATURE = "KNOWLEDGE_DOCUMENT_ANALYSIS";

function customerMemoryReservationKey(processingBatchId: string) {
  return `customer-memory:${processingBatchId}`;
}

export function getKnowledgeDocumentAnalysisAiRequestLimit(planCode: PlanCode) {
  if (planCode === PlanCode.PREMIUM) return env.KNOWLEDGE_PREMIUM_MONTHLY_AI_ANALYSIS_REQUEST_LIMIT;
  if (planCode === PlanCode.PLUS) return env.KNOWLEDGE_PLUS_MONTHLY_AI_ANALYSIS_REQUEST_LIMIT;
  return env.KNOWLEDGE_BASIC_MONTHLY_AI_ANALYSIS_REQUEST_LIMIT;
}

async function lockAiBudget(tx: Prisma.TransactionClient, businessAccountId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`customer-memory-ai-budget:${businessAccountId}`}))`;
}

export function knowledgeDocumentAnalysisUsageFromCheckpoint(snapshot: Prisma.JsonValue | null) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const value = snapshot as Prisma.JsonObject;
  const providerRequestCount = value.providerRequestCount;
  const totalTokens = value.totalTokens;
  const providerRequestId = value.requestId;
  if (
    typeof providerRequestCount !== "number"
    || !Number.isInteger(providerRequestCount)
    || providerRequestCount < 0
    || providerRequestCount > 100
  ) return null;
  if (totalTokens !== null && totalTokens !== undefined && (
    typeof totalTokens !== "number"
    || !Number.isInteger(totalTokens)
    || totalTokens < 0
  )) return null;
  if (providerRequestId !== null && providerRequestId !== undefined && typeof providerRequestId !== "string") return null;
  return {
    providerRequestCount,
    tokens: typeof totalTokens === "number" ? totalTokens : undefined,
    providerRequestId: typeof providerRequestId === "string" ? providerRequestId : undefined,
  };
}

async function resolveAmbiguousKnowledgeDocumentAnalysisReservation(reservation: {
  idempotencyKey: string;
  processingBatchId: string | null;
  reservedRequests: number;
}) {
  const checkpoint = await prisma.knowledgeDocumentAnalysis.findFirst({
    where: {
      providerUsageReservationKey: reservation.idempotencyKey,
      providerResultSnapshot: { not: Prisma.DbNull },
    },
    select: { providerResultSnapshot: true },
  });
  const checkpointUsage = knowledgeDocumentAnalysisUsageFromCheckpoint(checkpoint?.providerResultSnapshot ?? null);
  if (checkpointUsage) {
    await aiUsageService.settleKnowledgeDocumentAnalysis({
      idempotencyKey: reservation.idempotencyKey,
      ...checkpointUsage,
    });
    return { processingBatchId: reservation.processingBatchId, resolution: "CHECKPOINT_SETTLED" as const };
  }

  await aiUsageService.settleKnowledgeDocumentAnalysis({
    idempotencyKey: reservation.idempotencyKey,
    providerRequestCount: reservation.reservedRequests,
    failureCode: "KNOWLEDGE_DOCUMENT_AI_RESULT_LOST_AFTER_PROVIDER_ATTEMPT",
  });
  return { processingBatchId: reservation.processingBatchId, resolution: "SETTLED_CONSERVATIVELY" as const };
}

export const aiUsageService = {
  async reservePremiumFollowUpGeneration(input: {
    businessAccountId: string;
    idempotencyKey: string;
    processingBatchId: string;
  }) {
    const subscription = await subscriptionService.getCurrentRecord(input.businessAccountId);
    const usage = subscription.usageRecords[0];
    if (!usage) throw new AppError(500, "Current account usage record is unavailable", "USAGE_RECORD_UNAVAILABLE");
    const permissions = getAiPlanPermissions(subscription.plan.code, subscription.plan.maxAiRepliesPerMonth);
    if (!permissions.aiReplies) {
      throw new AppError(403, "AI replies are not available on this plan.", "AI_DISABLED");
    }
    const reservedRequests =
      1 + Math.min(env.OPENROUTER_MAX_FALLBACK_ATTEMPTS, env.OPENROUTER_FALLBACK_MODELS.length);

    return prisma.$transaction(async (tx) => {
      await lockAiBudget(tx, input.businessAccountId);
      const existing = await tx.aiUsageReservation.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (existing) {
        throw new AppError(
          409,
          "This Premium follow-up AI generation attempt has already been processed.",
          "AI_USAGE_RESERVATION_NOT_RETRYABLE",
        );
      }

      const current = await tx.accountUsageRecord.findUnique({
        where: { id: usage.id },
        select: { aiRepliesUsed: true },
      });
      if (!current) {
        throw new AppError(500, "Current account usage record is unavailable", "USAGE_RECORD_UNAVAILABLE");
      }
      const limit = permissions.monthlyAiReplyLimit;
      if (limit !== null && current.aiRepliesUsed + 1 > limit) {
        throw new AppError(
          403,
          "Your account has reached the monthly AI reply limit for the current plan.",
          "AI_QUOTA_EXCEEDED",
          {
            current: current.aiRepliesUsed,
            limit,
            currentPlan: subscription.plan.code,
            requested: 1,
          },
        );
      }

      await tx.accountUsageRecord.update({
        where: { id: usage.id },
        data: {
          aiRepliesUsed: { increment: 1 },
          aiRequestsUsed: { increment: reservedRequests },
        },
      });
      const reservation = await tx.aiUsageReservation.create({
        data: {
          businessAccountId: input.businessAccountId,
          accountUsageId: usage.id,
          idempotencyKey: input.idempotencyKey,
          feature: PREMIUM_FOLLOW_UP_GENERATION_FEATURE,
          processingBatchId: input.processingBatchId,
          reservedRequests,
        },
      });
      return {
        allowed: true as const,
        reservationId: reservation.id,
        reservedRequests,
      };
    });
  },

  async markPremiumFollowUpGenerationAttemptStarted(idempotencyKey: string) {
    const changed = await prisma.aiUsageReservation.updateMany({
      where: {
        idempotencyKey,
        feature: PREMIUM_FOLLOW_UP_GENERATION_FEATURE,
        status: AiUsageReservationStatus.RESERVED,
        providerAttemptStartedAt: null,
      },
      data: { providerAttemptStartedAt: new Date() },
    });
    if (changed.count !== 1) {
      throw new AppError(
        409,
        "Premium follow-up AI generation usage could not be claimed.",
        "AI_USAGE_RESERVATION_NOT_RETRYABLE",
      );
    }
  },

  async settlePremiumFollowUpGeneration(input: {
    idempotencyKey: string;
    providerRequestCount: number;
    tokens?: number;
    providerRequestId?: string;
    failureCode?: string;
  }) {
    const actualRequests = Math.max(0, Math.floor(input.providerRequestCount));
    const actualTokens = Math.max(0, Math.floor(input.tokens ?? 0));
    return prisma.$transaction(async (tx) => {
      const initial = await tx.aiUsageReservation.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (!initial || initial.feature !== PREMIUM_FOLLOW_UP_GENERATION_FEATURE) {
        throw new AppError(404, "AI usage reservation not found.", "AI_USAGE_RESERVATION_NOT_FOUND");
      }
      await lockAiBudget(tx, initial.businessAccountId);
      const reservation = await tx.aiUsageReservation.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (!reservation) {
        throw new AppError(404, "AI usage reservation not found.", "AI_USAGE_RESERVATION_NOT_FOUND");
      }
      if (reservation.status === AiUsageReservationStatus.SETTLED) return reservation;
      if (reservation.status !== AiUsageReservationStatus.RESERVED) {
        throw new AppError(
          409,
          "AI usage reservation cannot be settled in its current state.",
          "AI_USAGE_RESERVATION_NOT_SETTLEABLE",
        );
      }

      const requestDelta = actualRequests - reservation.reservedRequests;
      const replyDelta = (actualRequests > 0 ? 1 : 0) - 1;
      await tx.accountUsageRecord.update({
        where: { id: reservation.accountUsageId },
        data: {
          ...(replyDelta < 0 ? {
            aiRepliesUsed: { decrement: Math.abs(replyDelta) },
          } : {}),
          ...(requestDelta > 0 ? {
            aiRequestsUsed: { increment: requestDelta },
          } : requestDelta < 0 ? {
            aiRequestsUsed: { decrement: Math.abs(requestDelta) },
          } : {}),
          ...(actualTokens > 0 ? {
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

  async releasePremiumFollowUpGeneration(input: {
    idempotencyKey: string;
    failureCode?: string;
  }) {
    return prisma.$transaction(async (tx) => {
      const initial = await tx.aiUsageReservation.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (!initial || initial.feature !== PREMIUM_FOLLOW_UP_GENERATION_FEATURE) return null;
      await lockAiBudget(tx, initial.businessAccountId);
      const reservation = await tx.aiUsageReservation.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (!reservation || reservation.status !== AiUsageReservationStatus.RESERVED) {
        return reservation;
      }
      if (reservation.providerAttemptStartedAt) {
        return tx.aiUsageReservation.update({
          where: { id: reservation.id },
          data: {
            status: AiUsageReservationStatus.RECONCILIATION_REQUIRED,
            failureCode: input.failureCode ?? "PREMIUM_FOLLOW_UP_AI_USAGE_AMBIGUOUS",
            reconciliationRequiredAt: new Date(),
          },
        });
      }
      await tx.accountUsageRecord.update({
        where: { id: reservation.accountUsageId },
        data: {
          aiRepliesUsed: { decrement: 1 },
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

  async reconcileStalePremiumFollowUpGenerationReservations(staleBefore: Date) {
    const reservations = await prisma.aiUsageReservation.findMany({
      where: {
        feature: PREMIUM_FOLLOW_UP_GENERATION_FEATURE,
        status: AiUsageReservationStatus.RESERVED,
        createdAt: { lt: staleBefore },
      },
      select: {
        id: true,
        idempotencyKey: true,
        providerAttemptStartedAt: true,
      },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    let released = 0;
    let reconciliationRequired = 0;
    for (const reservation of reservations) {
      if (reservation.providerAttemptStartedAt) {
        const changed = await prisma.aiUsageReservation.updateMany({
          where: {
            id: reservation.id,
            status: AiUsageReservationStatus.RESERVED,
          },
          data: {
            status: AiUsageReservationStatus.RECONCILIATION_REQUIRED,
            failureCode: "PREMIUM_FOLLOW_UP_AI_USAGE_AMBIGUOUS_CRASH",
            reconciliationRequiredAt: new Date(),
          },
        });
        reconciliationRequired += changed.count;
      } else {
        const result = await aiUsageService.releasePremiumFollowUpGeneration({
          idempotencyKey: reservation.idempotencyKey,
          failureCode: "PREMIUM_FOLLOW_UP_AI_USAGE_RELEASED_BEFORE_PROVIDER",
        });
        if (result?.status === AiUsageReservationStatus.RELEASED) released += 1;
      }
    }
    return { released, reconciliationRequired };
  },

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

  async reserveKnowledgeDocumentAnalysis(input: {
    businessAccountId: string;
    idempotencyKey: string;
    processingBatchId: string;
  }) {
    const subscription = await subscriptionService.getCurrentRecord(input.businessAccountId);
    const usage = subscription.usageRecords[0];
    if (!usage) throw new AppError(500, "Current account usage record is unavailable", "USAGE_RECORD_UNAVAILABLE");
    const limit = getKnowledgeDocumentAnalysisAiRequestLimit(subscription.plan.code);
    const reservedRequests =
      1 + Math.min(env.OPENROUTER_MAX_FALLBACK_ATTEMPTS, env.OPENROUTER_FALLBACK_MODELS.length);

    return prisma.$transaction(async (tx) => {
      await lockAiBudget(tx, input.businessAccountId);
      const existing = await tx.aiUsageReservation.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing) {
        if (
          existing.feature === KNOWLEDGE_DOCUMENT_ANALYSIS_FEATURE
          && existing.status === AiUsageReservationStatus.RESERVED
          && !existing.providerAttemptStartedAt
        ) {
          return { reservation: existing, reservedRequests, limit };
        }
        throw new AppError(
          409,
          "This document analysis attempt has already been processed.",
          "KNOWLEDGE_DOCUMENT_AI_USAGE_RESERVATION_NOT_RETRYABLE",
        );
      }

      const current = await tx.accountUsageRecord.findUnique({
        where: { id: usage.id },
        select: { aiKnowledgeAnalysisRequestsUsed: true },
      });
      if (!current) throw new AppError(500, "Current account usage record is unavailable", "USAGE_RECORD_UNAVAILABLE");
      if (current.aiKnowledgeAnalysisRequestsUsed + reservedRequests > limit) {
        throw new AppError(
          403,
          "Your account has reached its monthly Knowledge Document AI analysis limit.",
          "KNOWLEDGE_DOCUMENT_AI_QUOTA_EXCEEDED",
          {
            current: current.aiKnowledgeAnalysisRequestsUsed,
            limit,
            currentPlan: subscription.plan.code,
            requested: reservedRequests,
          },
        );
      }

      await tx.accountUsageRecord.update({
        where: { id: usage.id },
        data: {
          aiKnowledgeAnalysisRequestsUsed: { increment: reservedRequests },
          aiRequestsUsed: { increment: reservedRequests },
        },
      });
      const reservation = await tx.aiUsageReservation.create({
        data: {
          businessAccountId: input.businessAccountId,
          accountUsageId: usage.id,
          idempotencyKey: input.idempotencyKey,
          feature: KNOWLEDGE_DOCUMENT_ANALYSIS_FEATURE,
          processingBatchId: input.processingBatchId,
          reservedRequests,
        },
      });
      return { reservation, reservedRequests, limit };
    });
  },

  async markKnowledgeDocumentAnalysisAttemptStarted(idempotencyKey: string) {
    const changed = await prisma.aiUsageReservation.updateMany({
      where: {
        idempotencyKey,
        feature: KNOWLEDGE_DOCUMENT_ANALYSIS_FEATURE,
        status: AiUsageReservationStatus.RESERVED,
        providerAttemptStartedAt: null,
      },
      data: { providerAttemptStartedAt: new Date() },
    });
    if (changed.count !== 1) {
      throw new AppError(
        409,
        "Document analysis usage could not be claimed.",
        "KNOWLEDGE_DOCUMENT_AI_USAGE_RESERVATION_NOT_RETRYABLE",
      );
    }
  },

  async settleKnowledgeDocumentAnalysis(input: {
    idempotencyKey: string;
    providerRequestCount: number;
    tokens?: number;
    providerRequestId?: string;
    failureCode?: string;
  }) {
    const actualRequests = Math.max(0, Math.floor(input.providerRequestCount));
    const actualTokens = Math.max(0, Math.floor(input.tokens ?? 0));
    return prisma.$transaction(async (tx) => {
      const initial = await tx.aiUsageReservation.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (!initial || initial.feature !== KNOWLEDGE_DOCUMENT_ANALYSIS_FEATURE) {
        throw new AppError(404, "AI usage reservation not found.", "AI_USAGE_RESERVATION_NOT_FOUND");
      }
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
            aiKnowledgeAnalysisRequestsUsed: { increment: requestDelta },
            aiRequestsUsed: { increment: requestDelta },
          } : requestDelta < 0 ? {
            aiKnowledgeAnalysisRequestsUsed: { decrement: Math.abs(requestDelta) },
            aiRequestsUsed: { decrement: Math.abs(requestDelta) },
          } : {}),
          ...(actualTokens > 0 ? {
            aiKnowledgeAnalysisTokensUsed: { increment: actualTokens },
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

  async releaseKnowledgeDocumentAnalysis(input: { idempotencyKey: string; failureCode?: string }) {
    return prisma.$transaction(async (tx) => {
      const initial = await tx.aiUsageReservation.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (!initial || initial.feature !== KNOWLEDGE_DOCUMENT_ANALYSIS_FEATURE) return null;
      await lockAiBudget(tx, initial.businessAccountId);
      const reservation = await tx.aiUsageReservation.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (!reservation || reservation.status !== AiUsageReservationStatus.RESERVED) return reservation;
      if (reservation.providerAttemptStartedAt) {
        return tx.aiUsageReservation.update({
          where: { id: reservation.id },
          data: {
            status: AiUsageReservationStatus.RECONCILIATION_REQUIRED,
            failureCode: input.failureCode ?? "KNOWLEDGE_DOCUMENT_AI_USAGE_AMBIGUOUS",
            reconciliationRequiredAt: new Date(),
          },
        });
      }
      await tx.accountUsageRecord.update({
        where: { id: reservation.accountUsageId },
        data: {
          aiKnowledgeAnalysisRequestsUsed: { decrement: reservation.reservedRequests },
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

  async reconcileStaleKnowledgeDocumentAnalysisReservations(staleBefore: Date) {
    const stale = await prisma.aiUsageReservation.findMany({
      where: {
        feature: KNOWLEDGE_DOCUMENT_ANALYSIS_FEATURE,
        status: AiUsageReservationStatus.RESERVED,
        createdAt: { lt: staleBefore },
      },
      select: { idempotencyKey: true, providerAttemptStartedAt: true },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    let released = 0;
    let reconciliationRequired = 0;
    for (const reservation of stale) {
      const result = await aiUsageService.releaseKnowledgeDocumentAnalysis({
        idempotencyKey: reservation.idempotencyKey,
        failureCode: reservation.providerAttemptStartedAt
          ? "KNOWLEDGE_DOCUMENT_AI_USAGE_AMBIGUOUS_CRASH"
          : "KNOWLEDGE_DOCUMENT_AI_USAGE_RELEASED_BEFORE_PROVIDER",
      });
      if (result?.status === AiUsageReservationStatus.RELEASED) released += 1;
      if (result?.status === AiUsageReservationStatus.RECONCILIATION_REQUIRED) reconciliationRequired += 1;
    }

    const ambiguous = await prisma.aiUsageReservation.findMany({
      where: {
        feature: KNOWLEDGE_DOCUMENT_ANALYSIS_FEATURE,
        status: AiUsageReservationStatus.RECONCILIATION_REQUIRED,
        OR: [
          { reconciliationRequiredAt: { lt: staleBefore } },
          { reconciliationRequiredAt: null, updatedAt: { lt: staleBefore } },
        ],
      },
      select: { idempotencyKey: true, processingBatchId: true, reservedRequests: true },
      orderBy: [{ reconciliationRequiredAt: "asc" }, { updatedAt: "asc" }],
      take: 100,
    });
    const recoverableProcessingBatchIds: string[] = [];
    let checkpointSettled = 0;
    let settledConservatively = 0;
    for (const reservation of ambiguous) {
      const resolution = await resolveAmbiguousKnowledgeDocumentAnalysisReservation(reservation);
      if (resolution.processingBatchId) recoverableProcessingBatchIds.push(resolution.processingBatchId);
      if (resolution.resolution === "CHECKPOINT_SETTLED") checkpointSettled += 1;
      else settledConservatively += 1;
    }
    return {
      released,
      reconciliationRequired,
      checkpointSettled,
      settledConservatively,
      recoverableProcessingBatchIds,
    };
  },

  async reconcileKnowledgeDocumentAnalysisForProcessingJob(processingJobId: string) {
    const reservations = await prisma.aiUsageReservation.findMany({
      where: {
        feature: KNOWLEDGE_DOCUMENT_ANALYSIS_FEATURE,
        processingBatchId: { startsWith: `${processingJobId}:` },
        status: { in: [AiUsageReservationStatus.RESERVED, AiUsageReservationStatus.RECONCILIATION_REQUIRED] },
        providerAttemptStartedAt: { not: null },
      },
      select: { idempotencyKey: true, processingBatchId: true, reservedRequests: true, status: true },
      orderBy: { createdAt: "asc" },
    });
    const resolutions = [];
    for (const reservation of reservations) {
      if (reservation.status === AiUsageReservationStatus.RESERVED) {
        await aiUsageService.releaseKnowledgeDocumentAnalysis({
          idempotencyKey: reservation.idempotencyKey,
          failureCode: "KNOWLEDGE_DOCUMENT_AI_USAGE_MANUAL_RECONCILIATION",
        });
      }
      resolutions.push(await resolveAmbiguousKnowledgeDocumentAnalysisReservation(reservation));
    }
    return resolutions;
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

  async trackRequest(input: { accountUsageId: string; tokens?: number; requests?: number }) {
    const requests = Math.max(0, Math.floor(input.requests ?? 1));
    const tokens = Math.max(0, Math.floor(input.tokens ?? 0));
    return prisma.accountUsageRecord.update({
      where: { id: input.accountUsageId },
      data: {
        aiRequestsUsed: { increment: requests },
        ...(tokens > 0 ? { aiTokensUsed: { increment: tokens } } : {}),
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

import {
  KnowledgeArticleStatus,
  KnowledgeDocumentStatus,
  PlanCode,
  Prisma,
} from "@prisma/client";
import { env } from "../config/env";
import { AppError } from "../utils/errors";
import { ACTIVE_SUBSCRIPTION_STATUSES } from "./subscription.service";

export type KnowledgeHubAccountActor = {
  businessAccountId: string;
};

export function knowledgeAssetLimit(plan: { code: PlanCode; maxKnowledgeItems?: number | null }) {
  if (plan.maxKnowledgeItems !== null && plan.maxKnowledgeItems !== undefined) return plan.maxKnowledgeItems;
  if (plan.code === PlanCode.PREMIUM) return env.KNOWLEDGE_PREMIUM_ASSET_LIMIT;
  if (plan.code === PlanCode.PLUS) return env.KNOWLEDGE_PLUS_ASSET_LIMIT;
  return env.KNOWLEDGE_BASIC_ASSET_LIMIT;
}

export function knowledgeAiDraftLimit(planCode: PlanCode) {
  if (planCode === PlanCode.PREMIUM) return env.KNOWLEDGE_PREMIUM_AI_DRAFT_LIMIT;
  if (planCode === PlanCode.PLUS) return env.KNOWLEDGE_PLUS_AI_DRAFT_LIMIT;
  return env.KNOWLEDGE_BASIC_AI_DRAFT_LIMIT;
}

export function knowledgeDocumentLimit(planCode: PlanCode) {
  if (planCode === PlanCode.PREMIUM) return env.KNOWLEDGE_PREMIUM_PDF_UPLOAD_LIMIT;
  if (planCode === PlanCode.PLUS) return env.KNOWLEDGE_PLUS_PDF_UPLOAD_LIMIT;
  return env.KNOWLEDGE_BASIC_PDF_UPLOAD_LIMIT;
}

export function knowledgeStorageLimit(planCode: PlanCode) {
  if (planCode === PlanCode.PREMIUM) return env.KNOWLEDGE_PREMIUM_STORAGE_LIMIT_BYTES;
  if (planCode === PlanCode.PLUS) return env.KNOWLEDGE_PLUS_STORAGE_LIMIT_BYTES;
  return env.KNOWLEDGE_BASIC_STORAGE_LIMIT_BYTES;
}

export function maximumKnowledgeFileSize(planCode: PlanCode) {
  if (planCode === PlanCode.BASIC) return Math.min(env.KNOWLEDGE_UPLOAD_MAX_BYTES, 5 * 1024 * 1024);
  return env.KNOWLEDGE_UPLOAD_MAX_BYTES;
}

export async function lockKnowledgeHubQuota(tx: Prisma.TransactionClient, businessAccountId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('knowledge_hub_quota'), hashtext(${businessAccountId}))`;
}

export async function currentKnowledgeHubSubscription(
  tx: Prisma.TransactionClient,
  businessAccountId: string,
) {
  const now = new Date();
  const subscription = await tx.subscription.findFirst({
    where: {
      businessAccountId,
      status: { in: ACTIVE_SUBSCRIPTION_STATUSES },
      currentPeriodStart: { lte: now },
      currentPeriodEnd: { gt: now },
    },
    orderBy: { createdAt: "desc" },
    include: { plan: true },
  });
  if (!subscription) {
    throw new AppError(403, "An active subscription is required.", "SUBSCRIPTION_REQUIRED");
  }
  return subscription;
}

export async function activeKnowledgeAssetCount(
  tx: Prisma.TransactionClient,
  businessAccountId: string,
) {
  const [articles, documents] = await Promise.all([
    tx.knowledgeArticle.count({
      where: {
        business: { businessAccountId },
        status: { not: KnowledgeArticleStatus.ARCHIVED },
      },
    }),
    tx.knowledgeDocument.count({
      where: {
        business: { businessAccountId },
        status: KnowledgeDocumentStatus.ACTIVE,
        deletedAt: null,
      },
    }),
  ]);
  return articles + documents;
}

export async function assertKnowledgeAssetCapacityForLimit(
  tx: Prisma.TransactionClient,
  input: {
    businessAccountId: string;
    increment?: number;
    limit: number;
    planCode?: PlanCode;
    planName?: string;
  },
) {
  await lockKnowledgeHubQuota(tx, input.businessAccountId);
  return assertKnowledgeAssetCountWithinLimit(tx, input);
}

async function assertKnowledgeAssetCountWithinLimit(
  tx: Prisma.TransactionClient,
  input: {
    businessAccountId: string;
    increment?: number;
    limit: number;
    planCode?: PlanCode;
    planName?: string;
  },
) {
  const increment = input.increment ?? 1;
  const current = await activeKnowledgeAssetCount(tx, input.businessAccountId);
  if (current + increment <= input.limit) return { current, limit: input.limit };

  throw new AppError(
    403,
    input.planName
      ? `Your ${input.planName} plan allows ${input.limit} active knowledge assets.`
      : "Your plan's active Knowledge Hub item limit has been reached.",
    "KNOWLEDGE_ASSET_LIMIT_REACHED",
    {
      ...(input.planCode ? { currentPlan: input.planCode } : {}),
      currentUsage: current,
      limit: input.limit,
      attemptedAmount: increment,
    },
  );
}

export async function assertKnowledgeAssetCapacity(
  tx: Prisma.TransactionClient,
  actor: KnowledgeHubAccountActor,
  increment = 1,
) {
  await lockKnowledgeHubQuota(tx, actor.businessAccountId);
  const subscription = await currentKnowledgeHubSubscription(tx, actor.businessAccountId);
  const limit = knowledgeAssetLimit(subscription.plan);
  const result = await assertKnowledgeAssetCountWithinLimit(tx, {
    businessAccountId: actor.businessAccountId,
    increment,
    limit,
    planCode: subscription.plan.code,
    planName: subscription.plan.name,
  });
  return { subscription, ...result };
}

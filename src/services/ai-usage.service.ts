import { PlanCode } from "@prisma/client";
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

export const aiUsageService = {
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
};

import { AccountUsageRecord, AuditAction, BusinessUsageRecord, Plan, PlanCode, Prisma, SubscriptionStatus } from "@prisma/client";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import { auditService } from "./audit.service";

export const ACTIVE_SUBSCRIPTION_STATUSES = [SubscriptionStatus.TRIALING, SubscriptionStatus.ACTIVE];

export type FeatureKey = "allowAnalytics" | "allowRemoveBranding" | "allowPrioritySupport";
export type EnforcedUsageKey = "businessesCount" | "staffCount" | "servicesCount" | "appointmentsUsed";
export type AccountUsageKey = EnforcedUsageKey | "conversationsUsed" | "aiRepliesUsed" | "knowledgeItemsCount";
export type BusinessUsageKey = "conversationsUsed" | "aiRepliesUsed" | "appointmentsUsed" | "leadsCreated";

export const PLAN_LIMIT_KEYS = {
  businessesCount: "maxBusinesses",
  staffCount: "maxStaff",
  servicesCount: "maxServices",
  appointmentsUsed: "maxAppointmentsPerMonth",
} as const satisfies Record<EnforcedUsageKey, keyof Plan>;

const USAGE_LABELS: Record<EnforcedUsageKey, string> = {
  businessesCount: "businesses",
  staffCount: "staff members",
  servicesCount: "services",
  appointmentsUsed: "appointments per month",
};

const LIMIT_ACTIONS: Record<EnforcedUsageKey, string> = {
  businessesCount: "create more businesses",
  staffCount: "add more staff",
  servicesCount: "create more services",
  appointmentsUsed: "create more appointments",
};

function recommendedPlan(currentPlan: PlanCode) {
  return currentPlan === PlanCode.BASIC ? PlanCode.PLUS : PlanCode.PREMIUM;
}

function recommendedPlanForFeature(featureKey: FeatureKey) {
  return featureKey === "allowAnalytics" ? PlanCode.PLUS : PlanCode.PREMIUM;
}

export function getPlanLimits(plan: Plan) {
  return {
    maxBusinesses: plan.maxBusinesses,
    maxStaff: plan.maxStaff,
    maxServices: plan.maxServices,
    maxAppointmentsPerMonth: plan.maxAppointmentsPerMonth,
    maxConversationsPerMonth: plan.maxConversationsPerMonth,
    maxAiRepliesPerMonth: plan.maxAiRepliesPerMonth,
    maxKnowledgeItems: plan.maxKnowledgeItems,
  };
}

export function getPlanFeatures(plan: Plan) {
  return {
    allowAnalytics: plan.allowAnalytics,
    allowRemoveBranding: plan.allowRemoveBranding,
    allowPrioritySupport: plan.allowPrioritySupport,
  };
}

export function getAccountUsage(usage?: AccountUsageRecord) {
  return {
    businessesCount: usage?.businessesCount ?? 0,
    staffCount: usage?.staffCount ?? 0,
    servicesCount: usage?.servicesCount ?? 0,
    appointmentsUsed: usage?.appointmentsUsed ?? 0,
    conversationsUsed: usage?.conversationsUsed ?? 0,
    aiRepliesUsed: usage?.aiRepliesUsed ?? 0,
    knowledgeItemsCount: usage?.knowledgeItemsCount ?? 0,
  };
}

export function getBusinessUsage(usage?: BusinessUsageRecord) {
  return {
    conversationsUsed: usage?.conversationsUsed ?? 0,
    aiRepliesUsed: usage?.aiRepliesUsed ?? 0,
    appointmentsUsed: usage?.appointmentsUsed ?? 0,
    leadsCreated: usage?.leadsCreated ?? 0,
  };
}

export const subscriptionService = {
  async getCurrentRecord(businessAccountId: string) {
    const subscription = await prisma.subscription.findFirst({
      where: { businessAccountId, status: { in: ACTIVE_SUBSCRIPTION_STATUSES } },
      orderBy: { createdAt: "desc" },
      include: {
        businessAccount: true,
        plan: true,
        usageRecords: { orderBy: { periodStart: "desc" }, take: 1 },
      },
    });
    if (!subscription) throw new AppError(403, "No active subscription", "SUBSCRIPTION_REQUIRED");
    return subscription;
  },

  async getCurrent(businessAccountId: string, activeBusinessId?: string | null, userId?: string) {
    const subscription = await this.getCurrentRecord(businessAccountId);
    const [businessUsage, memberships] = await Promise.all([
      activeBusinessId ? prisma.businessUsageRecord.findFirst({
        where: { businessId: activeBusinessId },
        orderBy: { periodStart: "desc" },
      }) : null,
      userId ? prisma.businessMember.findMany({
        where: { userId, status: "ACTIVE", business: { businessAccountId } },
        orderBy: { joinedAt: "asc" },
        select: { business: true },
      }) : [],
    ]);
    return {
      account: subscription.businessAccount,
      businesses: memberships.map((membership) => membership.business),
      activeBusiness: memberships.find((membership) => membership.business.id === activeBusinessId)?.business ?? null,
      id: subscription.id,
      plan: subscription.plan.code,
      status: subscription.status,
      accountUsage: getAccountUsage(subscription.usageRecords[0]),
      businessUsage: getBusinessUsage(businessUsage ?? undefined),
      limits: getPlanLimits(subscription.plan),
      features: getPlanFeatures(subscription.plan),
      startsAt: subscription.startsAt,
      trialEndsAt: subscription.trialEndsAt,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
      cancelledAt: subscription.cancelledAt,
    };
  },

  async listPlans() {
    return prisma.plan.findMany({ where: { isActive: true }, orderBy: { priceMonthly: "asc" } });
  },

  async assertWithinLimit(businessAccountId: string, usageKey: EnforcedUsageKey, businessId?: string) {
    const subscription = await this.getCurrentRecord(businessAccountId);
    const usage = subscription.usageRecords[0];
    const limitKey = PLAN_LIMIT_KEYS[usageKey];
    const maximum = subscription.plan[limitKey] as number | null;
    const current = usage?.[usageKey] ?? 0;
    if (maximum === null || current < maximum) return true;

    const nextPlan = recommendedPlan(subscription.plan.code);
    const planName = subscription.plan.name;
    const message = usageKey === "businessesCount"
      ? `Your ${planName} plan allows ${maximum === 1 ? "1 business" : `up to ${maximum} businesses`}. Upgrade to ${nextPlan === PlanCode.PLUS ? "Plus" : "Premium"} to ${maximum === 1 ? "create more businesses" : "add more"}.`
      : `${planName} allows up to ${maximum} ${USAGE_LABELS[usageKey]}. Upgrade to ${nextPlan === PlanCode.PLUS ? "Plus" : "Premium"} to ${LIMIT_ACTIONS[usageKey]}.`;
    const metadata: Prisma.InputJsonValue = { usageKey, current, maximum, currentPlan: subscription.plan.code, recommendedPlan: nextPlan, businessAccountId };
    await Promise.all([
      auditService.log({ action: AuditAction.PLAN_LIMIT_REACHED, businessId, metadata }),
      auditService.log({ action: AuditAction.PLAN_UPGRADE_REQUIRED, businessId, metadata }),
    ]);
    throw new AppError(403, message, "PLAN_LIMIT_REACHED", {
      currentPlan: subscription.plan.code,
      recommendedPlan: nextPlan,
      limit: maximum,
      current,
    });
  },

  async assertPreparedLimit(businessAccountId: string, usageKey: "conversationsUsed" | "aiRepliesUsed") {
    const subscription = await this.getCurrentRecord(businessAccountId);
    const usage = subscription.usageRecords[0];
    const limit = usageKey === "conversationsUsed" ? subscription.plan.maxConversationsPerMonth : subscription.plan.maxAiRepliesPerMonth;
    return { allowed: limit === null || (usage?.[usageKey] ?? 0) < limit, current: usage?.[usageKey] ?? 0, limit };
  },

  async assertFeatureAllowed(businessAccountId: string, featureKey: FeatureKey, businessId?: string) {
    const subscription = await this.getCurrentRecord(businessAccountId);
    if (subscription.plan[featureKey]) return true;
    const nextPlan = recommendedPlanForFeature(featureKey);
    await auditService.log({
      action: AuditAction.PLAN_UPGRADE_REQUIRED,
      businessId,
      metadata: { featureKey, currentPlan: subscription.plan.code, recommendedPlan: nextPlan, businessAccountId },
    });
    throw new AppError(403, `${featureKey} is not available on your current plan. Upgrade to ${nextPlan === PlanCode.PLUS ? "Plus" : "Premium"} to unlock it.`, "PLAN_UPGRADE_REQUIRED", {
      currentPlan: subscription.plan.code,
      recommendedPlan: nextPlan,
      featureKey,
    });
  },

  async updateAccountUsage(businessAccountId: string, usageKey: AccountUsageKey, delta: number, businessId?: string) {
    if (!Number.isInteger(delta) || delta === 0) throw new AppError(400, "Usage delta must be a non-zero integer", "INVALID_USAGE_DELTA");
    const subscription = await this.getCurrentRecord(businessAccountId);
    const usage = subscription.usageRecords[0];
    if (!usage) throw new AppError(500, "Current account usage record is unavailable");
    const current = usage[usageKey];
    const updated = await prisma.accountUsageRecord.update({
      where: { id: usage.id },
      data: { [usageKey]: delta > 0 ? { increment: delta } : Math.max(0, current + delta) },
    });
    await auditService.log({
      action: AuditAction.USAGE_RECORD_UPDATED,
      businessId,
      metadata: { businessAccountId, usageKey, previousValue: current, currentValue: updated[usageKey], delta },
    });
    return updated;
  },

  async updateBusinessUsage(businessId: string, usageKey: BusinessUsageKey, delta: number) {
    if (!Number.isInteger(delta) || delta === 0) throw new AppError(400, "Usage delta must be a non-zero integer", "INVALID_USAGE_DELTA");
    const usage = await prisma.businessUsageRecord.findFirst({ where: { businessId }, orderBy: { periodStart: "desc" } });
    if (!usage) throw new AppError(500, "Current business usage record is unavailable");
    return prisma.businessUsageRecord.update({
      where: { id: usage.id },
      data: { [usageKey]: delta > 0 ? { increment: delta } : Math.max(0, usage[usageKey] + delta) },
    });
  },
};

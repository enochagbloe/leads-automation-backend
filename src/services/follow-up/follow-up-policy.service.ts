import { FollowUpRuleType, PlanCode, SubscriptionStatus } from "@prisma/client";
import { AppError } from "../../utils/errors";
import { subscriptionService } from "../subscription.service";
import { FollowUpActor } from "./follow-up.types";

export function planRank(plan: PlanCode) {
  if (plan === PlanCode.PREMIUM) return 3;
  if (plan === PlanCode.PLUS) return 2;
  return 1;
}

export function defaultMonthlyLimit(plan: PlanCode) {
  if (plan === PlanCode.PREMIUM) return 2_000;
  if (plan === PlanCode.PLUS) return 500;
  return 50;
}

export function ruleTypesForPlan(plan: PlanCode): FollowUpRuleType[] {
  const basic = [FollowUpRuleType.NO_RESPONSE_AFTER_MESSAGE, FollowUpRuleType.CONTACT_EMAIL_REQUEST, FollowUpRuleType.BEFORE_APPOINTMENT];
  if (plan === PlanCode.BASIC) return basic;
  const plus = [...basic, FollowUpRuleType.AFTER_APPOINTMENT, FollowUpRuleType.STALE_LEAD];
  if (plan === PlanCode.PLUS) return plus;
  return [...plus, FollowUpRuleType.AFTER_QUOTE_SENT];
}

export function requiredPlanForRuleType(type: FollowUpRuleType): PlanCode {
  if (type === FollowUpRuleType.AFTER_QUOTE_SENT) return PlanCode.PREMIUM;
  if (type === FollowUpRuleType.AFTER_APPOINTMENT || type === FollowUpRuleType.STALE_LEAD) return PlanCode.PLUS;
  return PlanCode.BASIC;
}

export function maxAttemptsForRule(plan: PlanCode, _type: FollowUpRuleType) {
  if (plan === PlanCode.PREMIUM) return 3;
  if (plan === PlanCode.PLUS) return 2;
  return 1;
}

export type FollowUpPlanPolicy = Awaited<ReturnType<typeof followUpPlanPolicyService.policy>>;

export function assertFollowUpRuleSettingsWithinPolicy(policy: FollowUpPlanPolicy, input: {
  type: FollowUpRuleType;
  useAiRewrite: boolean;
  maxSendsPerLead: number;
  maxSendsPerConversation: number;
}) {
  if (input.useAiRewrite && !policy.aiRewriteAllowed) {
    throw new AppError(403, "AI rewrite is not available on your current plan.", "PLAN_UPGRADE_REQUIRED", {
      currentPlan: policy.plan,
      requiredPlan: PlanCode.PLUS,
      feature: "follow_up_ai_rewrite",
    });
  }
  const maximumAttempts = maxAttemptsForRule(policy.plan, input.type);
  if (
    input.maxSendsPerLead > maximumAttempts
    || input.maxSendsPerConversation > maximumAttempts
  ) {
    throw new AppError(
      403,
      `This follow-up rule supports at most ${maximumAttempts} automated ${maximumAttempts === 1 ? "attempt" : "attempts"} on your current plan.`,
      "PLAN_LIMIT_REACHED",
      {
        currentPlan: policy.plan,
        ruleType: input.type,
        limit: maximumAttempts,
        attemptedPerLead: input.maxSendsPerLead,
        attemptedPerConversation: input.maxSendsPerConversation,
      },
    );
  }
  if (input.maxSendsPerLead > policy.maxSendsPerLead) {
    throw new AppError(403, "Max sends per lead exceeds your plan limit.", "PLAN_LIMIT_REACHED", {
      currentUsage: input.maxSendsPerLead,
      limit: policy.maxSendsPerLead,
      attemptedAmount: input.maxSendsPerLead,
    });
  }
  if (input.maxSendsPerConversation > policy.maxSendsPerConversation) {
    throw new AppError(403, "Max sends per conversation exceeds your plan limit.", "PLAN_LIMIT_REACHED", {
      currentUsage: input.maxSendsPerConversation,
      limit: policy.maxSendsPerConversation,
      attemptedAmount: input.maxSendsPerConversation,
    });
  }
}

export const followUpPlanPolicyService = {
  async policy(actor: FollowUpActor) {
    const subscription = await subscriptionService.getCurrentRecord(actor.businessAccountId);
    return {
      plan: subscription.plan.code,
      monthlyLimit: defaultMonthlyLimit(subscription.plan.code),
      allowedRuleTypes: ruleTypesForPlan(subscription.plan.code),
      maxSendsPerConversation: subscription.plan.code === PlanCode.BASIC ? 1 : subscription.plan.code === PlanCode.PLUS ? 3 : 5,
      maxSendsPerLead: subscription.plan.code === PlanCode.BASIC ? 2 : subscription.plan.code === PlanCode.PLUS ? 8 : 20,
      aiRewriteAllowed: subscription.plan.code !== PlanCode.BASIC,
      subscription,
    };
  },

  async assertRuleAllowed(actor: FollowUpActor, rule: { type: FollowUpRuleType }) {
    const policy = await this.policy(actor);
    const requiredPlan = requiredPlanForRuleType(rule.type);
    if (rule.type === FollowUpRuleType.AFTER_QUOTE_SENT) {
      throw new AppError(422, "Quote/payment follow-up requires the quote/payment request module.", "FOLLOW_UP_DEPENDENCY_NOT_READY", {
        currentPlan: policy.plan,
        requiredPlan,
        ruleType: rule.type,
      });
    }
    if (policy.subscription.status !== SubscriptionStatus.ACTIVE && policy.subscription.status !== SubscriptionStatus.TRIALING) {
      throw new AppError(403, "Subscription is inactive.", "SUBSCRIPTION_INACTIVE");
    }
    if (planRank(policy.plan) < planRank(requiredPlan) || !policy.allowedRuleTypes.includes(rule.type)) {
      throw new AppError(403, "Upgrade your plan to use this follow-up rule.", "PLAN_UPGRADE_REQUIRED", {
        currentPlan: policy.plan,
        requiredPlan,
        ruleType: rule.type,
      });
    }
    return policy;
  },
};

import {
  AppointmentStatus,
  BusinessStatus,
  ConversationStatus,
  CustomerIssueStatus,
  FollowUpJobStatus,
  FollowUpRuleType,
  FollowUpSendLogDeliveryStatus,
  LeadStatus,
  PlanCode,
  SubscriptionStatus,
} from "@prisma/client";
import { prisma } from "../../config/prisma";
import { defaultMonthlyLimit, planRank, requiredPlanForRuleType, ruleTypesForPlan } from "./follow-up-policy.service";
import { FOLLOW_UP_MONTHLY_LIMIT_DELIVERY_STATUSES } from "./follow-up.shared";

export const followUpEligibilityService = {
  async checkJob(jobId: string) {
    const job = await prisma.followUpJob.findUnique({ where: { id: jobId }, include: { rule: true, business: true, lead: true, conversation: true, appointment: true } });
    if (!job) return { eligible: false, action: "CANCEL" as const, reason: "FOLLOW_UP_JOB_NOT_FOUND" };
    if (job.status !== FollowUpJobStatus.SCHEDULED && job.status !== FollowUpJobStatus.PROCESSING) return { eligible: false, action: "CANCEL" as const, reason: "FOLLOW_UP_JOB_NOT_SCHEDULED" };
    if (!job.rule.enabled || job.rule.deletedAt) return { eligible: false, action: "SKIP" as const, reason: "FOLLOW_UP_RULE_DISABLED" };
    if (!job.business.followUpAutomationEnabled) return { eligible: false, action: "CANCEL" as const, reason: "FOLLOW_UP_AUTOMATION_DISABLED" };
    if (job.business.status !== BusinessStatus.ACTIVE || job.business.deletedAt) return { eligible: false, action: "SKIP" as const, reason: "BUSINESS_INACTIVE" };
    if (job.lead?.whatsAppOptedOut) return { eligible: false, action: "CANCEL" as const, reason: "CUSTOMER_OPTED_OUT" };
    if (job.rule.type === FollowUpRuleType.AFTER_QUOTE_SENT) return { eligible: false, action: "SKIP" as const, reason: "FOLLOW_UP_DEPENDENCY_NOT_READY" };
    if (job.rule.type === FollowUpRuleType.BEFORE_APPOINTMENT && (!job.appointment || job.appointment.startTime <= new Date())) {
      return { eligible: false, action: "CANCEL" as const, reason: "APPOINTMENT_ALREADY_STARTED" };
    }
    if (job.rule.type === FollowUpRuleType.CONTACT_EMAIL_REQUEST && job.lead?.email) {
      return { eligible: false, action: "CANCEL" as const, reason: "CUSTOMER_EMAIL_ALREADY_AVAILABLE" };
    }
    if (job.rule.type === FollowUpRuleType.AFTER_APPOINTMENT && (!job.appointment || job.appointment.status !== AppointmentStatus.COMPLETED)) {
      return { eligible: false, action: "CANCEL" as const, reason: "APPOINTMENT_NOT_COMPLETED" };
    }

    const subscription = await prisma.subscription.findFirst({
      where: { businessAccountId: job.business.businessAccountId, status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING] } },
      include: { plan: true },
      orderBy: { createdAt: "desc" },
    });
    if (!subscription) return { eligible: false, action: "SKIP" as const, reason: "SUBSCRIPTION_INACTIVE" };
    const requiredPlan = requiredPlanForRuleType(job.rule.type);
    if (planRank(subscription.plan.code) < planRank(requiredPlan) || !ruleTypesForPlan(subscription.plan.code).includes(job.rule.type)) {
      return { eligible: false, action: "SKIP" as const, reason: "PLAN_UPGRADE_REQUIRED" };
    }

    const monthlySends = await prisma.followUpSendLog.count({
      where: {
        business: { businessAccountId: job.business.businessAccountId },
        deliveryStatus: { in: [...FOLLOW_UP_MONTHLY_LIMIT_DELIVERY_STATUSES] },
        createdAt: { gte: subscription.currentPeriodStart, lt: subscription.currentPeriodEnd },
      },
    });
    if (monthlySends >= defaultMonthlyLimit(subscription.plan.code)) return { eligible: false, action: "SKIP" as const, reason: "FOLLOW_UP_MONTHLY_LIMIT_REACHED" };
    if (job.conversation && (
      job.conversation.status === ConversationStatus.CLOSED
      || job.conversation.status === ConversationStatus.PLAN_LIMIT_BLOCKED
      || job.conversation.needsHumanReview
      || job.conversation.humanTakeover
    )) return { eligible: false, action: "CANCEL" as const, reason: "CONVERSATION_NOT_ELIGIBLE" };
    if (job.lead && (job.lead.status === LeadStatus.WON || job.lead.status === LeadStatus.LOST)) return { eligible: false, action: "CANCEL" as const, reason: "LEAD_CLOSED" };
    if (job.appointment && (
      job.appointment.status === AppointmentStatus.CANCELLED
      || job.appointment.status === AppointmentStatus.NO_SHOW
      || job.appointment.status === AppointmentStatus.MISSED
    )) return { eligible: false, action: "CANCEL" as const, reason: "APPOINTMENT_NOT_ELIGIBLE" };

    if (job.conversationId || job.leadId) {
      const openIssue = await prisma.customerIssueLog.findFirst({
        where: {
          businessId: job.businessId,
          OR: [
            ...(job.conversationId ? [{ conversationId: job.conversationId }] : []),
            ...(job.leadId ? [{ leadId: job.leadId }] : []),
          ],
          status: { in: [CustomerIssueStatus.OPEN, CustomerIssueStatus.ACKNOWLEDGED, CustomerIssueStatus.REOPENED] },
        },
        select: { id: true },
      });
      if (openIssue) return { eligible: false, action: "CANCEL" as const, reason: "UNRESOLVED_CUSTOMER_ISSUE" };
    }

    const [leadSends, conversationSends] = await Promise.all([
      job.leadId ? prisma.followUpSendLog.count({ where: { businessId: job.businessId, ruleId: job.ruleId, leadId: job.leadId, deliveryStatus: FollowUpSendLogDeliveryStatus.SENT } }) : Promise.resolve(0),
      job.conversationId ? prisma.followUpSendLog.count({ where: { businessId: job.businessId, ruleId: job.ruleId, conversationId: job.conversationId, deliveryStatus: FollowUpSendLogDeliveryStatus.SENT } }) : Promise.resolve(0),
    ]);
    const maxSendsPerLead = subscription.plan.code === PlanCode.PREMIUM && job.rule.type === FollowUpRuleType.NO_RESPONSE_AFTER_MESSAGE
      ? Math.max(job.rule.maxSendsPerLead, 3)
      : job.rule.maxSendsPerLead;
    const maxSendsPerConversation = subscription.plan.code === PlanCode.PREMIUM && job.rule.type === FollowUpRuleType.NO_RESPONSE_AFTER_MESSAGE
      ? Math.max(job.rule.maxSendsPerConversation, 3)
      : job.rule.maxSendsPerConversation;
    if (leadSends >= maxSendsPerLead) return { eligible: false, action: "SKIP" as const, reason: "MAX_SENDS_PER_LEAD_REACHED" };
    if (conversationSends >= maxSendsPerConversation) return { eligible: false, action: "SKIP" as const, reason: "MAX_SENDS_PER_CONVERSATION_REACHED" };
    return { eligible: true, action: "SEND" as const };
  },
};

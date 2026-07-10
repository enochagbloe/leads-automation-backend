import {
  AppointmentStatus,
  AuditAction,
  BusinessStatus,
  ConversationStatus,
  CustomerIssueStatus,
  FollowUpContextType,
  FollowUpJobStatus,
  FollowUpRuleType,
  FollowUpSendLogDeliveryStatus,
  LeadStatus,
  MessageDeliveryStatus,
  Prisma,
  SubscriptionStatus,
} from "@prisma/client";
import { prisma } from "../../config/prisma";
import { auditService } from "../audit.service";
import { realtimeService } from "../realtime.service";
import {
  FOLLOW_UP_MONTHLY_LIMIT_DELIVERY_STATUSES,
  followUpJobDedupeKey,
  jobInclude,
  json,
} from "./follow-up.shared";
import { ruleTypesForPlan } from "./follow-up-policy.service";

type BasicFollowUpScheduleInput = {
  businessId: string;
  type: FollowUpRuleType;
  contextType: FollowUpContextType;
  leadId: string | null;
  conversationId: string | null;
  appointmentId?: string | null;
  relatedMessageId?: string | null;
  scheduledFor?: Date;
  pendingQuestion: string;
  expectedResponseType: string;
  replaceScheduledNoResponse?: boolean;
};

function scheduledAuditAction(type: FollowUpRuleType) {
  if (type === FollowUpRuleType.CONTACT_EMAIL_REQUEST) return AuditAction.BASIC_CONTACT_EMAIL_REQUEST_SCHEDULED;
  if (type === FollowUpRuleType.BEFORE_APPOINTMENT) return AuditAction.BASIC_APPOINTMENT_REMINDER_SCHEDULED;
  if (type === FollowUpRuleType.NO_RESPONSE_AFTER_MESSAGE) return AuditAction.BASIC_NO_RESPONSE_FOLLOW_UP_SCHEDULED;
  return AuditAction.FOLLOW_UP_JOB_SCHEDULED;
}

function scheduledUsageEvent(type: FollowUpRuleType) {
  if (type === FollowUpRuleType.NO_RESPONSE_AFTER_MESSAGE) return "PLUS_FOLLOW_UP_NO_RESPONSE_SCHEDULED";
  if (type === FollowUpRuleType.AFTER_APPOINTMENT) return "PLUS_POST_APPOINTMENT_FOLLOW_UP_SCHEDULED";
  if (type === FollowUpRuleType.STALE_LEAD) return "PLUS_STALE_LEAD_FOLLOW_UP_SCHEDULED";
  return "FOLLOW_UP_JOB_SCHEDULED";
}

function scheduledEventType(type: FollowUpRuleType) {
  if (type === FollowUpRuleType.CONTACT_EMAIL_REQUEST) return "business.follow_up.basic.contact_email.scheduled" as const;
  if (type === FollowUpRuleType.BEFORE_APPOINTMENT) return "business.follow_up.basic.appointment_reminder.scheduled" as const;
  if (type === FollowUpRuleType.NO_RESPONSE_AFTER_MESSAGE) return "business.follow_up.basic.no_response.scheduled" as const;
  return "business.follow_up.job.scheduled" as const;
}

export async function scheduleFollowUpAutomationJob(input: BasicFollowUpScheduleInput) {
  const result = await prisma.$transaction(async (tx) => {
    const business = await tx.business.findUnique({
      where: { id: input.businessId },
      select: { id: true, businessAccountId: true, followUpAutomationEnabled: true, status: true, deletedAt: true },
    });
    if (!business || business.deletedAt || business.status !== BusinessStatus.ACTIVE) return { scheduled: false, reason: "BUSINESS_INACTIVE" as const };
    if (!business.followUpAutomationEnabled) return { scheduled: false, reason: "FOLLOW_UP_AUTOMATION_DISABLED" as const };

    const subscription = await tx.subscription.findFirst({
      where: { businessAccountId: business.businessAccountId, status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING] } },
      include: { plan: true },
      orderBy: { createdAt: "desc" },
    });
    if (!subscription) return { scheduled: false, reason: "SUBSCRIPTION_INACTIVE" as const };
    if (input.type === FollowUpRuleType.AFTER_QUOTE_SENT) return { scheduled: false, reason: "FOLLOW_UP_DEPENDENCY_NOT_READY" as const };
    if (!ruleTypesForPlan(subscription.plan.code).includes(input.type)) return { scheduled: false, reason: "PLAN_UPGRADE_REQUIRED" as const };

    const rule = await tx.followUpAutomationRule.findFirst({
      where: { businessId: input.businessId, type: input.type, enabled: true, deletedAt: null },
    });
    if (!rule) return { scheduled: false, reason: "FOLLOW_UP_RULE_DISABLED" as const };

    const [lead, conversation, appointment] = await Promise.all([
      input.leadId ? tx.lead.findFirst({ where: { id: input.leadId, businessId: input.businessId, deletedAt: null }, select: { id: true, status: true, email: true } }) : Promise.resolve(null),
      input.conversationId ? tx.conversation.findFirst({
        where: { id: input.conversationId, businessId: input.businessId, deletedAt: null },
        select: { id: true, leadId: true, status: true, needsHumanReview: true, humanTakeover: true, assignedStaffId: true },
      }) : Promise.resolve(null),
      input.appointmentId ? tx.appointment.findFirst({
        where: { id: input.appointmentId, businessId: input.businessId },
        select: { id: true, status: true, startTime: true, leadId: true, conversationId: true },
      }) : Promise.resolve(null),
    ]);

    if (input.leadId && !lead) return { scheduled: false, reason: "LEAD_NOT_FOUND" as const };
    if (input.conversationId && !conversation) return { scheduled: false, reason: "CONVERSATION_NOT_FOUND" as const };
    if (input.appointmentId && !appointment) return { scheduled: false, reason: "APPOINTMENT_NOT_FOUND" as const };
    if (lead && (lead.status === LeadStatus.WON || lead.status === LeadStatus.LOST)) return { scheduled: false, reason: "LEAD_CLOSED" as const };
    if (conversation && (
      conversation.status === ConversationStatus.CLOSED
      || conversation.status === ConversationStatus.PLAN_LIMIT_BLOCKED
      || conversation.needsHumanReview
      || conversation.humanTakeover
    )) return { scheduled: false, reason: "CONVERSATION_NOT_ELIGIBLE" as const };

    if (input.conversationId || input.leadId) {
      const openIssue = await tx.customerIssueLog.findFirst({
        where: {
          businessId: input.businessId,
          OR: [
            ...(input.conversationId ? [{ conversationId: input.conversationId }] : []),
            ...(input.leadId ? [{ leadId: input.leadId }] : []),
          ],
          status: { in: [CustomerIssueStatus.OPEN, CustomerIssueStatus.ACKNOWLEDGED, CustomerIssueStatus.REOPENED] },
        },
        select: { id: true },
      });
      if (openIssue) return { scheduled: false, reason: "UNRESOLVED_CUSTOMER_ISSUE" as const };
    }

    if (input.type === FollowUpRuleType.CONTACT_EMAIL_REQUEST) {
      if (!lead || lead.email) return { scheduled: false, reason: "CUSTOMER_EMAIL_ALREADY_AVAILABLE" as const };
      const existingContactRequest = await tx.followUpSendLog.findFirst({
        where: {
          businessId: input.businessId,
          ruleId: rule.id,
          deliveryStatus: { in: [...FOLLOW_UP_MONTHLY_LIMIT_DELIVERY_STATUSES] },
          OR: [
            ...(input.leadId ? [{ leadId: input.leadId }] : []),
            ...(input.conversationId ? [{ conversationId: input.conversationId }] : []),
          ],
        },
        select: { id: true },
      });
      if (existingContactRequest) return { scheduled: false, reason: "CONTACT_EMAIL_REQUEST_ALREADY_SENT" as const };
    }

    if (input.type === FollowUpRuleType.BEFORE_APPOINTMENT) {
      if (!appointment || (appointment.status !== AppointmentStatus.CONFIRMED && appointment.status !== AppointmentStatus.RESCHEDULED)) return { scheduled: false, reason: "APPOINTMENT_NOT_CONFIRMED" as const };
      if (appointment.startTime <= new Date()) return { scheduled: false, reason: "APPOINTMENT_ALREADY_STARTED" as const };
    }

    if (input.type === FollowUpRuleType.AFTER_APPOINTMENT) {
      if (!appointment || appointment.status !== AppointmentStatus.COMPLETED) return { scheduled: false, reason: "APPOINTMENT_NOT_COMPLETED" as const };
    }

    if (input.type === FollowUpRuleType.STALE_LEAD) {
      if (!lead) return { scheduled: false, reason: "LEAD_NOT_FOUND" as const };
    }

    const [leadSends, conversationSends] = await Promise.all([
      input.leadId ? tx.followUpSendLog.count({ where: { businessId: input.businessId, ruleId: rule.id, leadId: input.leadId, deliveryStatus: FollowUpSendLogDeliveryStatus.SENT } }) : Promise.resolve(0),
      input.conversationId ? tx.followUpSendLog.count({ where: { businessId: input.businessId, ruleId: rule.id, conversationId: input.conversationId, deliveryStatus: FollowUpSendLogDeliveryStatus.SENT } }) : Promise.resolve(0),
    ]);
    if (input.leadId && leadSends >= rule.maxSendsPerLead) return { scheduled: false, reason: "MAX_SENDS_PER_LEAD_REACHED" as const };
    if (input.conversationId && conversationSends >= rule.maxSendsPerConversation) return { scheduled: false, reason: "MAX_SENDS_PER_CONVERSATION_REACHED" as const };

    if (input.replaceScheduledNoResponse && input.conversationId) {
      await tx.followUpJob.updateMany({
        where: {
          businessId: input.businessId,
          ruleId: rule.id,
          conversationId: input.conversationId,
          contextType: FollowUpContextType.GENERAL_NO_RESPONSE,
          status: FollowUpJobStatus.SCHEDULED,
        },
        data: { status: FollowUpJobStatus.CANCELLED, cancelReason: "REPLACED_BY_NEW_OUTBOUND_MESSAGE" },
      });
    }

    const scheduledFor = input.scheduledFor ?? new Date(Date.now() + rule.delayMinutes * 60_000);
    const dedupeKey = followUpJobDedupeKey({
      businessId: input.businessId,
      ruleId: rule.id,
      contextType: input.contextType,
      leadId: input.leadId,
      conversationId: input.conversationId,
      appointmentId: input.appointmentId ?? null,
      relatedMessageId: input.relatedMessageId ?? null,
    });
    const duplicate = await tx.followUpJob.findFirst({
      where: { businessId: input.businessId, dedupeKey, status: FollowUpJobStatus.SCHEDULED },
      select: { id: true },
    });
    if (duplicate) return { scheduled: false, reason: "FOLLOW_UP_DUPLICATE_JOB" as const, jobId: duplicate.id };

    const job = await tx.followUpJob.create({
      data: {
        businessId: input.businessId,
        ruleId: rule.id,
        leadId: input.leadId,
        conversationId: input.conversationId,
        appointmentId: input.appointmentId ?? null,
        contextType: input.contextType,
        dedupeKey,
        pendingQuestion: input.pendingQuestion,
        expectedResponseType: input.expectedResponseType,
        relatedMessageId: input.relatedMessageId ?? null,
        scheduledFor,
      },
      include: jobInclude,
    });
    return { scheduled: true as const, job, rule };
  }).catch((error: unknown) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { scheduled: false as const, reason: "FOLLOW_UP_DUPLICATE_JOB" as const };
    }
    throw error;
  });

  if (result.scheduled && result.rule && result.job) {
    await auditService.log({
      action: scheduledAuditAction(result.rule.type),
      businessId: input.businessId,
      metadata: json({
        usageEvent: scheduledUsageEvent(result.rule.type),
        ruleId: result.rule.id,
        jobId: result.job.id,
        leadId: result.job.leadId,
        conversationId: result.job.conversationId,
        appointmentId: result.job.appointmentId,
        contextType: result.job.contextType,
      }),
    });
    realtimeService.publish({
      type: scheduledEventType(result.rule.type),
      businessId: input.businessId,
      conversationId: result.job.conversationId ?? undefined,
      leadId: result.job.leadId ?? undefined,
      payload: { job: result.job },
      broadcastToStaff: true,
    });
  }
  return result;
}

export const followUpBasicService = {
  async scheduleNoResponseAfterOutboundMessage(input: {
    businessId: string;
    leadId: string;
    conversationId: string;
    messageId: string;
    messageCreatedAt: Date;
    deliveryStatus: MessageDeliveryStatus;
  }) {
    if (input.deliveryStatus === MessageDeliveryStatus.FAILED || input.deliveryStatus === MessageDeliveryStatus.INTERNAL) {
      return { scheduled: false, reason: "MESSAGE_NOT_CUSTOMER_FACING" as const };
    }
    const rule = await prisma.followUpAutomationRule.findFirst({
      where: { businessId: input.businessId, type: FollowUpRuleType.NO_RESPONSE_AFTER_MESSAGE, enabled: true, deletedAt: null },
      select: { delayMinutes: true },
    });
    return scheduleFollowUpAutomationJob({
      businessId: input.businessId,
      type: FollowUpRuleType.NO_RESPONSE_AFTER_MESSAGE,
      contextType: FollowUpContextType.GENERAL_NO_RESPONSE,
      leadId: input.leadId,
      conversationId: input.conversationId,
      relatedMessageId: input.messageId,
      scheduledFor: new Date(input.messageCreatedAt.getTime() + (rule?.delayMinutes ?? 1440) * 60_000),
      pendingQuestion: "Customer has not responded to the last message.",
      expectedResponseType: "CUSTOMER_REPLY",
      replaceScheduledNoResponse: true,
    });
  },

  async scheduleContactEmailRequestForAppointment(appointment: {
    businessId: string;
    leadId: string | null;
    conversationId: string | null;
  }) {
    if (!appointment.leadId) return { scheduled: false, reason: "LEAD_NOT_FOUND" as const };
    const rule = await prisma.followUpAutomationRule.findFirst({
      where: { businessId: appointment.businessId, type: FollowUpRuleType.CONTACT_EMAIL_REQUEST, enabled: true, deletedAt: null },
      select: { delayMinutes: true },
    });
    return scheduleFollowUpAutomationJob({
      businessId: appointment.businessId,
      type: FollowUpRuleType.CONTACT_EMAIL_REQUEST,
      contextType: FollowUpContextType.CONTACT_EMAIL_REQUEST,
      leadId: appointment.leadId,
      conversationId: appointment.conversationId,
      scheduledFor: new Date(Date.now() + (rule?.delayMinutes ?? 0) * 60_000),
      pendingQuestion: "Customer may share email for booking details or formal documents.",
      expectedResponseType: "EMAIL",
    });
  },

  async scheduleAppointmentReminder(appointment: {
    businessId: string;
    id: string;
    leadId: string | null;
    conversationId: string | null;
    status: AppointmentStatus;
    startTime: Date;
  }) {
    if ((appointment.status !== AppointmentStatus.CONFIRMED && appointment.status !== AppointmentStatus.RESCHEDULED) || !appointment.leadId) return { scheduled: false, reason: "APPOINTMENT_NOT_CONFIRMED" as const };
    const rule = await prisma.followUpAutomationRule.findFirst({
      where: { businessId: appointment.businessId, type: FollowUpRuleType.BEFORE_APPOINTMENT, enabled: true, deletedAt: null },
      select: { delayMinutes: true },
    });
    const now = new Date();
    const primary = new Date(appointment.startTime.getTime() - (rule?.delayMinutes ?? 1440) * 60_000);
    const fallback = new Date(appointment.startTime.getTime() - 2 * 60 * 60 * 1000);
    const scheduledFor = primary > now ? primary : fallback > now ? fallback : null;
    if (!scheduledFor) {
      await auditService.log({
        action: AuditAction.FOLLOW_UP_JOB_SKIPPED,
        businessId: appointment.businessId,
        metadata: json({ appointmentId: appointment.id, reason: "APPOINTMENT_TOO_SOON_FOR_REMINDER" }),
      });
      return { scheduled: false, reason: "APPOINTMENT_TOO_SOON_FOR_REMINDER" as const };
    }
    return scheduleFollowUpAutomationJob({
      businessId: appointment.businessId,
      type: FollowUpRuleType.BEFORE_APPOINTMENT,
      contextType: FollowUpContextType.APPOINTMENT_CONFIRMATION,
      leadId: appointment.leadId,
      conversationId: appointment.conversationId,
      appointmentId: appointment.id,
      scheduledFor,
      pendingQuestion: "Customer should be reminded of upcoming appointment.",
      expectedResponseType: "APPOINTMENT_ACKNOWLEDGEMENT",
    });
  },
};
